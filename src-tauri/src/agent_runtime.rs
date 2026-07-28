use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, RwLock},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

const ACP_MESSAGE_EVENT: &str = "melody://acp-message";
const ACP_STDERR_EVENT: &str = "melody://acp-stderr";
const AGENT_ARGS: [&str; 3] = ["agent", "--no-leader", "stdio"];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub phase: AgentPhase,
    pub binary_path: Option<String>,
    pub pid: Option<u32>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentPhase {
    #[default]
    Stopped,
    Starting,
    Running,
    Missing,
    Failed,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentRequest {
    pub cwd: String,
    pub binary_path: Option<String>,
}

#[derive(Clone, Default)]
pub struct AgentRuntime {
    inner: Arc<RuntimeInner>,
}

#[derive(Default)]
struct RuntimeInner {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    status: RwLock<AgentStatus>,
}

impl AgentRuntime {
    fn status(&self) -> AgentStatus {
        self.inner
            .status
            .read()
            .expect("agent status lock poisoned")
            .clone()
    }

    fn set_status(&self, status: AgentStatus) {
        *self
            .inner
            .status
            .write()
            .expect("agent status lock poisoned") = status;
    }

    async fn write_json(&self, value: &Value) -> Result<(), String> {
        let mut stdin = self.inner.stdin.lock().await;
        let writer = stdin
            .as_mut()
            .ok_or_else(|| "Melody sidecar is not running".to_string())?;
        let mut line = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        line.push(b'\n');
        writer
            .write_all(&line)
            .await
            .map_err(|error| format!("Failed to write ACP request: {error}"))?;
        writer
            .flush()
            .await
            .map_err(|error| format!("Failed to flush ACP request: {error}"))
    }
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
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(development_name),
    );
    candidates.into_iter().find(|path| path.is_file())
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
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

#[tauri::command]
pub fn agent_status(runtime: State<'_, AgentRuntime>) -> AgentStatus {
    runtime.status()
}

#[tauri::command]
pub async fn start_agent(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request: StartAgentRequest,
) -> Result<AgentStatus, String> {
    if matches!(runtime.status().phase, AgentPhase::Running) {
        return Ok(runtime.status());
    }

    let Some(binary) = resolve_binary(&app, request.binary_path.as_deref()) else {
        let status = AgentStatus {
            phase: AgentPhase::Missing,
            message: Some(
                "Bundled melody-pager is not available yet. Set MELODY_PAGER_PATH for development."
                    .to_string(),
            ),
            ..AgentStatus::default()
        };
        runtime.set_status(status.clone());
        return Ok(status);
    };

    runtime.set_status(AgentStatus {
        phase: AgentPhase::Starting,
        binary_path: Some(display_path(&binary)),
        ..AgentStatus::default()
    });

    let mut command = Command::new(&binary);
    command
        .args(AGENT_ARGS)
        .current_dir(&request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(home) = melody_home() {
        command
            .env("MELODY_HOME", &home)
            .env("GROK_HOME", home);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Failed to start melody-pager: {error}");
            runtime.set_status(AgentStatus {
                phase: AgentPhase::Failed,
                binary_path: Some(display_path(&binary)),
                message: Some(message.clone()),
                ..AgentStatus::default()
            });
            return Err(message);
        }
    };
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "melody-pager stdin was not piped".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "melody-pager stdout was not piped".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "melody-pager stderr was not piped".to_string())?;

    *runtime.inner.stdin.lock().await = Some(stdin);
    *runtime.inner.child.lock().await = Some(child);

    let running_status = AgentStatus {
        phase: AgentPhase::Running,
        binary_path: Some(display_path(&binary)),
        pid,
        message: Some("ACP stdio bridge connected".to_string()),
    };
    runtime.set_status(running_status.clone());

    let stdout_app = app.clone();
    let stdout_runtime = runtime.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let payload =
                serde_json::from_str::<Value>(&line).unwrap_or_else(|_| json!({ "raw": line }));
            let _ = stdout_app.emit(ACP_MESSAGE_EVENT, payload);
        }
        stdout_runtime.set_status(AgentStatus {
            phase: AgentPhase::Stopped,
            message: Some("ACP stdout closed".to_string()),
            ..AgentStatus::default()
        });
    });

    let stderr_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = stderr_app.emit(ACP_STDERR_EVENT, line);
        }
    });

    Ok(running_status)
}

#[tauri::command]
pub async fn send_acp(runtime: State<'_, AgentRuntime>, message: Value) -> Result<(), String> {
    runtime.write_json(&message).await
}

#[tauri::command]
pub async fn stop_agent(runtime: State<'_, AgentRuntime>) -> Result<AgentStatus, String> {
    runtime.inner.stdin.lock().await.take();
    if let Some(mut child) = runtime.inner.child.lock().await.take() {
        child
            .kill()
            .await
            .map_err(|error| format!("Failed to stop melody-pager: {error}"))?;
    }
    let status = AgentStatus::default();
    runtime.set_status(status.clone());
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_missing_binary_is_not_resolved() {
        assert!(resolve_explicit_binary(Some("/definitely/missing/melody-pager")).is_none());
    }

    #[test]
    fn agent_flags_follow_the_agent_subcommand() {
        assert_eq!(AGENT_ARGS, ["agent", "--no-leader", "stdio"]);
    }
}
