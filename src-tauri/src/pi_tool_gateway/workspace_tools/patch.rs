use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::{
    READ_FILE_MAX_BYTES, WRITE_FILE_MAX_BYTES, gitignored_error, gitignored_path, relative_path,
    respect_gitignore, safe_write_path, write_no_follow,
};

const PATCH_MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchOperation {
    Add,
    Delete,
    Update,
}

#[derive(Debug)]
struct PatchFile {
    path: String,
    operation: PatchOperation,
    move_path: Option<String>,
    contents: String,
    hunks: Vec<Vec<String>>,
}

fn patch_path(marker: &str, line: &str) -> Option<String> {
    line.trim()
        .strip_prefix(marker)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| path.trim_start_matches("a/").to_string())
}

fn is_patch_header(line: &str) -> bool {
    let line = line.trim_start();
    line.starts_with("*** Add File: ")
        || line.starts_with("*** Delete File: ")
        || line.starts_with("*** Update File: ")
        || line == "*** Begin Patch"
        || line == "*** End Patch"
}

/// Parse the apply_patch format used by Melody's existing ACP tool. In
/// addition to update hunks, retain add/delete/move operations so Pi can use
/// the same patch vocabulary instead of silently losing file lifecycle
/// changes during migration.
fn patch_files(patch: &str) -> Result<Vec<PatchFile>, String> {
    if patch.len() > PATCH_MAX_BYTES {
        return Err("Patch is larger than the 2 MB limit".to_string());
    }
    let lines = patch.lines().collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let marker = lines[index].trim();
        if marker.is_empty() || marker == "*** Begin Patch" || marker == "*** End Patch" {
            index += 1;
            continue;
        }
        if let Some(path) = patch_path("*** Add File: ", marker) {
            index += 1;
            let mut contents = String::new();
            while index < lines.len() && lines[index].starts_with('+') {
                contents.push_str(&lines[index][1..]);
                contents.push('\n');
                index += 1;
            }
            if contents.is_empty() {
                return Err(format!("Add file hunk for {path} has no contents"));
            }
            files.push(PatchFile {
                path,
                operation: PatchOperation::Add,
                move_path: None,
                contents,
                hunks: Vec::new(),
            });
            continue;
        }
        if let Some(path) = patch_path("*** Delete File: ", marker) {
            files.push(PatchFile {
                path,
                operation: PatchOperation::Delete,
                move_path: None,
                contents: String::new(),
                hunks: Vec::new(),
            });
            index += 1;
            continue;
        }
        if let Some(path) = patch_path("*** Update File: ", marker) {
            index += 1;
            let move_path = if index < lines.len() {
                let candidate = lines[index].trim();
                patch_path("*** Move to: ", candidate).inspect(|_| {
                    index += 1;
                })
            } else {
                None
            };
            let mut hunks = Vec::new();
            let mut hunk: Option<Vec<String>> = None;
            while index < lines.len() {
                let line = lines[index];
                if is_patch_header(line) {
                    break;
                }
                if line.trim_start().starts_with("*** Move to: ") {
                    return Err(format!("Unexpected move marker in update hunk for {path}"));
                }
                if line.starts_with("@@") {
                    if let Some(lines) = hunk.take() {
                        hunks.push(lines);
                    }
                    hunk = Some(Vec::new());
                } else if line == "*** End of File" {
                    if let Some(lines) = hunk.as_mut() {
                        lines.push(line.to_string());
                    }
                } else if line.starts_with(' ') || line.starts_with('+') || line.starts_with('-') {
                    hunk.get_or_insert_with(Vec::new).push(line.to_string());
                } else if line.is_empty() {
                    if let Some(lines) = hunk.as_mut() {
                        lines.push(String::new());
                    }
                } else {
                    return Err(format!("Unexpected line in update hunk for {path}"));
                }
                index += 1;
            }
            if let Some(lines) = hunk {
                hunks.push(lines);
            }
            if hunks.is_empty() {
                return Err(format!("Update file hunk for {path} has no hunks"));
            }
            files.push(PatchFile {
                path,
                operation: PatchOperation::Update,
                move_path,
                contents: String::new(),
                hunks,
            });
            continue;
        }
        return Err(format!("Unexpected patch line: {marker}"));
    }
    if files.is_empty() {
        return Err("Patch must contain at least one file operation".to_string());
    }
    Ok(files)
}

#[derive(Debug)]
enum PlannedPatch {
    Add {
        path: PathBuf,
        contents: String,
    },
    Delete {
        path: PathBuf,
    },
    Update {
        path: PathBuf,
        move_path: Option<(String, PathBuf)>,
        contents: String,
    },
}

pub(in crate::pi_tool_gateway) fn apply_patch(
    root: &Path,
    arguments: &Value,
) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_apply_patch arguments must be an object".to_string())?;
    let respect = respect_gitignore(arguments)?;
    let patch = arguments
        .get("patch")
        .and_then(Value::as_str)
        .ok_or_else(|| "patch must be a string".to_string())?;
    let files = patch_files(patch)?;
    let mut planned_paths = std::collections::HashSet::new();
    let mut planned = Vec::with_capacity(files.len());
    let mut changed = Vec::new();
    for file in files {
        let relative = relative_path(Some(&Value::String(file.path.clone())), "path")?;
        if !planned_paths.insert(relative.clone()) {
            return Err(format!("Patch contains the file {relative} more than once"));
        }
        match file.operation {
            PatchOperation::Add => {
                let path = safe_write_path(root, &relative)?;
                if fs::symlink_metadata(&path).is_ok() {
                    return Err(format!("Cannot add {relative}: the path already exists"));
                }
                if file.contents.len() > WRITE_FILE_MAX_BYTES {
                    return Err(format!(
                        "Added file {relative} is larger than the 2 MB limit"
                    ));
                }
                planned.push(PlannedPatch::Add {
                    path,
                    contents: file.contents,
                });
            }
            PatchOperation::Delete => {
                let path = safe_write_path(root, &relative)?;
                let metadata = path
                    .metadata()
                    .map_err(|error| format!("Failed to read patch target metadata: {error}"))?;
                if respect && gitignored_path(root, &path) {
                    return Err(gitignored_error(&relative));
                }
                if !metadata.is_file() {
                    return Err(format!("Patch target {relative} is not a file"));
                }
                planned.push(PlannedPatch::Delete { path });
            }
            PatchOperation::Update => {
                let path = safe_write_path(root, &relative)?;
                let metadata = path
                    .metadata()
                    .map_err(|error| format!("Failed to read patch target metadata: {error}"))?;
                if respect && gitignored_path(root, &path) {
                    return Err(gitignored_error(&relative));
                }
                if !metadata.is_file() || metadata.len() > READ_FILE_MAX_BYTES {
                    return Err(format!(
                        "Patch target {relative} is not a bounded text file"
                    ));
                }
                let original = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                let mut updated = original;
                for lines in file.hunks {
                    let old = lines
                        .iter()
                        .filter_map(|line| {
                            line.strip_prefix(' ').or_else(|| line.strip_prefix('-'))
                        })
                        .filter(|line| *line != "*** End of File")
                        .collect::<Vec<_>>()
                        .join("\n");
                    let new = lines
                        .iter()
                        .filter_map(|line| {
                            line.strip_prefix(' ').or_else(|| line.strip_prefix('+'))
                        })
                        .filter(|line| *line != "*** End of File")
                        .collect::<Vec<_>>()
                        .join("\n");
                    if old.is_empty() {
                        return Err(format!("Patch hunk for {relative} has no context"));
                    }
                    if !updated.contains(&old) {
                        return Err(format!("Patch context was not found in {relative}"));
                    }
                    updated = updated.replacen(&old, &new, 1);
                }
                if updated.len() > WRITE_FILE_MAX_BYTES {
                    return Err(format!(
                        "Patched file {relative} is larger than the 2 MB limit"
                    ));
                }
                let move_path = if let Some(move_path) = file.move_path {
                    let move_relative = relative_path(Some(&Value::String(move_path)), "movePath")?;
                    if !planned_paths.insert(move_relative.clone()) {
                        return Err(format!(
                            "Patch contains the destination {move_relative} more than once"
                        ));
                    }
                    let move_target = safe_write_path(root, &move_relative)?;
                    if fs::symlink_metadata(&move_target).is_ok() {
                        return Err(format!(
                            "Cannot move {relative} to {move_relative}: the destination exists"
                        ));
                    }
                    Some((move_relative, move_target))
                } else {
                    None
                };
                planned.push(PlannedPatch::Update {
                    path,
                    move_path,
                    contents: updated,
                });
            }
        }
        changed.push(relative);
    }
    for item in planned {
        match item {
            PlannedPatch::Add { path, contents, .. }
            | PlannedPatch::Update {
                path,
                move_path: None,
                contents,
                ..
            } => write_no_follow(&path, &contents)?,
            PlannedPatch::Delete { path, .. } => {
                fs::remove_file(&path)
                    .map_err(|error| format!("Failed to delete file: {error}"))?;
            }
            PlannedPatch::Update {
                path,
                move_path: Some((_, move_path)),
                contents,
                ..
            } => {
                write_no_follow(&path, &contents)?;
                fs::rename(&path, &move_path)
                    .map_err(|error| format!("Failed to move patched file: {error}"))?;
            }
        }
    }
    Ok(format!("Applied patch to {}", changed.join(", ")))
}
