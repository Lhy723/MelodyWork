use std::{collections::HashSet, fs, io, path::Path};

use serde_json::{Value, json};

use super::{
    request_policy::{event_context, fail_for_request, fail_resolution, success_resolution},
    workspace_paths::relative_path,
};

const MAX_PATHS: usize = 64;
const MAX_FILES: usize = 32;
const MAX_FILE_BYTES: u64 = 32 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024;

fn existing_scoped_directory(root: &Path, relative: &str) -> Result<std::path::PathBuf, String> {
    let relative = relative_path(Some(&Value::String(relative.to_string())), "path")?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let mut candidate = canonical_root.join(relative);
    if candidate.exists() {
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("Failed to resolve instruction-scope path: {error}"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err("Instruction-scope path is outside the authorized workspace".to_string());
        }
        candidate = if canonical.is_dir() {
            canonical
        } else {
            canonical
                .parent()
                .ok_or_else(|| "Instruction-scope target has no parent directory".to_string())?
                .to_path_buf()
        };
    } else {
        candidate = candidate
            .parent()
            .ok_or_else(|| "Instruction-scope target has no parent directory".to_string())?
            .to_path_buf();
        while !candidate.exists() {
            let parent = candidate
                .parent()
                .ok_or_else(|| "Instruction-scope path has no existing ancestor".to_string())?;
            if parent == candidate {
                return Err("Instruction-scope path has no existing ancestor".to_string());
            }
            candidate = parent.to_path_buf();
        }
        candidate = candidate
            .canonicalize()
            .map_err(|error| format!("Failed to resolve instruction-scope ancestor: {error}"))?;
    }
    if !candidate.starts_with(&canonical_root) {
        return Err("Instruction-scope path is outside the authorized workspace".to_string());
    }
    Ok(candidate)
}

fn scoped_instruction_files(root: &Path, paths: &[String]) -> Result<Vec<Value>, String> {
    if paths.len() > MAX_PATHS {
        return Err("Instruction-scope request contains too many target paths".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut total_bytes = 0usize;
    for target in paths {
        let directory = existing_scoped_directory(&canonical_root, target)?;
        let mut ancestors = Vec::new();
        let mut current = directory;
        while current != canonical_root {
            if !current.starts_with(&canonical_root) {
                return Err(
                    "Instruction-scope path is outside the authorized workspace".to_string()
                );
            }
            ancestors.push(current.clone());
            current = current
                .parent()
                .ok_or_else(|| "Instruction-scope path has no workspace ancestor".to_string())?
                .to_path_buf();
        }
        ancestors.reverse();
        for directory in ancestors {
            for file_name in ["AGENTS.md", "CLAUDE.md"] {
                let path = directory.join(file_name);
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(format!("Failed to inspect {}: {error}", path.display()));
                    }
                };
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "Refusing to load symlinked project instruction file: {}",
                        path.display()
                    ));
                }
                if !metadata.is_file() {
                    continue;
                }
                if metadata.len() > MAX_FILE_BYTES {
                    return Err(format!(
                        "{} exceeds the {} byte scoped-instruction limit",
                        path.display(),
                        MAX_FILE_BYTES
                    ));
                }
                let canonical = path
                    .canonicalize()
                    .map_err(|error| format!("Failed to resolve {}: {error}", path.display()))?;
                if !canonical.starts_with(&canonical_root) {
                    return Err(
                        "Scoped project instruction is outside the authorized workspace"
                            .to_string(),
                    );
                }
                let relative = canonical
                    .strip_prefix(&canonical_root)
                    .map_err(|_| {
                        "Scoped project instruction is outside the authorized workspace".to_string()
                    })?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !seen.insert(relative.clone()) {
                    continue;
                }
                if files.len() >= MAX_FILES {
                    return Err("Target paths require too many instruction files".to_string());
                }
                let content = fs::read_to_string(&canonical)
                    .map_err(|error| format!("Failed to read {}: {error}", canonical.display()))?;
                total_bytes = total_bytes.saturating_add(content.len());
                if total_bytes > MAX_TOTAL_BYTES {
                    return Err(
                        "Applicable project instructions exceed the total instruction limit"
                            .to_string(),
                    );
                }
                files.push(json!({ "path": relative, "content": content }));
            }
        }
    }
    Ok(files)
}

/// Read Host-authorized, nested directory instructions for worker path
/// preflight. This supplies context only; it does not grant file permissions.
pub(crate) fn resolve_instruction_scope_request(root: &Path, value: &Value) -> Value {
    let (session_id, run_id, tool_call_id, _, arguments, _) = match event_context(value) {
        Ok(context) => context,
        Err(error) => return fail_for_request(value, "pi.instruction_scope_invalid", error),
    };
    let paths = arguments
        .get("paths")
        .and_then(Value::as_array)
        .and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
        });
    let Some(paths) = paths else {
        return fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.instruction_scope_invalid",
            "Instruction-scope paths must be an array of strings.",
        );
    };
    match scoped_instruction_files(root, &paths) {
        Ok(files) => success_resolution(
            session_id,
            run_id,
            tool_call_id,
            json!({ "files": files }).to_string(),
        ),
        Err(error) => fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.instruction_scope_failed",
            error,
        ),
    }
}
