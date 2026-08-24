use std::path::Path;

use tauri::AppHandle;
use tokio::process::Command;

use crate::agent_runtime;

const MISSING_BINARY_MESSAGE: &str =
    "Bundled melody-pager is unavailable. Restart pnpm tauri dev so the sidecar is prepared.";

/// Builds every Melody sidecar command with the same binary and environment
/// setup. Callers still own command-specific arguments and error messages.
pub(crate) struct MelodyCommandRunner<'a> {
    app: &'a AppHandle,
}

impl<'a> MelodyCommandRunner<'a> {
    pub(crate) fn new(app: &'a AppHandle) -> Self {
        Self { app }
    }

    pub(crate) fn command(&self, args: &[&str], cwd: Option<&Path>) -> Result<Command, String> {
        let binary = agent_runtime::resolve_binary(self.app, None)
            .ok_or_else(|| MISSING_BINARY_MESSAGE.to_string())?;
        let mut command = Command::new(binary);
        command.args(args);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        if let Some(home) = agent_runtime::melody_home() {
            command.env("MELODY_HOME", &home).env("GROK_HOME", home);
        }
        Ok(command)
    }
}
