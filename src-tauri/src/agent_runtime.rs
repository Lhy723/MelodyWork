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

use crate::{
    acp_policy::{
        ClientRequestAction, OutgoingMessage, PendingServerRequest, PendingServerRequests,
        ServerResponseAction, inspect_outgoing_message, inspect_server_response,
    },
    database::AppDatabase,
    workspace_access::{WorkspaceRegistry, confirm_action},
};

const ACP_MESSAGE_EVENT: &str = "melody://acp-message";
const ACP_STDERR_EVENT: &str = "melody://acp-stderr";
const AGENT_STATUS_EVENT: &str = "melody://agent-status";
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
    pending_server_requests: Mutex<PendingServerRequests>,
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

    async fn remember_server_request(&self, message: &Value) {
        self.inner
            .pending_server_requests
            .lock()
            .await
            .remember(message);
    }

    async fn take_server_request(&self, id: &Value) -> Option<PendingServerRequest> {
        self.inner.pending_server_requests.lock().await.take(id)
    }

    async fn put_server_request(&self, id: &Value, request: PendingServerRequest) {
        self.inner
            .pending_server_requests
            .lock()
            .await
            .restore(id, request);
    }

    async fn clear_server_requests(&self) {
        self.inner.pending_server_requests.lock().await.clear();
    }
}

fn emit_agent_status(app: &AppHandle, status: &AgentStatus) {
    let _ = app.emit(AGENT_STATUS_EVENT, status);
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
    registry: State<'_, WorkspaceRegistry>,
    runtime: State<'_, AgentRuntime>,
    request: StartAgentRequest,
) -> Result<AgentStatus, String> {
    if matches!(runtime.status().phase, AgentPhase::Running) {
        return Ok(runtime.status());
    }

    let cwd = registry.authorize(&request.cwd)?;

    // The renderer cannot select an arbitrary executable. Development builds
    // may still use MELODY_PAGER_PATH, which is supplied before the app starts.
    let Some(binary) = resolve_binary(&app, None) else {
        let status = AgentStatus {
            phase: AgentPhase::Missing,
            message: Some(
                "Bundled melody-pager is not available yet. Set MELODY_PAGER_PATH for development."
                    .to_string(),
            ),
            ..AgentStatus::default()
        };
        runtime.set_status(status.clone());
        emit_agent_status(&app, &status);
        return Ok(status);
    };

    let starting_status = AgentStatus {
        phase: AgentPhase::Starting,
        binary_path: Some(display_path(&binary)),
        ..AgentStatus::default()
    };
    runtime.set_status(starting_status.clone());
    emit_agent_status(&app, &starting_status);

    let mut command = Command::new(&binary);
    command
        .args(AGENT_ARGS)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(home) = melody_home() {
        command.env("MELODY_HOME", &home).env("GROK_HOME", home);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Failed to start melody-pager: {error}");
            let status = AgentStatus {
                phase: AgentPhase::Failed,
                binary_path: Some(display_path(&binary)),
                message: Some(message.clone()),
                ..AgentStatus::default()
            };
            runtime.set_status(status.clone());
            emit_agent_status(&app, &status);
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
    emit_agent_status(&app, &running_status);

    let stdout_app = app.clone();
    let stdout_runtime = runtime.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let payload =
                serde_json::from_str::<Value>(&line).unwrap_or_else(|_| json!({ "raw": line }));
            stdout_runtime.remember_server_request(&payload).await;
            let _ = stdout_app.emit(ACP_MESSAGE_EVENT, payload);
        }
        stdout_runtime.clear_server_requests().await;
        let status = AgentStatus {
            phase: AgentPhase::Stopped,
            message: Some("ACP stdout closed".to_string()),
            ..AgentStatus::default()
        };
        stdout_runtime.set_status(status.clone());
        emit_agent_status(&stdout_app, &status);
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

async fn confirm_permission_response(
    app: &AppHandle,
    database: Option<&AppDatabase>,
    pending: &PendingServerRequest,
) -> Result<(), String> {
    let trusted_rule = pending
        .session_id()
        .map(|session_id| {
            database
                .map(|database| {
                    database.has_allow_permission_for_acp_session(
                        session_id,
                        pending.title(),
                        pending.command(),
                    )
                })
                .unwrap_or(Ok(false))
        })
        .transpose()?
        .unwrap_or(false);
    if trusted_rule {
        return Ok(());
    }
    confirm_action(
        app,
        "确认执行 Melody 工具",
        format!(
            "Melody 请求执行以下操作：\n{}\n{}",
            pending.title(),
            pending.command()
        ),
    )
    .await
}

#[tauri::command]
pub async fn send_acp(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    runtime: State<'_, AgentRuntime>,
    message: Value,
) -> Result<(), String> {
    let outgoing = inspect_outgoing_message(&message)?;
    if let OutgoingMessage::Request(action) = outgoing {
        match action {
            ClientRequestAction::OpenSession { cwd, elevated_mode } => {
                registry.authorize(&cwd)?;
                if let Some(mode) = elevated_mode {
                    confirm_action(
                        &app,
                        "确认高权限 Melody 会话",
                        format!("允许在 {} 以“{}”权限模式打开会话吗？", cwd, mode),
                    )
                    .await?;
                }
            }
            ClientRequestAction::ChangePermissionMode {
                mode,
                requires_confirmation: true,
            } => {
                confirm_action(
                    &app,
                    "确认切换 Melody 权限模式",
                    format!("允许将权限模式切换为“{}”吗？", mode),
                )
                .await?;
            }
            ClientRequestAction::None
            | ClientRequestAction::ChangePermissionMode {
                requires_confirmation: false,
                ..
            } => {}
        }
        return runtime.write_json(&message).await;
    }

    let OutgoingMessage::Response { id } = outgoing else {
        unreachable!();
    };
    let pending = runtime
        .take_server_request(&id)
        .await
        .ok_or_else(|| "ACP response does not match a pending server request".to_string())?;
    let validation = async {
        if inspect_server_response(&message, &pending)? == ServerResponseAction::ConfirmPermission {
            let database = app.try_state::<AppDatabase>();
            confirm_permission_response(&app, database.as_deref(), &pending).await
        } else {
            Ok(())
        }
    }
    .await;
    if let Err(error) = validation {
        runtime.put_server_request(&id, pending).await;
        return Err(error);
    }
    runtime.write_json(&message).await
}

#[tauri::command]
pub async fn stop_agent(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
) -> Result<AgentStatus, String> {
    runtime.inner.stdin.lock().await.take();
    if let Some(mut child) = runtime.inner.child.lock().await.take() {
        child
            .kill()
            .await
            .map_err(|error| format!("Failed to stop melody-pager: {error}"))?;
    }
    let status = AgentStatus::default();
    runtime.set_status(status.clone());
    emit_agent_status(&app, &status);
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
