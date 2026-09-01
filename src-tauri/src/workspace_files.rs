use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use crate::workspace_access::{WorkspaceRegistry, confirm_action};
use serde::Serialize;
use tauri::{AppHandle, State, ipc::Response};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

const MAX_TREE_ENTRIES: usize = 2_000;
const MAX_TREE_DEPTH: usize = 8;
const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) is_directory: bool,
    pub(crate) depth: usize,
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

pub(crate) fn safe_write_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
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

pub(crate) fn is_ignored_directory(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | ".next" | ".cache"
    )
}

pub(crate) fn collect_tree(
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

pub(crate) fn read_workspace_binary_bytes(
    root: &str,
    relative_path: &str,
) -> Result<Vec<u8>, String> {
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
