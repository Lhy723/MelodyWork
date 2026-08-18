use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::process::Command;

use crate::workspace_access::{WorkspaceRegistry, confirm_action};

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
    app: AppHandle,
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
    confirm_action(
        &app,
        "确认暂存 Git 更改",
        format!("允许在 {} 暂存 {} 个文件吗？", cwd.display(), paths.len()),
    )
    .await?;
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths);
    run_git_dynamic(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(
    app: AppHandle,
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
    confirm_action(
        &app,
        "确认取消暂存 Git 更改",
        format!(
            "允许在 {} 取消暂存 {} 个文件吗？",
            cwd.display(),
            paths.len()
        ),
    )
    .await?;
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
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    message: String,
) -> Result<String, String> {
    let cwd = registry.authorize(&cwd)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    confirm_action(
        &app,
        "确认创建 Git 提交",
        format!("允许在 {} 创建以下提交吗？\n{}", cwd.display(), message),
    )
    .await?;
    run_git_dynamic(
        &cwd,
        &["commit".to_string(), "-m".to_string(), message.to_string()],
    )
    .await
}

#[tauri::command]
pub async fn git_checkout_branch(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    branch: String,
) -> Result<(), String> {
    let cwd = registry.authorize(&cwd)?;
    validate_branch_name(&cwd, &branch).await?;
    confirm_action(
        &app,
        "确认切换 Git 分支",
        format!("允许在 {} 切换到分支 {} 吗？", cwd.display(), branch),
    )
    .await?;
    run_git_dynamic(&cwd, &["checkout".to_string(), "--".to_string(), branch])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn git_create_branch(
    app: AppHandle,
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
    confirm_action(
        &app,
        "确认创建 Git 分支",
        format!("允许在 {} 创建并切换到分支 {} 吗？", cwd.display(), branch),
    )
    .await?;
    run_git_dynamic(
        &cwd,
        &["checkout".to_string(), "-b".to_string(), branch.to_string()],
    )
    .await
    .map(|_| ())
}

fn parse_worktrees(output: &str) -> Vec<GitWorktree> {
    output
        .split("\n\n")
        .filter_map(|block| {
            let mut worktree = GitWorktree::default();
            for line in block.lines() {
                if let Some(path) = line.strip_prefix("worktree ") {
                    worktree.path = path.to_string();
                } else if let Some(head) = line.strip_prefix("HEAD ") {
                    worktree.head = Some(head.to_string());
                } else if let Some(branch) = line.strip_prefix("branch ") {
                    worktree.branch = Some(
                        branch
                            .strip_prefix("refs/heads/")
                            .unwrap_or(branch)
                            .to_string(),
                    );
                } else if line == "bare" {
                    worktree.bare = true;
                } else if line == "detached" {
                    worktree.detached = true;
                }
            }
            (!worktree.path.is_empty()).then_some(worktree)
        })
        .collect()
}

#[tauri::command]
pub async fn git_worktrees(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<GitWorktree>, String> {
    let cwd = registry.authorize(&cwd)?;
    let output = run_git(&cwd, &["worktree", "list", "--porcelain"]).await?;
    Ok(parse_worktrees(&output))
}

#[tauri::command]
pub async fn git_create_worktree(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    path: String,
    branch: String,
    create_branch: bool,
) -> Result<(), String> {
    let cwd = registry.authorize(&cwd)?;
    if path.trim().is_empty() || branch.trim().is_empty() {
        return Err("Worktree path and branch cannot be empty".to_string());
    }
    if create_branch {
        validate_branch_name(&cwd, &branch).await?;
    }
    confirm_action(
        &app,
        "确认创建 Git 工作树",
        format!(
            "允许从 {} 创建工作树到以下路径吗？\n{}",
            cwd.display(),
            path
        ),
    )
    .await?;
    let mut args = vec!["worktree".to_string(), "add".to_string()];
    if create_branch {
        args.extend(["-b".to_string(), branch, path]);
    } else {
        args.extend([path, branch]);
    }
    run_git_dynamic(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_remove_worktree(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    let cwd = registry.authorize(&cwd)?;
    if path.trim().is_empty() {
        return Err("Worktree path cannot be empty".to_string());
    }
    confirm_action(
        &app,
        "确认移除 Git 工作树",
        format!("允许从 {} 移除以下工作树吗？\n{}", cwd.display(), path),
    )
    .await?;
    run_git_dynamic(&cwd, &["worktree".to_string(), "remove".to_string(), path])
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
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn create_untracked_repo() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("melody-git-review-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temporary git repository");
        let status = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&root)
            .status()
            .expect("start git init");
        assert!(status.success(), "git init should succeed");
        fs::write(root.join("notes.txt"), "first line\nsecond line\n")
            .expect("write untracked file");
        root
    }

    #[test]
    fn parses_numstat_and_ignores_binary_counts() {
        let parsed = parse_numstat("4\t2\tsrc/app.ts\n-\t-\timage.png\n");
        assert_eq!(parsed.get("src/app.ts"), Some(&(4, 2)));
        assert_eq!(parsed.get("image.png"), Some(&(0, 0)));
    }

    #[test]
    fn parses_porcelain_worktrees() {
        let worktrees = parse_worktrees(
            "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\
             worktree /repo-feature\nHEAD def\nbranch refs/heads/feature\n\n",
        );
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[1].branch.as_deref(), Some("feature"));
    }

    #[tokio::test]
    async fn includes_untracked_text_files_in_review_stats_and_diff() {
        let root = create_untracked_repo();
        let root_string = root.to_string_lossy().into_owned();

        let changes = git_changes_at(Path::new(&root_string))
            .await
            .expect("read git changes");
        let change = changes
            .iter()
            .find(|change| change.path == "notes.txt")
            .expect("untracked file should be listed");
        assert_eq!(change.status, "??");
        assert_eq!(change.additions, 2);
        assert_eq!(change.deletions, 0);

        let diff = git_diff_at(Path::new(&root_string), "notes.txt")
            .await
            .expect("read untracked file diff");
        assert!(!diff.binary);
        assert!(diff.content.contains("new file mode"));
        assert!(diff.content.contains("+first line"));
        assert!(diff.content.contains("+second line"));

        fs::remove_dir_all(root).expect("remove temporary git repository");
    }

    #[tokio::test]
    async fn preserves_unicode_and_space_paths_from_porcelain_status() {
        let root = create_untracked_repo();
        let path = "中文 notes.txt";
        fs::write(root.join(path), "first line\n").expect("unicode fixture should be written");

        let changes = git_changes_at(&root).await.expect("read git changes");

        assert!(
            changes.iter().any(|change| change.path == path),
            "git status should return the original path, got: {changes:?}"
        );

        fs::remove_dir_all(root).expect("remove temporary git repository");
    }
}
