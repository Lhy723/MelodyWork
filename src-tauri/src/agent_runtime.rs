use std::{
    collections::{HashMap, HashSet},
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
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
    database::AppDatabase,
    workspace_access::{WorkspaceRegistry, confirm_action},
};

const ACP_MESSAGE_EVENT: &str = "melody://acp-message";
const ACP_STDERR_EVENT: &str = "melody://acp-stderr";
const AGENT_STATUS_EVENT: &str = "melody://agent-status";
const AGENT_ARGS: [&str; 3] = ["agent", "--no-leader", "stdio"];
const MAX_ACP_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_PENDING_SERVER_REQUESTS: usize = 256;
const PENDING_SERVER_REQUEST_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug)]
struct PendingServerRequest {
    method: String,
    session_id: Option<String>,
    title: String,
    command: String,
    allow_option_ids: HashSet<String>,
    reject_option_ids: HashSet<String>,
    created_at: Instant,
}

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
    pending_server_requests: Mutex<HashMap<String, PendingServerRequest>>,
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
        let Some(id) = message.get("id") else {
            return;
        };
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        let Ok(key) = serde_json::to_string(id) else {
            return;
        };
        let params = message.get("params").and_then(Value::as_object);
        let tool = params
            .and_then(|params| params.get("toolCall").or_else(|| params.get("tool_call")))
            .and_then(Value::as_object);
        let title = tool
            .and_then(|tool| tool.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("工具调用")
            .trim()
            .to_string();
        let command = tool
            .and_then(|tool| tool.get("command"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let mut allow_option_ids = HashSet::new();
        let mut reject_option_ids = HashSet::new();
        if method == "session/request_permission" {
            if let Some(options) = params
                .and_then(|params| params.get("options"))
                .and_then(Value::as_array)
            {
                for option in options {
                    let Some(option) = option.as_object() else {
                        continue;
                    };
                    let Some(option_id) = option
                        .get("optionId")
                        .or_else(|| option.get("option_id"))
                        .and_then(Value::as_str)
                    else {
                        continue;
                    };
                    let kind = option
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if kind.starts_with("allow") {
                        allow_option_ids.insert(option_id.to_string());
                    } else if kind.starts_with("reject") {
                        reject_option_ids.insert(option_id.to_string());
                    }
                }
            }
        }
        let session_id = params
            .and_then(|params| params.get("sessionId").or_else(|| params.get("session_id")))
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut pending = self.inner.pending_server_requests.lock().await;
        let now = Instant::now();
        pending.retain(|_, request| {
            now.saturating_duration_since(request.created_at) < PENDING_SERVER_REQUEST_TTL
        });
        if pending.len() >= MAX_PENDING_SERVER_REQUESTS {
            if let Some(oldest) = pending
                .iter()
                .min_by_key(|(_, request)| request.created_at)
                .map(|(key, _)| key.clone())
            {
                pending.remove(&oldest);
            }
        }
        pending.insert(
            key,
            PendingServerRequest {
                method: method.to_string(),
                session_id,
                title,
                command,
                allow_option_ids,
                reject_option_ids,
                created_at: now,
            },
        );
    }

    async fn take_server_request(&self, id: &Value) -> Option<PendingServerRequest> {
        let key = serde_json::to_string(id).ok()?;
        self.inner.pending_server_requests.lock().await.remove(&key)
    }

    async fn put_server_request(&self, id: &Value, request: PendingServerRequest) {
        if let Ok(key) = serde_json::to_string(id) {
            self.inner
                .pending_server_requests
                .lock()
                .await
                .insert(key, request);
        }
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

fn value_bool(object: Option<&serde_json::Map<String, Value>>, names: &[&str]) -> bool {
    names.iter().any(|name| {
        object
            .and_then(|object| object.get(*name))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    })
}

fn acp_session_id(params: Option<&serde_json::Map<String, Value>>) -> Option<&str> {
    params
        .and_then(|params| params.get("sessionId").or_else(|| params.get("session_id")))
        .and_then(Value::as_str)
}

fn allowed_outgoing_method(method: &str) -> bool {
    matches!(
        method,
        "initialize"
            | "authenticate"
            | "session/new"
            | "session/load"
            | "session/prompt"
            | "session/cancel"
            | "session/set_model"
            | "session/set_mode"
            | "x.ai/queue/interject"
            | "x.ai/yolo_mode_changed"
    )
}

async fn confirm_permission_response(
    app: &AppHandle,
    database: Option<&AppDatabase>,
    pending: &PendingServerRequest,
) -> Result<(), String> {
    let trusted_rule = pending
        .session_id
        .as_deref()
        .map(|session_id| {
            database
                .map(|database| {
                    database.has_allow_permission_for_acp_session(
                        session_id,
                        &pending.title,
                        &pending.command,
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
            pending.title, pending.command
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
    let encoded = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_ACP_MESSAGE_BYTES {
        return Err("ACP message exceeds the 1 MB safety limit".to_string());
    }
    let object = message
        .as_object()
        .ok_or_else(|| "ACP message must be a JSON object".to_string())?;
    if object.contains_key("raw") {
        return Err("Raw ACP messages are not accepted".to_string());
    }
    if let Some(version) = object.get("jsonrpc") {
        if version.as_str() != Some("2.0") {
            return Err("Only JSON-RPC 2.0 ACP messages are accepted".to_string());
        }
    }

    if let Some(method) = object.get("method").and_then(Value::as_str) {
        if !allowed_outgoing_method(method) {
            return Err(format!("ACP method is not allowed: {method}"));
        }
        let params = object.get("params").and_then(Value::as_object);
        match method {
            "session/new" | "session/load" => {
                let cwd = params
                    .and_then(|params| params.get("cwd"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| "ACP session requests must include cwd".to_string())?;
                registry.authorize(cwd)?;
                if let Some(servers) = params.and_then(|params| {
                    params
                        .get("mcpServers")
                        .or_else(|| params.get("mcp_servers"))
                }) {
                    if !servers.as_array().is_some_and(Vec::is_empty) {
                        return Err(
                            "ACP MCP server injection is disabled; configure servers in Melody instead"
                                .to_string(),
                        );
                    }
                }
                let meta = params
                    .and_then(|params| params.get("_meta"))
                    .and_then(Value::as_object);
                if value_bool(meta, &["yoloMode", "yolo_mode", "autoMode", "auto_mode"]) {
                    let mode = if value_bool(meta, &["yoloMode", "yolo_mode"]) {
                        "always-approve"
                    } else {
                        "auto"
                    };
                    confirm_action(
                        &app,
                        "确认高权限 Melody 会话",
                        format!("允许在 {} 以“{}”权限模式打开会话吗？", cwd, mode),
                    )
                    .await?;
                }
            }
            "session/prompt"
            | "session/cancel"
            | "session/set_model"
            | "session/set_mode" => {
                if acp_session_id(params).is_none() {
                    return Err(format!("ACP {method} requests must include sessionId"));
                }
            }
            "x.ai/queue/interject" => {
                if acp_session_id(params).is_none() {
                    return Err("ACP interject requests must include sessionId".to_string());
                }
            }
            "x.ai/yolo_mode_changed" => {
                let mode = params
                    .and_then(|params| {
                        params
                            .get("permission_mode")
                            .or_else(|| params.get("permissionMode"))
                    })
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Permission mode is missing".to_string())?;
                if !matches!(mode, "ask" | "auto" | "always-approve") {
                    return Err("Permission mode is invalid".to_string());
                }
                if mode != "ask" {
                    confirm_action(
                        &app,
                        "确认切换 Melody 权限模式",
                        format!("允许将权限模式切换为“{}”吗？", mode),
                    )
                    .await?;
                }
            }
            _ => {}
        }
        return runtime.write_json(&message).await;
    }

    let id = object
        .get("id")
        .ok_or_else(|| "ACP responses must include id".to_string())?;
    if !object.contains_key("result") && !object.contains_key("error") {
        return Err("ACP message must contain method, result, or error".to_string());
    }
    if object.contains_key("result") && object.contains_key("error") {
        return Err("ACP response cannot contain both result and error".to_string());
    }
    let pending = runtime
        .take_server_request(id)
        .await
        .ok_or_else(|| "ACP response does not match a pending server request".to_string())?;
    let validation = async {
        if pending.method == "session/request_permission" {
            if object.contains_key("error") {
                return Ok(());
            }
            let result = object
                .get("result")
                .and_then(Value::as_object)
                .ok_or_else(|| "Permission response result is invalid".to_string())?;
            let outcome = result
                .get("outcome")
                .and_then(Value::as_object)
                .ok_or_else(|| "Permission response outcome is invalid".to_string())?;
            if outcome.get("outcome").and_then(Value::as_str) != Some("selected") {
                return Err("Permission response must select an option".to_string());
            }
            let option_id = outcome
                .get("optionId")
                .or_else(|| outcome.get("option_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| "Permission response optionId is missing".to_string())?;
            if pending.reject_option_ids.contains(option_id) {
                return Ok(());
            }
            if !pending.allow_option_ids.contains(option_id) {
                return Err("Permission response selected an unknown option".to_string());
            }
            let database = app.try_state::<AppDatabase>();
            confirm_permission_response(&app, database.as_deref(), &pending).await
        } else if pending.method == "x.ai/exit_plan_mode" {
            if object.contains_key("error") {
                return Ok(());
            }
            let outcome = object
                .get("result")
                .and_then(|result| result.get("outcome"))
                .and_then(Value::as_str)
                .ok_or_else(|| "Plan response outcome is missing".to_string())?;
            if matches!(
                outcome,
                "approved" | "cancelled" | "abandoned" | "changes-requested"
            ) {
                Ok(())
            } else {
                Err("Plan response outcome is invalid".to_string())
            }
        } else {
            Err(format!(
                "Responses to ACP method {} are not supported",
                pending.method
            ))
        }
    }
    .await;
    if let Err(error) = validation {
        runtime.put_server_request(id, pending).await;
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

    #[test]
    fn session_cancel_is_allowed_for_stuck_turn_recovery() {
        assert!(allowed_outgoing_method("session/cancel"));
    }
}
