use std::{env, path::PathBuf};

use serde::Serialize;

/// Runtime status shared by the Pi worker supervisor and renderer.
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

pub(crate) fn melody_home() -> Option<PathBuf> {
    if let Some(path) = env::var_os("MELODY_HOME") {
        return Some(PathBuf::from(path));
    }
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|path| path.join(".melody"))
}
