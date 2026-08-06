use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State, ipc::Response};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::Mutex,
};
use uuid::Uuid;

const MAX_TREE_ENTRIES: usize = 2_000;
const MAX_TREE_DEPTH: usize = 8;
const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct TerminalRuntime {
    inputs: Arc<Mutex<HashMap<String, ChildStdin>>>,
}

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
pub fn read_workspace_binary_file(root: String, path: String) -> Result<Response, String> {
    read_workspace_binary_bytes(&root, &path).map(Response::new)
}

fn read_workspace_binary_bytes(root: &str, relative_path: &str) -> Result<Vec<u8>, String> {
    let root = canonical_root(root)?;
    let path = safe_existing_path(&root, relative_path)?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to read file metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("Preview target is not a file".to_string());
    }
    if metadata.len() > MAX_PREVIEW_FILE_BYTES {
        return Err("File is larger than the 100 MB preview limit".to_string());
    }
    fs::read(path).map_err(|error| format!("Failed to read preview file: {error}"))
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

fn persistent_shell(cwd: &Path) -> Command {
    let mut process = if cfg!(windows) {
        Command::new("cmd")
    } else {
        Command::new(std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string()))
    };
    process
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    process
}

#[tauri::command]
pub async fn create_terminal_session(
    app: AppHandle,
    runtime: State<'_, TerminalRuntime>,
    cwd: String,
) -> Result<String, String> {
    let cwd = canonical_root(&cwd)?;
    let terminal_id = Uuid::new_v4().to_string();
    let mut child = persistent_shell(&cwd)
        .spawn()
        .map_err(|error| format!("Failed to start terminal: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Terminal stdin was not piped".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Terminal stdout was not piped".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Terminal stderr was not piped".to_string())?;
    runtime
        .inputs
        .lock()
        .await
        .insert(terminal_id.clone(), stdin);

    let stdout_app = app.clone();
    let stdout_id = terminal_id.clone();
    let stderr_app = app.clone();
    let stderr_id = terminal_id.clone();
    let exit_id = terminal_id.clone();
    let inputs = runtime.inputs.clone();
    tauri::async_runtime::spawn(async move {
        let stdout_task = forward_terminal_stream(stdout_app, stdout_id, "stdout", stdout);
        let stderr_task = forward_terminal_stream(stderr_app, stderr_id, "stderr", stderr);
        let (status, _, _) = tokio::join!(child.wait(), stdout_task, stderr_task);
        inputs.lock().await.remove(&exit_id);
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

#[tauri::command]
pub async fn write_terminal_input(
    runtime: State<'_, TerminalRuntime>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let mut inputs = runtime.inputs.lock().await;
    let input = inputs
        .get_mut(&terminal_id)
        .ok_or_else(|| "Terminal session is no longer running".to_string())?;
    input
        .write_all(data.as_bytes())
        .await
        .map_err(|error| format!("Failed to write to terminal: {error}"))?;
    input
        .flush()
        .await
        .map_err(|error| format!("Failed to flush terminal input: {error}"))
}

#[tauri::command]
pub async fn close_terminal_session(
    runtime: State<'_, TerminalRuntime>,
    terminal_id: String,
) -> Result<(), String> {
    runtime.inputs.lock().await.remove(&terminal_id);
    Ok(())
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn ignores_large_generated_directories() {
        assert!(is_ignored_directory("node_modules"));
        assert!(is_ignored_directory(".git"));
        assert!(!is_ignored_directory("src"));
    }

    #[test]
    fn reads_binary_preview_bytes_inside_workspace() {
        let root = std::env::temp_dir().join(format!("melody-preview-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temporary workspace should be created");
        fs::write(root.join("sample.bin"), [0_u8, 1, 2, 255]).expect("sample should be written");

        let result = read_workspace_binary_bytes(root.to_str().unwrap(), "sample.bin")
            .expect("workspace file should be readable");

        assert_eq!(result, vec![0, 1, 2, 255]);
        fs::remove_dir_all(root).expect("temporary workspace should be removed");
    }

    #[test]
    fn rejects_binary_preview_directories_and_outside_paths() {
        let root = std::env::temp_dir().join(format!("melody-preview-{}", Uuid::new_v4()));
        let outside = root
            .parent()
            .expect("temporary workspace should have a parent")
            .join(format!(
                "{}-outside.bin",
                root.file_name().unwrap().to_string_lossy()
            ));
        fs::create_dir_all(root.join("folder")).expect("temporary workspace should be created");
        fs::write(&outside, [1_u8]).expect("outside fixture should be written");

        let directory_error = read_workspace_binary_bytes(root.to_str().unwrap(), "folder")
            .expect_err("directories should not be preview targets");
        assert!(directory_error.contains("not a file"));

        let outside_relative = format!(
            "../{}-outside.bin",
            root.file_name().unwrap().to_string_lossy()
        );
        let outside_error = read_workspace_binary_bytes(root.to_str().unwrap(), &outside_relative)
            .expect_err("paths outside the workspace should be rejected");
        assert!(outside_error.contains("outside the workspace"));

        fs::remove_dir_all(root).expect("temporary workspace should be removed");
        fs::remove_file(outside).expect("outside fixture should be removed");
    }

    #[tokio::test]
    async fn persistent_shell_accepts_input_and_returns_output() {
        let cwd = std::env::current_dir().expect("current directory should be available");
        let mut child = persistent_shell(&cwd)
            .spawn()
            .expect("persistent shell should start");
        let mut stdin = child.stdin.take().expect("stdin should be piped");
        let mut stdout = child.stdout.take().expect("stdout should be piped");

        #[cfg(windows)]
        let input = "echo melody-terminal-ok\r\nexit\r\n";
        #[cfg(not(windows))]
        let input = "printf 'melody-terminal-ok\\n'\nexit\n";

        stdin
            .write_all(input.as_bytes())
            .await
            .expect("terminal input should be writable");
        stdin.flush().await.expect("terminal input should flush");
        drop(stdin);

        let mut output = String::new();
        stdout
            .read_to_string(&mut output)
            .await
            .expect("terminal output should be readable");
        let status = child.wait().await.expect("shell should exit");

        assert!(status.success());
        assert!(output.contains("melody-terminal-ok"));
    }
}
