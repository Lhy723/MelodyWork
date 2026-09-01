use tauri::{AppHandle, State};

use crate::workspace_access::{WorkspaceRegistry, confirm_action};

use super::{GitWorktree, run_git, run_git_dynamic, validate_branch_name};

pub(crate) fn parse_worktrees(output: &str) -> Vec<GitWorktree> {
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
