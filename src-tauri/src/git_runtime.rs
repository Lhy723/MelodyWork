use std::path::Path;

use serde::Serialize;
use tokio::process::Command;

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
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let additions = parts.next()?.parse().unwrap_or(0);
            let deletions = parts.next()?.parse().unwrap_or(0);
            let path = parts.next()?.to_string();
            Some((path, (additions, deletions)))
        })
        .collect()
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
pub async fn git_changes(cwd: String) -> Result<Vec<GitChange>, String> {
    let cwd = Path::new(&cwd);
    let status = run_git(cwd, &["status", "--porcelain=v1", "-uall"]).await?;
    let unstaged_stats = run_git(cwd, &["diff", "--numstat"]).await?;
    let staged_stats = run_git(cwd, &["diff", "--cached", "--numstat"]).await?;
    let unstaged_stats = parse_numstat(&unstaged_stats);
    let staged_stats = parse_numstat(&staged_stats);

    let mut changes = Vec::new();
    for line in status.lines() {
        if line.len() < 4 {
            continue;
        }
        let index = line.as_bytes()[0] as char;
        let worktree = line.as_bytes()[1] as char;
        let raw_path = line[3..].trim();
        let path = raw_path
            .rsplit_once(" -> ")
            .map_or(raw_path, |(_, destination)| destination)
            .to_string();
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
pub async fn git_diff(cwd: String, path: String) -> Result<GitDiff, String> {
    let cwd = Path::new(&cwd);
    let status = run_git(cwd, &["status", "--porcelain=v1", "-uall", "--", &path]).await?;
    let is_untracked = status.lines().any(|line| line.starts_with("?? "));
    let content = if is_untracked {
        untracked_diff(cwd, &path).await?
    } else {
        let unstaged = run_git(cwd, &["diff", "--no-ext-diff", "--", &path]).await?;
        let staged = run_git(cwd, &["diff", "--cached", "--no-ext-diff", "--", &path]).await?;
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
        path,
        content,
        binary,
    })
}

#[tauri::command]
pub async fn git_branches(cwd: String) -> Result<Vec<GitBranch>, String> {
    let output = run_git(
        Path::new(&cwd),
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
pub async fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths);
    run_git_dynamic(Path::new(&cwd), &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--".to_string(),
    ];
    args.extend(paths);
    run_git_dynamic(Path::new(&cwd), &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_commit(cwd: String, message: String) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    run_git_dynamic(
        Path::new(&cwd),
        &["commit".to_string(), "-m".to_string(), message.to_string()],
    )
    .await
}

#[tauri::command]
pub async fn git_checkout_branch(cwd: String, branch: String) -> Result<(), String> {
    run_git_dynamic(Path::new(&cwd), &["checkout".to_string(), branch])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn git_create_branch(cwd: String, branch: String) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    run_git_dynamic(
        Path::new(&cwd),
        &[
            "check-ref-format".to_string(),
            "--branch".to_string(),
            branch.to_string(),
        ],
    )
    .await?;
    run_git_dynamic(
        Path::new(&cwd),
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
pub async fn git_worktrees(cwd: String) -> Result<Vec<GitWorktree>, String> {
    let output = run_git(Path::new(&cwd), &["worktree", "list", "--porcelain"]).await?;
    Ok(parse_worktrees(&output))
}

#[tauri::command]
pub async fn git_create_worktree(
    cwd: String,
    path: String,
    branch: String,
    create_branch: bool,
) -> Result<(), String> {
    let mut args = vec!["worktree".to_string(), "add".to_string()];
    if create_branch {
        args.extend(["-b".to_string(), branch, path]);
    } else {
        args.extend([path, branch]);
    }
    run_git_dynamic(Path::new(&cwd), &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_remove_worktree(cwd: String, path: String) -> Result<(), String> {
    run_git_dynamic(
        Path::new(&cwd),
        &["worktree".to_string(), "remove".to_string(), path],
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

        let changes = git_changes(root_string.clone())
            .await
            .expect("read git changes");
        let change = changes
            .iter()
            .find(|change| change.path == "notes.txt")
            .expect("untracked file should be listed");
        assert_eq!(change.status, "??");
        assert_eq!(change.additions, 2);
        assert_eq!(change.deletions, 0);

        let diff = git_diff(root_string, "notes.txt".to_string())
            .await
            .expect("read untracked file diff");
        assert!(!diff.binary);
        assert!(diff.content.contains("new file mode"));
        assert!(diff.content.contains("+first line"));
        assert!(diff.content.contains("+second line"));

        fs::remove_dir_all(root).expect("remove temporary git repository");
    }
}
