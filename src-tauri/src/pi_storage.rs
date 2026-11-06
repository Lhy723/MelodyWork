use std::{
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::agent_runtime::melody_home;

/// Return the app-owned directory used by the Pi worker for native session
/// JSONL. The worker receives the same path from `configure_worker_command`,
/// so cleanup never scans a user-selected arbitrary directory.
pub(crate) fn pi_session_root() -> Option<PathBuf> {
    melody_home().map(|home| home.join("pi-sessions"))
}

/// Keep this derivation byte-for-byte compatible with the worker's
/// `piSessionFileFor` helper. Product/session IDs never become path names.
pub(crate) fn pi_session_file_name(cwd: &str, product_session_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(cwd.as_bytes());
    digest.update([0]);
    digest.update(product_session_id.as_bytes());
    format!("session-{:x}.jsonl", digest.finalize())
}

pub(crate) fn pi_session_file_path(cwd: &str, product_session_id: &str) -> Option<PathBuf> {
    pi_session_root().map(|root| root.join(pi_session_file_name(cwd, product_session_id)))
}

fn remove_owned_file(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 Pi 会话文件失败：{error}")),
    };
    if metadata.file_type().is_dir() {
        return Err(format!("Pi 会话文件路径不是普通文件：{}", path.display()));
    }
    // remove_file does not follow a symlink; removing a malicious link itself
    // is safe and prevents it from being mistaken for an external history.
    fs::remove_file(path).map_err(|error| format!("删除 Pi 会话文件失败：{error}"))
}

/// Remove the canonical native session plus crash leftovers and explicit
/// pre-import backups belonging to that session. Only direct children whose
/// names are derived from the same opaque hash are considered.
pub(crate) fn remove_pi_session_artifacts(
    cwd: &str,
    product_session_id: &str,
) -> Result<(), String> {
    let Some(path) = pi_session_file_path(cwd, product_session_id) else {
        return Ok(());
    };
    let Some(root) = path.parent() else {
        return Ok(());
    };
    if !root.exists() {
        return Ok(());
    }

    remove_owned_file(&path)?;
    let Some(base_name) = path.file_name().and_then(|value| value.to_str()) else {
        return Ok(());
    };
    let prefix = format!("{base_name}.");
    let entries = fs::read_dir(root).map_err(|error| format!("读取 Pi 会话目录失败：{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取 Pi 会话目录项失败：{error}"))?;
        let candidate = entry.path();
        let Some(name) = candidate.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with(&prefix) && (name.contains(".pre-import-") || name.contains(".tmp-")) {
            remove_owned_file(&candidate)?;
        }
    }
    Ok(())
}
