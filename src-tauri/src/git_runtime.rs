use std::path::Path;

use serde::Serialize;
use tauri::State;
use tokio::process::Command;

use crate::workspace_access::WorkspaceRegistry;

#[path = "git_runtime_worktrees.rs"]
mod git_runtime_worktrees;

#[cfg(test)]
pub(crate) use git_runtime_worktrees::parse_worktrees;
pub use git_runtime_worktrees::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    path: String,
    status: String,
    staged: bool,
    additions: usize,
    deletions: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    path: String,
    content: String,
    binary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    name: String,
    current: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    path: String,
    branch: Option<String>,
    head: Option<String>,
    bare: bool,
    detached: bool,
}

async fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| format!("Failed to start git: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn run_git_dynamic(cwd: &Path, args: &[String]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| format!("Failed to start git: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn run_git_diff(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| format!("Failed to start git: {error}"))?;

    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

async fn untracked_diff(cwd: &Path, path: &str) -> Result<String, String> {
    run_git_diff(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-index",
            "--",
            null_device(),
            path,
        ],
    )
    .await
}

async fn untracked_numstat(cwd: &Path, path: &str) -> Result<(usize, usize), String> {
    let output = run_git_diff(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-index",
            "--numstat",
            "--",
            null_device(),
            path,
        ],
    )
    .await?;
    parse_numstat_line(&output).ok_or_else(|| format!("git diff returned no line stats for {path}"))
}

fn parse_numstat(output: &str) -> std::collections::HashMap<String, (usize, usize)> {
    let records = if output.contains('\0') {
        output.split('\0').collect::<Vec<_>>()
    } else {
        output.lines().collect::<Vec<_>>()
    };
    records
        .into_iter()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let additions = parts.next()?.parse().unwrap_or(0);
            let deletions = parts.next()?.parse().unwrap_or(0);
            let path = parts.next()?.to_string();
            (!path.is_empty()).then_some((path, (additions, deletions)))
        })
        .collect()
}

fn parse_porcelain_status(output: &str) -> Vec<(char, char, String)> {
    let mut records = output
        .split('\0')
        .filter(|record| !record.is_empty())
        .peekable();
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let bytes = record.as_bytes();
        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let mut path = record[3..].to_string();
        if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            if let Some(destination) = records.next() {
                path = destination.to_string();
            }
        }
        changes.push((index, worktree, path));
    }
    changes
}

fn validate_relative_git_path(path: &str) -> Result<(), String> {
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Git path must stay inside the selected workspace".to_string());
    }
    Ok(())
}

fn parse_numstat_line(output: &str) -> Option<(usize, usize)> {
    output.lines().find_map(|line| {
        let mut parts = line.splitn(3, '\t');
        let additions = parts.next()?.parse().unwrap_or(0);
        let deletions = parts.next()?.parse().unwrap_or(0);
        parts.next()?;
        Some((additions, deletions))
    })
}

#[tauri::command]
pub async fn git_changes(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<GitChange>, String> {
    let cwd = registry.authorize(&cwd)?;
    git_changes_at(&cwd).await
}

async fn git_changes_at(cwd: &Path) -> Result<Vec<GitChange>, String> {
    let status = run_git(cwd, &["status", "--porcelain=v1", "-z", "-uall"]).await?;
    let unstaged_stats = run_git(cwd, &["diff", "--numstat", "-z", "--no-renames"]).await?;
    let staged_stats = run_git(
        cwd,
        &["diff", "--cached", "--numstat", "-z", "--no-renames"],
    )
    .await?;
    let unstaged_stats = parse_numstat(&unstaged_stats);
    let staged_stats = parse_numstat(&staged_stats);

    let mut changes = Vec::new();
    for (index, worktree, path) in parse_porcelain_status(&status) {
        let staged = index != ' ' && index != '?';
        let (additions, deletions) = if index == '?' && worktree == '?' {
            untracked_numstat(cwd, &path).await?
        } else {
            unstaged_stats.get(&path).copied().unwrap_or_default()
        };
        let (staged_additions, staged_deletions) =
            staged_stats.get(&path).copied().unwrap_or_default();

        changes.push(GitChange {
            path,
            status: format!("{index}{worktree}"),
            staged,
            additions: additions + staged_additions,
            deletions: deletions + staged_deletions,
        });
    }

    Ok(changes)
}

#[tauri::command]
pub async fn git_diff(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    path: String,
) -> Result<GitDiff, String> {
    let cwd = registry.authorize(&cwd)?;
    git_diff_at(&cwd, &path).await
}

async fn git_diff_at(cwd: &Path, path: &str) -> Result<GitDiff, String> {
    validate_relative_git_path(path)?;
    let status = run_git(
        cwd,
        &["status", "--porcelain=v1", "-z", "-uall", "--", path],
    )
    .await?;
    let is_untracked = parse_porcelain_status(&status)
        .iter()
        .any(|(index, worktree, _)| *index == '?' && *worktree == '?');
    let content = if is_untracked {
        untracked_diff(cwd, path).await?
    } else {
        let unstaged = run_git(cwd, &["diff", "--no-ext-diff", "--", path]).await?;
        let staged = run_git(cwd, &["diff", "--cached", "--no-ext-diff", "--", path]).await?;
        if staged.is_empty() {
            unstaged
        } else if unstaged.is_empty() {
            staged
        } else {
            format!("{staged}\n{unstaged}")
        }
    };
    let binary = content
        .lines()
        .any(|line| line.starts_with("Binary files "));

    Ok(GitDiff {
        path: path.to_string(),
        content,
        binary,
    })
}

#[tauri::command]
pub async fn git_branches(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<GitBranch>, String> {
    let cwd = registry.authorize(&cwd)?;
    let output = run_git(
        &cwd,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)\t%(HEAD)",
            "refs/heads",
        ],
    )
    .await?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let (name, marker) = line.split_once('\t')?;
            Some(GitBranch {
                name: name.to_string(),
                current: marker.trim() == "*",
            })
        })
        .collect())
}

#[tauri::command]
pub async fn git_stage(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let cwd = registry.authorize(&cwd)?;
    for path in &paths {
        validate_relative_git_path(path)?;
    }
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths);
    run_git_dynamic(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let cwd = registry.authorize(&cwd)?;
    for path in &paths {
        validate_relative_git_path(path)?;
    }
    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--".to_string(),
    ];
    args.extend(paths);
    run_git_dynamic(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_commit(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    message: String,
) -> Result<String, String> {
    let cwd = registry.authorize(&cwd)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    run_git_dynamic(
        &cwd,
        &["commit".to_string(), "-m".to_string(), message.to_string()],
    )
    .await
}

#[tauri::command]
pub async fn git_checkout_branch(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    branch: String,
) -> Result<(), String> {
    let cwd = registry.authorize(&cwd)?;
    validate_branch_name(&cwd, &branch).await?;
    run_git_dynamic(&cwd, &["checkout".to_string(), "--".to_string(), branch])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn git_create_branch(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    branch: String,
) -> Result<(), String> {
    let cwd = registry.authorize(&cwd)?;
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    run_git_dynamic(
        &cwd,
        &[
            "check-ref-format".to_string(),
            "--branch".to_string(),
            branch.to_string(),
        ],
    )
    .await?;
    run_git_dynamic(
        &cwd,
        &["checkout".to_string(), "-b".to_string(), branch.to_string()],
    )
    .await
    .map(|_| ())
}

async fn validate_branch_name(cwd: &Path, branch: &str) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    run_git_dynamic(
        cwd,
        &[
            "check-ref-format".to_string(),
            "--branch".to_string(),
            branch.to_string(),
        ],
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
#[path = "git_runtime_tests.rs"]
mod tests;
