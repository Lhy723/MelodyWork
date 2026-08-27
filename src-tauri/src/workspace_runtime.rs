use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use crate::workspace_access::{WorkspaceRegistry, confirm_action};
use serde::Serialize;
use std::io::Write;
use tauri::{AppHandle, Emitter, State, ipc::Response};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};
use uuid::Uuid;

const MAX_TREE_ENTRIES: usize = 2_000;
const MAX_TREE_DEPTH: usize = 8;
const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

struct TerminalSession {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

#[derive(Clone, Default)]
pub struct TerminalRuntime {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
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
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace: {error}"))?;
    if canonical.parent().is_none() {
        return Err("The filesystem root cannot be used as a workspace".to_string());
    }
    Ok(canonical)
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
    if let Ok(metadata) = fs::symlink_metadata(&candidate) {
        if metadata.file_type().is_symlink() {
            return Err("Refusing to write through a symbolic link".to_string());
        }
    }
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
    let safe_path = canonical_parent.join(name);
    if let Ok(metadata) = fs::symlink_metadata(&safe_path) {
        if metadata.file_type().is_symlink() {
            return Err("Refusing to write through a symbolic link".to_string());
        }
    }
    Ok(safe_path)
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
    children.sort_by_key(|entry| {
        (
            !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false),
            entry.file_name(),
        )
    });

    for child in children {
        if entries.len() >= MAX_TREE_ENTRIES {
            break;
        }
        let path = child.path();
        let name = child.file_name().to_string_lossy().into_owned();
        let file_type = child
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() {
            continue;
        }
        let is_directory = file_type.is_dir();
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
pub async fn pick_workspace_directory(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<Option<String>, String> {
    let registry = registry.inner().clone();
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("打开工作区")
        .pick_folder(move |selected| {
            let path = selected.and_then(|value| value.into_path().ok());
            let _ = sender.send(path);
        });
    let selected = receiver
        .await
        .map_err(|_| "Workspace picker was closed unexpectedly".to_string())?;
    selected
        .map(|path| {
            registry
                .register(&path)
                .map(|canonical| canonical.to_string_lossy().into_owned())
        })
        .transpose()
}

#[tauri::command]
pub fn workspace_tree(
    registry: State<'_, WorkspaceRegistry>,
    root: String,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = registry.authorize(&root)?;
    let mut entries = Vec::new();
    collect_tree(&root, &root, 0, &mut entries)?;
    Ok(entries)
}

#[tauri::command]
pub fn read_workspace_file(
    registry: State<'_, WorkspaceRegistry>,
    root: String,
    path: String,
) -> Result<String, String> {
    let root = registry.authorize(&root)?;
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
pub fn read_workspace_binary_file(
    registry: State<'_, WorkspaceRegistry>,
    root: String,
    path: String,
) -> Result<Response, String> {
    let root = registry.authorize(&root)?;
    read_workspace_binary_bytes(&root.to_string_lossy(), &path).map(Response::new)
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
pub async fn write_workspace_file(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    root: String,
    path: String,
    content: String,
) -> Result<(), String> {
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("File is larger than the 2 MB editor limit".to_string());
    }
    let root = registry.authorize(&root)?;
    let path = safe_write_path(&root, &path)?;
    confirm_action(
        &app,
        "确认写入工作区文件",
        format!("允许 MelodyWork 写入以下文件吗？\n{}", path.display()),
    )
    .await?;
    write_file_no_follow(&path, &content)
}

fn write_file_no_follow(path: &Path, content: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to open file for writing: {error}"))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("Failed to write file: {error}"))
}

struct OutputBudget {
    emitted: AtomicUsize,
    truncation_sent: AtomicBool,
}

impl Default for OutputBudget {
    fn default() -> Self {
        Self {
            emitted: AtomicUsize::new(0),
            truncation_sent: AtomicBool::new(false),
        }
    }
}

impl OutputBudget {
    fn reserve(&self, requested: usize) -> usize {
        let mut current = self.emitted.load(Ordering::Relaxed);
        loop {
            let available = MAX_TERMINAL_OUTPUT_BYTES.saturating_sub(current);
            let allowed = requested.min(available);
            match self.emitted.compare_exchange(
                current,
                current.saturating_add(allowed),
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return allowed,
                Err(next) => current = next,
            }
        }
    }
}

async fn forward_terminal_stream<R>(
    app: AppHandle,
    terminal_id: String,
    stream: &'static str,
    mut reader: R,
    budget: Arc<OutputBudget>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 4_096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let allowed = budget.reserve(count);
                if allowed > 0 {
                    let data = String::from_utf8_lossy(&buffer[..allowed]).into_owned();
                    let _ = app.emit(
                        "melody://terminal-output",
                        TerminalOutput {
                            terminal_id: terminal_id.clone(),
                            stream: stream.to_string(),
                            data,
                        },
                    );
                }
                if allowed < count && !budget.truncation_sent.swap(true, Ordering::AcqRel) {
                    let _ = app.emit(
                        "melody://terminal-output",
                        TerminalOutput {
                            terminal_id: terminal_id.clone(),
                            stream: stream.to_string(),
                            data: "\n[终端输出已截断：超过 8 MiB 上限]\n".to_string(),
                        },
                    );
                }
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

async fn wait_for_terminal_exit(
    child: Arc<Mutex<Child>>,
) -> Result<std::process::ExitStatus, std::io::Error> {
    loop {
        let status = {
            let mut child = child.lock().await;
            child.try_wait()?
        };
        if let Some(status) = status {
            return Ok(status);
        }
        // Do not hold the child mutex while waiting. close_terminal_session
        // must be able to acquire it and kill an interactive shell.
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tauri::command]
pub async fn create_terminal_session(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    runtime: State<'_, TerminalRuntime>,
    cwd: String,
) -> Result<String, String> {
    let cwd = registry.authorize(&cwd)?;
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
    let session = Arc::new(TerminalSession {
        child: Arc::new(Mutex::new(child)),
        stdin: Mutex::new(Some(stdin)),
    });
    runtime
        .sessions
        .lock()
        .await
        .insert(terminal_id.clone(), session.clone());

    let stdout_app = app.clone();
    let stdout_id = terminal_id.clone();
    let stderr_app = app.clone();
    let stderr_id = terminal_id.clone();
    let exit_id = terminal_id.clone();
    let sessions = runtime.sessions.clone();
    let budget = Arc::new(OutputBudget::default());
    let stdout_session = session.clone();
    tauri::async_runtime::spawn(async move {
        let stdout_task =
            forward_terminal_stream(stdout_app, stdout_id, "stdout", stdout, budget.clone());
        let stderr_task = forward_terminal_stream(stderr_app, stderr_id, "stderr", stderr, budget);
        let wait_task = wait_for_terminal_exit(stdout_session.child.clone());
        let (status, _, _) = tokio::join!(wait_task, stdout_task, stderr_task);
        sessions.lock().await.remove(&exit_id);
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
    let session = runtime
        .sessions
        .lock()
        .await
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "Terminal session is no longer running".to_string())?;
    let mut input = session.stdin.lock().await;
    let input = input
        .as_mut()
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
    let session = runtime.sessions.lock().await.remove(&terminal_id);
    let Some(session) = session else {
        return Ok(());
    };
    session.stdin.lock().await.take();
    let mut child = session.child.lock().await;
    if child
        .try_wait()
        .map_err(|error| format!("Failed to inspect terminal process: {error}"))?
        .is_none()
    {
        child
            .kill()
            .await
            .map_err(|error| format!("Failed to stop terminal process: {error}"))?;
        let _ = child.wait().await;
    }
    Ok(())
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

    #[cfg(unix)]
    #[test]
    fn rejects_writes_through_final_component_symlinks() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("melody-write-{}", Uuid::new_v4()));
        let outside = root
            .parent()
            .expect("temporary workspace should have a parent")
            .join(format!(
                "{}-outside.txt",
                root.file_name().unwrap().to_string_lossy()
            ));
        fs::create_dir_all(&root).expect("temporary workspace should be created");
        fs::write(&outside, "outside").expect("outside fixture should be written");
        symlink(&outside, root.join("link.txt")).expect("symlink should be created");

        let error = safe_write_path(&root.canonicalize().unwrap(), "link.txt")
            .expect_err("final symlinks must not be writable");
        assert!(error.contains("symbolic link"));

        fs::remove_dir_all(root).expect("temporary workspace should be removed");
        fs::remove_file(outside).expect("outside fixture should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_directory_symlinks_when_collecting_tree() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("melody-tree-{}", Uuid::new_v4()));
        let outside = root
            .parent()
            .expect("temporary workspace should have a parent")
            .join(format!(
                "{}-outside",
                root.file_name().unwrap().to_string_lossy()
            ));
        fs::create_dir_all(&root).expect("temporary workspace should be created");
        fs::create_dir_all(outside.join("secret")).expect("outside fixture should be created");
        symlink(&outside, root.join("linked")).expect("directory symlink should be created");

        let root = root.canonicalize().unwrap();
        let mut entries = Vec::new();
        collect_tree(&root, &root, 0, &mut entries).expect("tree collection should succeed");

        assert!(
            entries
                .iter()
                .all(|entry| !entry.path.starts_with("linked/"))
        );

        fs::remove_dir_all(root).expect("temporary workspace should be removed");
        fs::remove_dir_all(outside).expect("outside fixture should be removed");
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

    #[tokio::test]
    async fn terminal_wait_does_not_block_shutdown() {
        let cwd = std::env::current_dir().expect("current directory should be available");
        let child = Arc::new(Mutex::new(
            persistent_shell(&cwd)
                .spawn()
                .expect("persistent shell should start"),
        ));
        let waiter = tokio::spawn(wait_for_terminal_exit(child.clone()));

        let mut child_guard = tokio::time::timeout(Duration::from_secs(1), child.lock())
            .await
            .expect("waiter must not hold the child lock");
        child_guard.kill().await.expect("shell should be killable");
        drop(child_guard);

        assert!(waiter.await.expect("waiter task should finish").is_ok());
    }
}
