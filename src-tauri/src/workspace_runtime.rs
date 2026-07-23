use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::{io::AsyncReadExt, process::Command};
use uuid::Uuid;

const MAX_TREE_ENTRIES: usize = 2_000;
const MAX_TREE_DEPTH: usize = 8;
const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    path: String,
    name: String,
    is_directory: bool,
    depth: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    terminal_id: String,
    stream: String,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    terminal_id: String,
    code: Option<i32>,
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("Workspace does not exist: {}", root.display()));
    }
    root.canonicalize()
        .map_err(|error| format!("Failed to resolve workspace: {error}"))
}

fn safe_existing_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative_path);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {}: {error}", candidate.display()))?;
    if !canonical.starts_with(root) {
        return Err("Path is outside the workspace".to_string());
    }
    Ok(canonical)
}

fn safe_write_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative_path);
    let parent = candidate
        .parent()
        .ok_or_else(|| "File has no parent directory".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {}: {error}", parent.display()))?;
    if !canonical_parent.starts_with(root) {
        return Err("Path is outside the workspace".to_string());
    }
    let name = candidate
        .file_name()
        .ok_or_else(|| "File name is missing".to_string())?;
    Ok(canonical_parent.join(name))
}

fn is_ignored_directory(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | ".next" | ".cache"
    )
}

fn collect_tree(
    root: &Path,
    directory: &Path,
    depth: usize,
    entries: &mut Vec<WorkspaceEntry>,
) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH || entries.len() >= MAX_TREE_ENTRIES {
        return Ok(());
    }
    let mut children = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    children.sort_by_key(|entry| (!entry.path().is_dir(), entry.file_name()));

    for child in children {
        if entries.len() >= MAX_TREE_ENTRIES {
            break;
        }
        let path = child.path();
        let name = child.file_name().to_string_lossy().into_owned();
        let is_directory = path.is_dir();
        if is_directory && is_ignored_directory(&name) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(WorkspaceEntry {
            path: relative,
            name,
            is_directory,
            depth,
        });
        if is_directory {
            collect_tree(root, &path, depth + 1, entries)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_tree(root: String) -> Result<Vec<WorkspaceEntry>, String> {
    let root = canonical_root(&root)?;
    let mut entries = Vec::new();
    collect_tree(&root, &root, 0, &mut entries)?;
    Ok(entries)
}

#[tauri::command]
pub fn read_workspace_file(root: String, path: String) -> Result<String, String> {
    let root = canonical_root(&root)?;
    let path = safe_existing_path(&root, &path)?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to read file metadata: {error}"))?;
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err("File is larger than the 2 MB editor limit".to_string());
    }
    fs::read_to_string(&path).map_err(|error| format!("File is not valid UTF-8 text: {error}"))
}

#[tauri::command]
pub fn write_workspace_file(root: String, path: String, content: String) -> Result<(), String> {
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("File is larger than the 2 MB editor limit".to_string());
    }
    let root = canonical_root(&root)?;
    let path = safe_write_path(&root, &path)?;
    fs::write(path, content).map_err(|error| format!("Failed to write file: {error}"))
}

async fn forward_terminal_stream<R>(
    app: AppHandle,
    terminal_id: String,
    stream: &'static str,
    mut reader: R,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 4_096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let data = String::from_utf8_lossy(&buffer[..count]).into_owned();
                let _ = app.emit(
                    "melody://terminal-output",
                    TerminalOutput {
                        terminal_id: terminal_id.clone(),
                        stream: stream.to_string(),
                        data,
                    },
                );
            }
        }
    }
}

#[tauri::command]
pub async fn run_terminal_command(
    app: AppHandle,
    cwd: String,
    command: String,
) -> Result<String, String> {
    let cwd = canonical_root(&cwd)?;
    if command.trim().is_empty() {
        return Err("Command cannot be empty".to_string());
    }
    let terminal_id = Uuid::new_v4().to_string();
    let mut process = if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.args(["/C", &command]);
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-lc", &command]);
        process
    };
    let mut child = process
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Failed to start terminal command: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Terminal stdout was not piped".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Terminal stderr was not piped".to_string())?;

    let stdout_app = app.clone();
    let stdout_id = terminal_id.clone();
    let stderr_app = app.clone();
    let stderr_id = terminal_id.clone();
    let exit_id = terminal_id.clone();
    tauri::async_runtime::spawn(async move {
        let stdout_task = forward_terminal_stream(stdout_app, stdout_id, "stdout", stdout);
        let stderr_task = forward_terminal_stream(stderr_app, stderr_id, "stderr", stderr);
        let (status, _, _) = tokio::join!(child.wait(), stdout_task, stderr_task);
        let _ = app.emit(
            "melody://terminal-exit",
            TerminalExit {
                terminal_id: exit_id,
                code: status.ok().and_then(|status| status.code()),
            },
        );
    });

    Ok(terminal_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_large_generated_directories() {
        assert!(is_ignored_directory("node_modules"));
        assert!(is_ignored_directory(".git"));
        assert!(!is_ignored_directory("src"));
    }
}
