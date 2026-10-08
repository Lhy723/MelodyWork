use std::{env, path::PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Engine status shared by the Pi worker supervisor. The vendored ACP engine
/// no longer exists as a runtime path, but the renderer status contract (and
/// the browser-preview fixture) still speaks this shape.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentStatus {
    pub phase: AgentPhase,
    pub binary_path: Option<String>,
    pub pid: Option<u32>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentPhase {
    #[default]
    Stopped,
    Starting,
    Running,
    Missing,
    Failed,
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "melody-pager.exe"
    } else {
        "melody-pager"
    }
}

fn resolve_explicit_binary(explicit: Option<&str>) -> Option<PathBuf> {
    explicit
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("MELODY_PAGER_PATH").map(PathBuf::from))
        .filter(|path| path.is_file())
}

/// Resolve the bundled melody CLI.
///
/// The vendored binary no longer acts as the agent engine, but it is still the
/// CLI behind marketplace plugin operations and `melody inspect`; it ships as
/// a sidecar for exactly that purpose.
pub(crate) fn resolve_binary(app: &AppHandle, explicit: Option<&str>) -> Option<PathBuf> {
    if let Some(binary) = resolve_explicit_binary(explicit) {
        return Some(binary);
    }

    let mut candidates = Vec::new();
    if let Ok(current_exe) = std::env::current_exe()
        && let Some(directory) = current_exe.parent()
    {
        candidates.push(directory.join(executable_name()));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(executable_name()));
    }
    let development_name = format!(
        "melody-pager-{}{}",
        env!("MELODY_TARGET_TRIPLE"),
        if cfg!(windows) { ".exe" } else { "" }
    );
    candidates.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(development_name),
    );
    candidates.into_iter().find(|path| path.is_file())
}

pub(crate) fn melody_home() -> Option<PathBuf> {
    if let Some(path) = env::var_os("MELODY_HOME") {
        return Some(PathBuf::from(path));
    }
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|path| path.join(".melody"))
}
