use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
};

use serde_json::{Value, json};

use super::request_policy::{
    CREATE_SUBAGENT_WORKTREE, event_context, fail_for_request, fail_resolution, success_resolution,
};

const RELATIVE_ROOT: &str = ".melody/pi/worktrees";

fn worktree_path(root: &Path, task_id: &str) -> Result<PathBuf, String> {
    let task_id = task_id.trim();
    if task_id.is_empty() || task_id.len() > 512 || task_id.chars().any(char::is_control) {
        return Err("task_id must be a bounded non-empty identifier".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let melody_root = canonical_root.join(".melody");
    let worktree_root = canonical_root.join(RELATIVE_ROOT);
    // Check every existing component before create_dir_all. Checking only the
    // top-level `.melody` directory would still allow a malicious `.melody/pi`
    // or `worktrees` symlink to be followed while the directory tree is made.
    for component in [
        melody_root.clone(),
        melody_root.join("pi"),
        worktree_root.clone(),
    ] {
        if let Ok(metadata) = fs::symlink_metadata(&component)
            && metadata.file_type().is_symlink()
        {
            return Err(
                "Refusing to create a subagent worktree through a symbolic link".to_string(),
            );
        }
    }
    fs::create_dir_all(&worktree_root)
        .map_err(|error| format!("Failed to create subagent worktree directory: {error}"))?;
    let canonical_worktree_root = worktree_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve subagent worktree directory: {error}"))?;
    if !canonical_worktree_root.starts_with(&canonical_root) {
        return Err("Subagent worktree directory is outside the authorized workspace".to_string());
    }
    let mut hasher = DefaultHasher::new();
    task_id.hash(&mut hasher);
    let candidate = canonical_worktree_root.join(format!("task-{:016x}", hasher.finish()));
    if candidate.exists() {
        return Err("A subagent worktree already exists for this task id".to_string());
    }
    Ok(candidate)
}

fn create_worktree(root: &Path, task_id: &str) -> Result<String, String> {
    let path = worktree_path(root, task_id)?;
    let output = Command::new("git")
        .current_dir(root)
        .args(["worktree", "add", "--detach"])
        .arg(&path)
        .arg("HEAD")
        .output()
        .map_err(|error| format!("Failed to start git worktree: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git worktree add failed".to_string()
        } else {
            stderr
        });
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve created worktree: {error}"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Created worktree is outside the authorized workspace".to_string());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// Resolve the internal worker request and return only a bounded path. The
/// worker never receives a git process handle, branch name, or arbitrary path;
/// Host chooses the managed destination and always creates a detached tree
/// below `.melody/pi/worktrees`.
pub(crate) fn resolve_subagent_worktree_request(root: &Path, value: &Value) -> Value {
    let (session_id, run_id, tool_call_id, tool_name, arguments, _) = match event_context(value) {
        Ok(context) => context,
        Err(error) => return fail_for_request(value, "pi.invalid_tool_request", error),
    };
    if tool_name != CREATE_SUBAGENT_WORKTREE {
        return fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.tool_not_allowed",
            format!("Tool is not allowed by Melody ToolGateway: {tool_name}"),
        );
    }
    let Some(arguments) = arguments.as_object() else {
        return fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.invalid_tool_request",
            "tool.requested.activity.arguments must be an object",
        );
    };
    let Some(task_id) = arguments.get("task_id").and_then(Value::as_str) else {
        return fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.invalid_tool_request",
            "task_id must be a non-empty string",
        );
    };
    match create_worktree(root, task_id) {
        Ok(path) => success_resolution(
            session_id,
            run_id,
            tool_call_id,
            json!({ "worktree_path": path }).to_string(),
        ),
        Err(error) => fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.subagent_worktree_failed",
            error,
        ),
    }
}
