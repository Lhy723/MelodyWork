use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::{Mutex, oneshot},
    time::{Duration, timeout},
};

use crate::{
    agent_runtime::{AgentPhase, AgentStatus, melody_home},
    config_runtime::{
        pi_load_envrc, pi_model_network_policy, pi_prompt_paths, pi_resource_manifest,
        pi_respect_gitignore, pi_skill_paths, pi_terminal_policy,
    },
    database::{
        AppDatabase, PiEventPersistence, append_pi_event, begin_pi_session_fork,
        permission_decision_for_session, validate_pi_migration_import, validate_pi_session_command,
        validate_pi_session_import, validate_pi_session_open, validate_pi_session_workspace,
    },
    pi_codebase_runtime,
    pi_hook_runtime::{self, HookEvent, HookRunResult},
    pi_lsp_runtime,
    pi_mcp_runtime::PiMcpRuntime,
    pi_memory_runtime,
    pi_model_config::{self, PreparedPiModels},
    pi_tool_gateway, pi_web_runtime,
    workspace_access::WorkspaceRegistry,
};

pub(crate) const PI_AGENT_EVENT: &str = "melody://pi-agent-event";
pub(crate) const PI_AGENT_STDERR: &str = "melody://pi-agent-stderr";
pub(crate) const PI_AGENT_STATUS: &str = "melody://pi-agent-status";

const AGENT_PROTOCOL_VERSION: u64 = 1;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_SEEN_EVENT_IDS: usize = 4096;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const CHILD_REAP_TIMEOUT: Duration = Duration::from_secs(2);
const ENVRC_TIMEOUT: Duration = Duration::from_secs(5);
const ENVRC_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const ENVRC_MAX_ENTRIES: usize = 256;
const ENVRC_MAX_KEY_BYTES: usize = 128;
const ENVRC_MAX_VALUE_BYTES: usize = 16 * 1024;
const MEMORY_TRANSCRIPT_MAX_MESSAGES: usize = 128;
const MEMORY_TRANSCRIPT_MAX_MESSAGE_BYTES: usize = 16 * 1024;
const MEMORY_TRANSCRIPT_MAX_BYTES: usize = 512 * 1024;

fn valid_envrc_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn denied_envrc_name(value: &str) -> bool {
    matches!(
        value,
        "LD_PRELOAD" | "DYLD_INSERT_LIBRARIES" | "NODE_OPTIONS" | "RUSTFLAGS" | "BASH_ENV"
    ) || value.starts_with("DYLD_")
}

fn parse_envrc_json(output: &[u8]) -> Result<Vec<(String, String)>, String> {
    if output.len() > ENVRC_MAX_OUTPUT_BYTES {
        return Err("direnv 输出超过 1 MB 限制。".to_string());
    }
    let value: Value = serde_json::from_slice(output)
        .map_err(|error| format!("direnv 返回的环境不是有效 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "direnv export json 必须返回一个对象。".to_string())?;
    if object.len() > ENVRC_MAX_ENTRIES {
        return Err(format!(
            ".envrc 导出的环境变量超过 {ENVRC_MAX_ENTRIES} 个。"
        ));
    }
    let mut entries = Vec::with_capacity(object.len());
    for (name, value) in object {
        if name.len() > ENVRC_MAX_KEY_BYTES || !valid_envrc_name(name) || denied_envrc_name(name) {
            continue;
        }
        let Some(value) = value.as_str() else {
            continue;
        };
        if value.len() > ENVRC_MAX_VALUE_BYTES {
            return Err(format!(".envrc 环境变量 {name} 超过大小限制。"));
        }
        entries.push((name.clone(), value.to_string()));
    }
    Ok(entries)
}

async fn load_envrc(cwd: &Path) -> Result<Vec<(String, String)>, String> {
    if !pi_load_envrc(&cwd.to_string_lossy()) || !cwd.join(".envrc").is_file() {
        return Ok(Vec::new());
    }
    let direnv = env::var_os("MELODY_DIRENV_PATH").unwrap_or_else(|| "direnv".into());
    let mut command = Command::new(direnv);
    command
        .args(["export", "json"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for key in INHERITED_WORKER_ENV {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env("DIRENV_LOG_FORMAT", "");
    let output = timeout(ENVRC_TIMEOUT, command.output())
        .await
        .map_err(|_| "direnv 加载 .envrc 超时（5 秒）。".to_string())?
        .map_err(|error| format!("无法执行 direnv export json：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "direnv 加载 .envrc 失败（{}）：{}",
            output.status,
            bounded_stderr(&stderr)
        ));
    }
    parse_envrc_json(&output.stdout)
}

fn bounded_stderr(value: &str) -> String {
    let value = value.trim();
    if value.len() <= 512 {
        return value.to_string();
    }
    let mut end = 512;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

/// The worker deliberately starts from an empty environment so ambient
/// secrets, package-manager settings and arbitrary process flags cannot leak
/// into the Pi sidecar.  Network transports and custom provider certificates
/// are the small set of user/system integration points that still need to
/// cross that boundary for an otherwise identical model configuration to
/// work (corporate proxies, air-gapped gateways, and private CAs).
const INHERITED_WORKER_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "MELODY_AUTO_COMPACT_THRESHOLD_PERCENT",
    "MELODY_RESPECT_GITIGNORE",
    "MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON",
    "MELODY_PI_GOAL_POLICY_JSON",
];

const SESSION_BOUND_PI_COMMANDS: &[&str] = &[
    "session.close",
    "session.configure",
    "session.fork",
    "turn.submit",
    "turn.steer",
    "turn.follow_up",
    "turn.cancel",
    "interaction.resolve",
    "tool.resolve",
    "task.wait",
    "task.cancel",
    "task.continue",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPiWorkerRequest {
    pub cwd: String,
}

#[derive(Clone, Default)]
pub struct PiWorkerRuntime {
    inner: Arc<PiWorkerInner>,
}

struct PiWorkerInner {
    operation: Mutex<()>,
    process: Mutex<Option<WorkerProcess>>,
    /// Host-side memory lifecycle state keyed by the stable product session.
    /// The worker itself only emits normalized events; keeping this state in
    /// the supervisor prevents child Pi sessions from crossing workspace or
    /// persistence boundaries.
    memory_transcripts: Mutex<HashMap<String, MemoryTranscript>>,
    memory_injected_sessions: Mutex<HashSet<String>>,
    status: RwLock<AgentStatus>,
    next_generation: AtomicU64,
    active_generation: AtomicU64,
    /// Host-initiated turns waiting for the worker to accept or reject them.
    /// Keyed by the `promptId` the Host generated, so a scheduled dispatch can
    /// tell "the worker took it" from "the worker refused it" instead of
    /// journaling an optimistic success.
    pending_dispatches: std::sync::Mutex<HashMap<String, PendingDispatch>>,
    /// Last `configRevision` the worker reported per product session. A
    /// `turn.submit` is rejected when the revision is stale, so the Host has to
    /// follow the same optimistic-concurrency token the renderer follows.
    session_revisions: std::sync::Mutex<HashMap<String, i64>>,
}

/// A Host-initiated turn awaiting the worker's acknowledgement.
struct PendingDispatch {
    request_id: String,
    completion: oneshot::Sender<TurnDispatchOutcome>,
}

/// Result of asking the worker to start a Host-initiated turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TurnDispatchOutcome {
    /// The worker emitted `run.accepted` for this prompt.
    Accepted,
    /// The worker refused the command with a structured error.
    Rejected { code: String, message: String },
    /// No acknowledgement arrived before the deadline; the turn may or may not
    /// have started, so the caller must not report success.
    Unacknowledged,
}

/// How long a Host-initiated turn may take to be acknowledged.
const DISPATCH_ACK_TIMEOUT: Duration = Duration::from_secs(15);
/// Bounded in-flight Host-initiated turns; a dispatcher that exceeds this is
/// backing up and must be told to slow down rather than queue without limit.
const MAX_PENDING_DISPATCHES: usize = 32;

#[derive(Clone, Debug, Default)]
struct MemoryTranscript {
    cwd: PathBuf,
    messages: Vec<pi_memory_runtime::SessionMemoryMessage>,
    total_bytes: usize,
}

struct WorkerProcess {
    generation: u64,
    binary_path: PathBuf,
    cwd: PathBuf,
    pid: Option<u32>,
    child: Child,
    stdin: tokio::process::ChildStdin,
    handshake: Option<oneshot::Sender<Result<(), String>>>,
    ready: bool,
    worker_epoch: Option<String>,
    last_seq: Option<u64>,
    /// Keep a bounded payload cache so an immediate duplicate can be ignored
    /// before the strict sequence check. The database remains the authority
    /// across worker restarts and detects duplicates that are no longer in
    /// this in-memory window.
    seen_events: VecDeque<(String, Value)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventAcceptance {
    New,
    Duplicate,
}

impl Default for PiWorkerInner {
    fn default() -> Self {
        Self {
            operation: Mutex::new(()),
            process: Mutex::new(None),
            memory_transcripts: Mutex::new(HashMap::new()),
            memory_injected_sessions: Mutex::new(HashSet::new()),
            status: RwLock::new(AgentStatus::default()),
            next_generation: AtomicU64::new(0),
            active_generation: AtomicU64::new(0),
            pending_dispatches: std::sync::Mutex::new(HashMap::new()),
            session_revisions: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl PiWorkerRuntime {
    fn status(&self) -> AgentStatus {
        self.inner
            .status
            .read()
            .expect("Pi worker status lock poisoned")
            .clone()
    }

    fn set_status(&self, status: AgentStatus) {
        *self
            .inner
            .status
            .write()
            .expect("Pi worker status lock poisoned") = status;
    }

    pub(crate) fn active_generation(&self) -> u64 {
        self.inner.active_generation.load(Ordering::Acquire)
    }

    pub(crate) async fn worker_cwd(&self, generation: u64) -> Result<PathBuf, String> {
        let process = self.inner.process.lock().await;
        process
            .as_ref()
            .filter(|process| process.generation == generation)
            .map(|process| process.cwd.clone())
            .ok_or_else(|| "Pi worker is not running".to_string())
    }

    /// Claim the first turn of a product session and prepend a Host-owned
    /// memory reminder when configured. The claim is made before the blocking
    /// search so two concurrent renderer commands cannot inject the reminder
    /// twice; a search failure is reported to the caller but never mutates the
    /// prompt a second time.
    async fn maybe_inject_memory(&self, command: &mut Value, cwd: &Path) -> Result<(), String> {
        let Some(command_object) = command.get("command").and_then(Value::as_object) else {
            return Ok(());
        };
        if command_object.get("type").and_then(Value::as_str) != Some("turn.submit") {
            return Ok(());
        }
        let Some(session_id) = command_object
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            return Ok(());
        };
        let should_inject = self
            .inner
            .memory_injected_sessions
            .lock()
            .await
            .insert(session_id.to_string());
        if !should_inject {
            return Ok(());
        }
        let query = command_object
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let cwd = cwd.to_path_buf();
        let result = tauri::async_runtime::spawn_blocking(move || {
            pi_memory_runtime::initial_injection(&cwd, &query)
        })
        .await
        .map_err(|error| format!("Memory initial-injection worker failed: {error}"))??;
        let Some(context) = result else {
            return Ok(());
        };
        let Some(command_object) = command.get_mut("command").and_then(Value::as_object_mut) else {
            return Ok(());
        };
        let content = command_object
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        command_object.insert(
            "content".to_string(),
            Value::String(format!("{context}\n\n{content}")),
        );
        Ok(())
    }

    /// Observe normalized root-session events for the Host-owned memory
    /// lifecycle. Child streams carry a distinct `streamSessionId` and are
    /// intentionally excluded so their private context is not mixed into the
    /// product session's transcript.
    async fn observe_memory_event(
        &self,
        app: &AppHandle,
        value: &Value,
        worker_cwd: Option<&Path>,
    ) {
        let Some(session_id) = value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            return;
        };
        if value
            .get("streamSessionId")
            .and_then(Value::as_str)
            .is_some_and(|stream| stream != session_id)
        {
            return;
        }
        let Some(event) = value.get("event").and_then(Value::as_object) else {
            return;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("message.completed") => {
                let Some(role) = event
                    .get("role")
                    .and_then(Value::as_str)
                    .filter(|role| matches!(*role, "user" | "assistant"))
                else {
                    return;
                };
                let Some(content) = event.get("content").and_then(Value::as_str) else {
                    return;
                };
                let content = pi_memory_runtime::strip_injected_context(content)
                    .trim()
                    .to_string();
                if content.is_empty() {
                    return;
                }
                let Some(cwd) = worker_cwd else {
                    return;
                };
                let message_id = event
                    .get("messageId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("message")
                    .to_string();
                let mut transcripts = self.inner.memory_transcripts.lock().await;
                let transcript = transcripts
                    .entry(session_id.to_string())
                    .or_insert_with(|| MemoryTranscript {
                        cwd: cwd.to_path_buf(),
                        ..MemoryTranscript::default()
                    });
                let bounded = bound_session_text(&content, MEMORY_TRANSCRIPT_MAX_MESSAGE_BYTES);
                if let Some(index) = transcript
                    .messages
                    .iter()
                    .position(|message| message.id == message_id)
                {
                    let previous_bytes = transcript.messages[index].content.len();
                    let base_bytes = transcript.total_bytes.saturating_sub(previous_bytes);
                    let available = MEMORY_TRANSCRIPT_MAX_BYTES.saturating_sub(base_bytes);
                    if available == 0 {
                        return;
                    }
                    let bounded = bound_session_text(&bounded, available);
                    transcript.messages[index].role = role.to_string();
                    transcript.messages[index].content = bounded.clone();
                    transcript.total_bytes = base_bytes.saturating_add(bounded.len());
                } else if transcript.messages.len() < MEMORY_TRANSCRIPT_MAX_MESSAGES {
                    let available =
                        MEMORY_TRANSCRIPT_MAX_BYTES.saturating_sub(transcript.total_bytes);
                    if available == 0 {
                        return;
                    }
                    let bounded = bound_session_text(&bounded, available);
                    transcript.total_bytes = transcript.total_bytes.saturating_add(bounded.len());
                    transcript
                        .messages
                        .push(pi_memory_runtime::SessionMemoryMessage {
                            id: message_id,
                            role: role.to_string(),
                            content: bounded,
                        });
                }
            }
            Some("session.closed") => {
                let transcript = self
                    .inner
                    .memory_transcripts
                    .lock()
                    .await
                    .remove(session_id);
                let Some(transcript) = transcript else {
                    return;
                };
                let session_id = session_id.to_string();
                match tauri::async_runtime::spawn_blocking(move || {
                    pi_memory_runtime::save_session_transcript(
                        &transcript.cwd,
                        &session_id,
                        &transcript.messages,
                    )
                })
                .await
                {
                    Ok(Ok(Some(path))) => {
                        let _ = app.emit(
                            PI_AGENT_STDERR,
                            format!("Pi memory session transcript saved: {}", path.display()),
                        );
                    }
                    Ok(Ok(None)) => {}
                    Ok(Err(error)) => {
                        let _ =
                            app.emit(PI_AGENT_STDERR, format!("Pi memory save skipped: {error}"));
                    }
                    Err(error) => {
                        let _ = app.emit(
                            PI_AGENT_STDERR,
                            format!("Pi memory save worker failed: {error}"),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    async fn flush_memory_transcripts(&self, app: &AppHandle) {
        let transcripts = std::mem::take(&mut *self.inner.memory_transcripts.lock().await);
        for (session_id, transcript) in transcripts {
            match tauri::async_runtime::spawn_blocking(move || {
                pi_memory_runtime::save_session_transcript(
                    &transcript.cwd,
                    &session_id,
                    &transcript.messages,
                )
            })
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    let _ = app.emit(
                        PI_AGENT_STDERR,
                        format!("Pi memory shutdown save failed: {error}"),
                    );
                }
                Err(error) => {
                    let _ = app.emit(
                        PI_AGENT_STDERR,
                        format!("Pi memory shutdown save worker failed: {error}"),
                    );
                }
            }
        }
    }

    async fn reset_memory_session(&self, session_id: &str) {
        self.inner
            .memory_injected_sessions
            .lock()
            .await
            .remove(session_id);
        self.inner
            .memory_transcripts
            .lock()
            .await
            .remove(session_id);
    }

    async fn forget_memory_injection(&self, session_id: &str) {
        self.inner
            .memory_injected_sessions
            .lock()
            .await
            .remove(session_id);
    }

    async fn clear_memory_state(&self) {
        self.inner.memory_injected_sessions.lock().await.clear();
        self.inner.memory_transcripts.lock().await.clear();
    }

    async fn write_frame(
        &self,
        generation: u64,
        frame: &[u8],
        require_ready: bool,
    ) -> Result<(), String> {
        let mut process = self.inner.process.lock().await;
        let process = process
            .as_mut()
            .filter(|process| process.generation == generation)
            .ok_or_else(|| "Pi worker is not running".to_string())?;
        if require_ready && !process.ready {
            return Err("Pi worker handshake has not completed".to_string());
        }
        process
            .stdin
            .write_all(frame)
            .await
            .map_err(|error| format!("Failed to write Pi worker frame: {error}"))?;
        process
            .stdin
            .flush()
            .await
            .map_err(|error| format!("Failed to flush Pi worker frame: {error}"))
    }

    /// Refresh the Host-projected Skill/command manifest for a running worker.
    ///
    /// The worker process intentionally starts with a minimal environment, so
    /// its root manifest is a startup snapshot. Configuration changes (for
    /// example enabling a disabled Skill) must cross the same authenticated
    /// pipe instead of mutating process environment or allowing renderer
    /// paths to reach Pi directly.
    pub(crate) async fn refresh_resources_if_workspace(&self, cwd: &Path) -> Result<(), String> {
        let generation = self.active_generation();
        if generation == 0 {
            return Ok(());
        }
        let worker_cwd = self.worker_cwd(generation).await?;
        if worker_cwd != cwd {
            return Err(
                "Pi worker is bound to a different workspace; resources were not refreshed"
                    .to_string(),
            );
        }
        let manifest = pi_resource_manifest(&cwd.to_string_lossy())?;
        let frame = encode_command(&json!({
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "requestId": format!("pi-resources-{}", uuid::Uuid::new_v4()),
            "command": {
                "type": "session.resources.refresh",
                "manifest": manifest,
            }
        }))?;
        self.write_frame(generation, &frame, true).await
    }

    /// Rebuild and push the Host-projected Pi model catalog for the active
    /// workspace. Model credentials are short-lived values carried only over
    /// this local pipe; the worker applies them to its in-memory environment
    /// before asking Pi's public ModelRuntime to reload the catalog.
    pub(crate) async fn refresh_models_if_workspace(&self, cwd: &Path) -> Result<(), String> {
        let generation = self.active_generation();
        if generation == 0 {
            return Ok(());
        }
        let worker_cwd = self.worker_cwd(generation).await?;
        if worker_cwd != cwd {
            return Err(
                "Pi worker is bound to a different workspace; models were not refreshed"
                    .to_string(),
            );
        }
        // A managed MELODY_PI_MODELS_PATH is deliberately outside Melody's
        // projection. Its owner is responsible for refreshing the file and
        // credentials, so do not overwrite or partially sync it here.
        let Some(prepared) = prepare_worker_models(cwd).await? else {
            return Ok(());
        };
        let credentials = prepared
            .credentials
            .iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect::<Vec<_>>();
        let frame = encode_command(&json!({
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "requestId": format!("pi-models-sync-{}", uuid::Uuid::new_v4()),
            "command": {
                "type": "runtime.models.sync",
                "providerIds": prepared.provider_ids,
                "credentials": credentials,
            }
        }))?;
        self.write_frame(generation, &frame, true).await
    }

    async fn accept_event(
        &self,
        generation: u64,
        value: &Value,
    ) -> Result<EventAcceptance, String> {
        let mut process = self.inner.process.lock().await;
        let process = process
            .as_mut()
            .filter(|process| process.generation == generation)
            .ok_or_else(|| "Pi worker generation is no longer active".to_string())?;
        let event_id = value
            .get("eventId")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "Pi worker eventId must be a non-empty string".to_string())?;
        if let Some((_, previous)) = process.seen_events.iter().find(|(id, _)| id == event_id) {
            if previous != value {
                return Err(format!(
                    "Pi worker event {event_id} was replayed with a different payload"
                ));
            }
            return Ok(EventAcceptance::Duplicate);
        }
        let ready_event =
            validate_event_metadata(value, &mut process.worker_epoch, &mut process.last_seq)?;
        process
            .seen_events
            .push_back((event_id.to_string(), value.clone()));
        while process.seen_events.len() > MAX_SEEN_EVENT_IDS {
            process.seen_events.pop_front();
        }
        if ready_event {
            process.ready = true;
            if let Some(handshake) = process.handshake.take() {
                let _ = handshake.send(Ok(()));
            }
        }
        Ok(EventAcceptance::New)
    }

    /// Complete a Host-initiated dispatch from an accepted worker event.
    ///
    /// This is the only place that decides whether a scheduled turn really
    /// started, so the audit journal never records an optimistic success.
    fn observe_dispatch_event(&self, value: &Value) {
        let Some(event) = value.get("event").and_then(Value::as_object) else {
            return;
        };
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type == "runtime.error" {
            let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let error = event.get("error");
            let code = error
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("pi.worker_error")
                .to_string();
            let message = error
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Pi worker rejected the command")
                .to_string();
            self.complete_dispatch_by_request(&request_id.to_string(), |_| {
                TurnDispatchOutcome::Rejected { code, message }
            });
            return;
        }
        // The worker reports its authoritative configuration revision on open
        // and on every configuration change.
        if matches!(
            event_type,
            "session.opened" | "session.configured" | "session.imported"
        ) && let (Some(session_id), Some(revision)) = (
            value.get("sessionId").and_then(Value::as_str),
            event.get("revision").and_then(Value::as_i64),
        ) {
            if let Ok(mut revisions) = self.inner.session_revisions.lock() {
                revisions.insert(session_id.to_string(), revision);
            }
        }
        if event_type != "run.accepted" {
            return;
        }
        let Some(prompt_id) = event.get("promptId").and_then(Value::as_str) else {
            return;
        };
        if let Ok(mut pending) = self.inner.pending_dispatches.lock()
            && let Some(dispatch) = pending.remove(prompt_id)
        {
            let _ = dispatch.completion.send(TurnDispatchOutcome::Accepted);
        }
    }

    fn complete_dispatch_by_request<F>(&self, request_id: &str, outcome: F)
    where
        F: FnOnce(&PendingDispatch) -> TurnDispatchOutcome,
    {
        let Ok(mut pending) = self.inner.pending_dispatches.lock() else {
            return;
        };
        let matched = pending
            .iter()
            .find(|(_, dispatch)| dispatch.request_id == request_id)
            .map(|(prompt_id, _)| prompt_id.clone());
        if let Some(prompt_id) = matched
            && let Some(dispatch) = pending.remove(&prompt_id)
        {
            let outcome = outcome(&dispatch);
            let _ = dispatch.completion.send(outcome);
        }
    }

    /// Drop all dispatch bookkeeping. Called when a generation ends: pending
    /// acknowledgements from a dead worker must not be treated as accepted, and
    /// a new worker reports revisions from zero.
    fn clear_dispatch_state(&self) {
        if let Ok(mut pending) = self.inner.pending_dispatches.lock() {
            for (_, dispatch) in pending.drain() {
                let _ = dispatch
                    .completion
                    .send(TurnDispatchOutcome::Unacknowledged);
            }
        }
        if let Ok(mut revisions) = self.inner.session_revisions.lock() {
            revisions.clear();
        }
    }

    /// Submit a Host-initiated turn and wait for the worker's acknowledgement.
    ///
    /// The caller supplies the fully built command; this only manages the
    /// acknowledgement channel, so a rejected or unanswered dispatch is
    /// reported as such instead of being journaled as a success.
    pub(crate) async fn submit_and_await(
        &self,
        generation: u64,
        command: &Value,
        prompt_id: &str,
        request_id: &str,
    ) -> Result<TurnDispatchOutcome, String> {
        let (completion, receiver) = oneshot::channel();
        {
            let mut pending = self
                .inner
                .pending_dispatches
                .lock()
                .map_err(|_| "Pi dispatch state is unavailable".to_string())?;
            if pending.len() >= MAX_PENDING_DISPATCHES {
                return Err(format!(
                    "too many Host-initiated turns are awaiting acknowledgement (limit {MAX_PENDING_DISPATCHES})"
                ));
            }
            pending.insert(
                prompt_id.to_string(),
                PendingDispatch {
                    request_id: request_id.to_string(),
                    completion,
                },
            );
        }
        let mut frame = serde_json::to_vec(command).map_err(|error| error.to_string())?;
        frame.push(b'\n');
        if let Err(error) = self.write_frame(generation, &frame, true).await {
            self.clear_dispatch(prompt_id);
            return Err(error);
        }
        match tokio::time::timeout(DISPATCH_ACK_TIMEOUT, receiver).await {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(_)) => Ok(TurnDispatchOutcome::Unacknowledged),
            Err(_) => {
                self.clear_dispatch(prompt_id);
                Ok(TurnDispatchOutcome::Unacknowledged)
            }
        }
    }

    fn clear_dispatch(&self, prompt_id: &str) {
        if let Ok(mut pending) = self.inner.pending_dispatches.lock() {
            pending.remove(prompt_id);
        }
    }

    pub(crate) fn session_config_revision(&self, session_id: &str) -> i64 {
        self.inner
            .session_revisions
            .lock()
            .ok()
            .and_then(|revisions| revisions.get(session_id).copied())
            .unwrap_or(0)
    }

    async fn take_process(&self, generation: u64) -> Option<WorkerProcess> {
        let mut process = self.inner.process.lock().await;
        if process
            .as_ref()
            .is_some_and(|candidate| candidate.generation == generation)
        {
            process.take()
        } else {
            None
        }
    }

    async fn fail_generation(&self, app: &AppHandle, generation: u64, message: String) {
        let Some(mut process) = self.take_process(generation).await else {
            return;
        };
        let worker_cwd = process.cwd.clone();
        self.inner
            .active_generation
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        if let Some(handshake) = process.handshake.take() {
            let _ = handshake.send(Err(message.clone()));
        }
        let _ = process.child.kill().await;
        reap_child(&mut process.child).await;
        let status = AgentStatus {
            phase: AgentPhase::Failed,
            binary_path: Some(display_path(&process.binary_path)),
            pid: process.pid,
            message: Some(message.clone()),
        };
        if self.active_generation() == 0 {
            self.set_status(status.clone());
            emit_status(app, &status);
            let _ = app.emit(PI_AGENT_STDERR, format!("Pi worker: {message}"));
        }
        pi_tool_gateway::cancel_background_tasks_for_workspace(&worker_cwd);
        crate::pi_monitor_runtime::cancel_monitors_for_workspace(&worker_cwd);
        self.flush_memory_transcripts(app).await;
        // A worker can fail after it has already opened MCP servers. Reap
        // those Host-owned children as part of the same generation cleanup;
        // otherwise a protocol error would leave them running until the next
        // explicit project/session deletion.
        if let Some(mcp_runtime) = app.try_state::<PiMcpRuntime>() {
            mcp_runtime.stop_workspace(&worker_cwd).await;
        }
    }

    async fn finish_generation(&self, app: &AppHandle, generation: u64) {
        let Some(mut process) = self.take_process(generation).await else {
            return;
        };
        // Pending Host-initiated turns belong to this generation: reporting
        // them as unacknowledged is what keeps the schedule journal honest
        // after a crash or a forced restart.
        self.clear_dispatch_state();
        let worker_cwd = process.cwd.clone();
        self.inner
            .active_generation
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        let was_ready = process.ready;
        if let Some(handshake) = process.handshake.take() {
            let _ = handshake.send(Err(
                "Pi worker exited before completing the handshake".to_string()
            ));
        }
        reap_child(&mut process.child).await;
        let status = AgentStatus {
            phase: if was_ready {
                AgentPhase::Stopped
            } else {
                AgentPhase::Failed
            },
            binary_path: Some(display_path(&process.binary_path)),
            pid: process.pid,
            message: Some(if was_ready {
                "Pi worker stdout closed".to_string()
            } else {
                "Pi worker exited before the handshake".to_string()
            }),
        };
        if self.active_generation() == 0 {
            self.set_status(status.clone());
            emit_status(app, &status);
        }
        pi_tool_gateway::cancel_background_tasks_for_workspace(&worker_cwd);
        crate::pi_monitor_runtime::cancel_monitors_for_workspace(&worker_cwd);
        self.flush_memory_transcripts(app).await;
        // stdout closure is also a worker failure boundary. Do not keep MCP
        // servers alive merely because the worker exited without a malformed
        // frame.
        if let Some(mcp_runtime) = app.try_state::<PiMcpRuntime>() {
            mcp_runtime.stop_workspace(&worker_cwd).await;
        }
    }

    async fn stop_locked(&self, app: &AppHandle) -> Result<AgentStatus, String> {
        let generation = self.inner.active_generation.swap(0, Ordering::AcqRel);
        let Some(mut process) = self.take_process(generation).await else {
            self.clear_memory_state().await;
            let status = AgentStatus::default();
            self.set_status(status.clone());
            emit_status(app, &status);
            return Ok(status);
        };
        let worker_cwd = process.cwd.clone();
        pi_tool_gateway::cancel_background_tasks_for_workspace(&worker_cwd);
        crate::pi_monitor_runtime::cancel_monitors_for_workspace(&worker_cwd);
        process.handshake.take();
        // Ask a ready worker to flush native sessions and close its Pi
        // sessions before falling back to a hard kill. Shutdown-time event
        // delivery remains best effort because the supervisor detaches the
        // process from the live generation before waiting for it to exit.
        let graceful = match encode_command(&json!({
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "requestId": format!("pi-shutdown-{generation}"),
            "command": { "type": "runtime.shutdown", "reason": "stop" }
        })) {
            Ok(frame) => {
                process.stdin.write_all(&frame).await.is_ok() && process.stdin.flush().await.is_ok()
            }
            Err(_) => false,
        };

        let mut exited = false;
        if graceful && let Ok(result) = timeout(CHILD_REAP_TIMEOUT, process.child.wait()).await {
            exited = result.is_ok();
        }
        let stop_error = if !exited {
            let kill_result = process.child.kill().await;
            reap_child(&mut process.child).await;
            if let Err(error) = kill_result
                && !matches!(
                    error.kind(),
                    io::ErrorKind::InvalidInput | io::ErrorKind::NotFound
                )
            {
                Some(format!("Failed to stop Pi worker: {error}"))
            } else {
                None
            }
        } else {
            None
        };
        if let Some(mcp_runtime) = app.try_state::<PiMcpRuntime>() {
            mcp_runtime.stop_workspace(&worker_cwd).await;
        }
        self.flush_memory_transcripts(app).await;
        if let Some(error) = stop_error {
            return Err(error);
        }
        let status = AgentStatus::default();
        self.set_status(status.clone());
        emit_status(app, &status);
        Ok(status)
    }

    async fn stop(&self, app: &AppHandle) -> Result<AgentStatus, String> {
        let _operation = self.inner.operation.lock().await;
        self.stop_locked(app).await
    }

    /// Stop the Pi generation only when it owns the requested workspace.
    ///
    /// Project/session deletion happens outside the worker command loop. If
    /// the process remained alive while rows and native JSONL were removed,
    /// late tool/event callbacks could target a deleted product session. The
    /// workspace check keeps a delete in one project from interrupting a
    /// worker serving another project.
    pub(crate) async fn stop_if_workspace(
        &self,
        app: &AppHandle,
        cwd: &Path,
    ) -> Result<(), String> {
        let _operation = self.inner.operation.lock().await;
        if self.active_generation() != 0 {
            let active_cwd = self
                .inner
                .process
                .lock()
                .await
                .as_ref()
                .map(|process| process.cwd.clone());
            if active_cwd.as_deref() == Some(cwd) {
                self.stop_locked(app).await?;
            }
        }
        if let Some(mcp_runtime) = app.try_state::<PiMcpRuntime>() {
            mcp_runtime.stop_workspace(cwd).await;
        }
        pi_tool_gateway::cancel_background_tasks_for_workspace(cwd);
        crate::pi_monitor_runtime::cancel_monitors_for_workspace(cwd);
        Ok(())
    }

    async fn start(&self, app: &AppHandle, cwd: PathBuf) -> Result<AgentStatus, String> {
        let _operation = self.inner.operation.lock().await;
        if self.active_generation() != 0 {
            let active_cwd = self
                .inner
                .process
                .lock()
                .await
                .as_ref()
                .map(|process| process.cwd.clone());
            if active_cwd.as_deref() == Some(cwd.as_path()) {
                return Ok(self.status());
            }

            // A worker generation is deliberately scoped to one canonical
            // workspace.  Pi's model catalog, skill allowlist and resource
            // loader are initialized at process start; reusing the process
            // for another project would silently run it with the first
            // project's configuration.  Stop it gracefully before starting
            // the new workspace generation.
            self.stop_locked(app).await?;
        }

        let Some(binary) = resolve_worker_binary(app) else {
            let status = AgentStatus {
                phase: AgentPhase::Missing,
                message: Some(
                    "Bundled Pi worker is missing for this target. Run pnpm prepare:agent-worker or set MELODY_PI_WORKER_PATH for development."
                        .to_string(),
                ),
                ..AgentStatus::default()
            };
            self.set_status(status.clone());
            emit_status(app, &status);
            return Ok(status);
        };

        let starting_status = AgentStatus {
            phase: AgentPhase::Starting,
            binary_path: Some(display_path(&binary)),
            message: Some("Starting Pi worker".to_string()),
            ..AgentStatus::default()
        };
        self.set_status(starting_status.clone());
        emit_status(app, &starting_status);
        // A generation is bound to one canonical workspace. Any lifecycle
        // state left by a previous generation has already been flushed (or
        // explicitly disabled) before a new workspace is admitted.
        self.clear_memory_state().await;

        let prepared_models = match prepare_worker_models(&cwd).await {
            Ok(value) => value,
            Err(error) => {
                let status = AgentStatus {
                    phase: AgentPhase::Failed,
                    binary_path: Some(display_path(&binary)),
                    message: Some(error.clone()),
                    ..AgentStatus::default()
                };
                self.set_status(status.clone());
                emit_status(app, &status);
                return Err(error);
            }
        };
        let model_network_policy = match pi_model_network_policy(&cwd.to_string_lossy()) {
            Ok(value) => value,
            Err(error) => {
                let status = AgentStatus {
                    phase: AgentPhase::Failed,
                    binary_path: Some(display_path(&binary)),
                    message: Some(error.clone()),
                    ..AgentStatus::default()
                };
                self.set_status(status.clone());
                emit_status(app, &status);
                return Err(error);
            }
        };
        let envrc = match load_envrc(&cwd).await {
            Ok(value) => value,
            Err(error) => {
                let status = AgentStatus {
                    phase: AgentPhase::Failed,
                    binary_path: Some(display_path(&binary)),
                    message: Some(error.clone()),
                    ..AgentStatus::default()
                };
                self.set_status(status.clone());
                emit_status(app, &status);
                return Err(error);
            }
        };
        let mut command = Command::new(&binary);
        configure_worker_command(
            &mut command,
            &cwd,
            prepared_models.as_ref(),
            &envrc,
            model_network_policy.as_ref(),
        );
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let message = format!("Failed to start Pi worker: {error}");
                let status = AgentStatus {
                    phase: AgentPhase::Failed,
                    binary_path: Some(display_path(&binary)),
                    message: Some(message.clone()),
                    ..AgentStatus::default()
                };
                self.set_status(status.clone());
                emit_status(app, &status);
                return Err(message);
            }
        };
        let pid = child.id();
        let Some(stdin) = child.stdin.take() else {
            let message = "Pi worker stdin was not piped".to_string();
            let _ = child.kill().await;
            let status = AgentStatus {
                phase: AgentPhase::Failed,
                binary_path: Some(display_path(&binary)),
                pid,
                message: Some(message.clone()),
            };
            self.set_status(status.clone());
            emit_status(app, &status);
            return Err(message);
        };
        let Some(stdout) = child.stdout.take() else {
            let message = "Pi worker stdout was not piped".to_string();
            let _ = child.kill().await;
            let status = AgentStatus {
                phase: AgentPhase::Failed,
                binary_path: Some(display_path(&binary)),
                pid,
                message: Some(message.clone()),
            };
            self.set_status(status.clone());
            emit_status(app, &status);
            return Err(message);
        };
        let Some(stderr) = child.stderr.take() else {
            let message = "Pi worker stderr was not piped".to_string();
            let _ = child.kill().await;
            let status = AgentStatus {
                phase: AgentPhase::Failed,
                binary_path: Some(display_path(&binary)),
                pid,
                message: Some(message.clone()),
            };
            self.set_status(status.clone());
            emit_status(app, &status);
            return Err(message);
        };

        let generation = self
            .inner
            .next_generation
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let (handshake, handshake_result) = oneshot::channel();
        self.inner
            .active_generation
            .store(generation, Ordering::Release);
        *self.inner.process.lock().await = Some(WorkerProcess {
            generation,
            binary_path: binary.clone(),
            cwd: cwd.clone(),
            pid,
            child,
            stdin,
            handshake: Some(handshake),
            ready: false,
            worker_epoch: None,
            last_seq: None,
            seen_events: VecDeque::new(),
        });
        self.spawn_readers(app.clone(), generation, stdout, stderr);

        let health = match encode_command(&json!({
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "requestId": format!("pi-health-{generation}"),
            "command": {
                "type": "runtime.health",
                "clientType": "melody-work",
                "clientCapabilities": {
                    "normalizedEvents": true,
                    "boundedJsonl": true,
                    "workerEpoch": true
                }
            }
        })) {
            Ok(frame) => frame,
            Err(error) => {
                self.fail_generation(app, generation, error.clone()).await;
                return Err(error);
            }
        };
        if let Err(error) = self.write_frame(generation, &health, false).await {
            self.fail_generation(app, generation, error.clone()).await;
            return Err(error);
        }

        match timeout(HANDSHAKE_TIMEOUT, handshake_result).await {
            Ok(Ok(Ok(()))) => {
                if self.active_generation() != generation {
                    return Err("Pi worker exited during handshake".to_string());
                }
                let status = AgentStatus {
                    phase: AgentPhase::Running,
                    binary_path: Some(display_path(&binary)),
                    pid,
                    message: Some("Pi worker handshake complete".to_string()),
                };
                self.set_status(status.clone());
                emit_status(app, &status);
                Ok(status)
            }
            Ok(Ok(Err(error))) => {
                self.fail_generation(app, generation, error.clone()).await;
                Err(error)
            }
            Ok(Err(_)) => {
                let error = "Pi worker handshake channel closed".to_string();
                self.fail_generation(app, generation, error.clone()).await;
                Err(error)
            }
            Err(_) => {
                let error = format!(
                    "Pi worker handshake timed out after {} seconds",
                    HANDSHAKE_TIMEOUT.as_secs()
                );
                self.fail_generation(app, generation, error.clone()).await;
                Err(error)
            }
        }
    }

    fn spawn_readers(
        &self,
        app: AppHandle,
        generation: u64,
        stdout: ChildStdout,
        stderr: ChildStderr,
    ) {
        let stdout_runtime = self.clone();
        let stdout_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut failure = None;
            loop {
                match read_frame(&mut reader).await {
                    Ok(Some(frame)) if frame.is_empty() => continue,
                    Ok(Some(frame)) => match serde_json::from_slice::<Value>(&frame) {
                        Ok(value) => {
                            let worker_cwd = stdout_runtime.worker_cwd(generation).await.ok();
                            let acceptance = match stdout_runtime
                                .accept_event(generation, &value)
                                .await
                            {
                                Ok(acceptance) => acceptance,
                                Err(error) if is_sequence_violation(&error) => {
                                    // The in-memory exact-ID window is
                                    // intentionally bounded. A replay of
                                    // an older event may therefore fail the
                                    // live monotonic check even though the
                                    // durable log already contains the
                                    // identical event. Let SQLite decide
                                    // that case before treating it as a
                                    // protocol failure.
                                    match persist_pi_event(
                                        &stdout_app,
                                        &value,
                                        worker_cwd.as_deref(),
                                    ) {
                                        Ok(PiEventPersistence::Duplicate) => continue,
                                        Ok(PiEventPersistence::Inserted) => {
                                            failure = Some(error);
                                            break;
                                        }
                                        Ok(PiEventPersistence::UnknownSession) => {
                                            failure = Some(
                                                "Pi event referenced an unknown product session"
                                                    .to_string(),
                                            );
                                            break;
                                        }
                                        Err(persist_error) => {
                                            failure = Some(format!(
                                                "Failed to persist Pi event before delivery: {persist_error}"
                                            ));
                                            break;
                                        }
                                    }
                                }
                                Err(error) => {
                                    failure = Some(error);
                                    break;
                                }
                            };
                            if acceptance == EventAcceptance::Duplicate {
                                continue;
                            }
                            match persist_pi_event(&stdout_app, &value, worker_cwd.as_deref()) {
                                Ok(PiEventPersistence::Inserted) => {}
                                Ok(PiEventPersistence::Duplicate) => continue,
                                Ok(PiEventPersistence::UnknownSession) => {
                                    failure = Some(
                                        "Pi event referenced an unknown product session"
                                            .to_string(),
                                    );
                                    break;
                                }
                                Err(error) => {
                                    // Product events must be committed before
                                    // they are visible to the renderer.
                                    // Otherwise the UI could show a
                                    // message/tool result that a restart
                                    // cannot replay. Stop this generation and
                                    // let the supervisor surface a recoverable
                                    // runtime failure instead of emitting a
                                    // false-success event.
                                    failure = Some(format!(
                                        "Failed to persist Pi event before delivery: {error}"
                                    ));
                                    break;
                                }
                            }
                            stdout_runtime
                                .observe_memory_event(&stdout_app, &value, worker_cwd.as_deref())
                                .await;
                            // Host-initiated dispatches are confirmed here, at
                            // the same point that decides an event is real: a
                            // duplicate replay must not acknowledge a dispatch.
                            stdout_runtime.observe_dispatch_event(&value);
                            // Host-owned lifecycle hooks are observational in
                            // Pi and are re-read for each event, so editing a
                            // trusted JSON definition takes effect without a
                            // worker restart. Run them off the reader loop so
                            // a slow (but bounded) hook cannot stall streaming
                            // or permission delivery.
                            let hook_runtime = stdout_runtime.clone();
                            let hook_app = stdout_app.clone();
                            let hook_value = value.clone();
                            tauri::async_runtime::spawn(async move {
                                hook_runtime
                                    .observe_host_hook_event(&hook_app, generation, &hook_value)
                                    .await;
                            });
                            let persisted_permission =
                                persisted_permission_for_interaction(&stdout_app, &value);
                            let is_tool_request = pi_tool_gateway::is_tool_request(&value);
                            let _ = stdout_app.emit(PI_AGENT_EVENT, value.clone());
                            if let Some((session_id, interaction_id, decision)) =
                                persisted_permission
                            {
                                let request_runtime = stdout_runtime.clone();
                                let request_app = stdout_app.clone();
                                let request_value = value.clone();
                                tauri::async_runtime::spawn(async move {
                                    request_runtime
                                        .resolve_persisted_permission(
                                            &request_app,
                                            generation,
                                            &request_value,
                                            session_id,
                                            interaction_id,
                                            decision,
                                        )
                                        .await;
                                });
                            }
                            if is_tool_request {
                                let request_runtime = stdout_runtime.clone();
                                let request_app = stdout_app.clone();
                                tauri::async_runtime::spawn(async move {
                                    request_runtime
                                        .resolve_tool_request(&request_app, generation, &value)
                                        .await;
                                });
                            }
                        }
                        Err(error) => {
                            failure = Some(format!("Pi worker emitted invalid JSON: {error}"));
                            break;
                        }
                    },
                    Ok(None) => break,
                    Err(error) => {
                        failure = Some(format!("Failed to read Pi worker stdout: {error}"));
                        break;
                    }
                }
            }
            if let Some(error) = failure {
                stdout_runtime
                    .fail_generation(&stdout_app, generation, error)
                    .await;
            } else {
                stdout_runtime
                    .finish_generation(&stdout_app, generation)
                    .await;
            }
        });

        let stderr_app = app;
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            loop {
                match read_frame(&mut reader).await {
                    Ok(Some(frame)) if !frame.is_empty() => {
                        let line = String::from_utf8_lossy(&frame).into_owned();
                        let _ = stderr_app.emit(PI_AGENT_STDERR, line);
                    }
                    Ok(Some(_)) => continue,
                    Ok(None) => break,
                    Err(error) => {
                        let _ = stderr_app.emit(
                            PI_AGENT_STDERR,
                            format!("Failed to read Pi worker stderr: {error}"),
                        );
                        break;
                    }
                }
            }
        });
    }

    fn emit_hook_warnings(app: &AppHandle, result: &HookRunResult) {
        for warning in &result.warnings {
            let _ = app.emit(PI_AGENT_STDERR, format!("Pi Hook: {warning}"));
        }
    }

    async fn run_host_tool_hooks(
        &self,
        root: &Path,
        event: HookEvent,
        request: &Value,
        resolution: Option<&Value>,
    ) -> HookRunResult {
        let root = root.to_path_buf();
        let request = request.clone();
        let resolution = resolution.cloned();
        match tauri::async_runtime::spawn_blocking(move || {
            pi_hook_runtime::run_tool_hooks(&root, event, &request, resolution.as_ref())
        })
        .await
        {
            Ok(result) => result,
            Err(error) => HookRunResult {
                warnings: vec![format!("Hook worker failed: {error}")],
                ..HookRunResult::default()
            },
        }
    }

    async fn observe_host_hook_event(&self, app: &AppHandle, generation: u64, value: &Value) {
        let Some(event) = value.get("event").and_then(Value::as_object) else {
            return;
        };
        let event_type = event.get("type").and_then(Value::as_str);
        let hook_event = match event_type {
            Some("session.opened") => HookEvent::SessionStart,
            Some("session.closed") => HookEvent::SessionEnd,
            Some("session.compacting") => HookEvent::PreCompact,
            Some("session.compacted") => HookEvent::PostCompact,
            Some("subagent.changed")
                if event.get("status").and_then(Value::as_str) == Some("running") =>
            {
                HookEvent::SubagentStart
            }
            Some("subagent.changed")
                if matches!(
                    event.get("status").and_then(Value::as_str),
                    Some("completed" | "failed" | "cancelled")
                ) =>
            {
                HookEvent::SubagentStop
            }
            _ => return,
        };
        let Ok(root) = self.worker_cwd(generation).await else {
            return;
        };
        let payload = value.clone();
        let result = match tauri::async_runtime::spawn_blocking(move || {
            pi_hook_runtime::run_event_hooks(&root, hook_event, &payload)
        })
        .await
        {
            Ok(result) => result,
            Err(error) => HookRunResult {
                warnings: vec![format!("Hook worker failed: {error}")],
                ..HookRunResult::default()
            },
        };
        Self::emit_hook_warnings(app, &result);
        if result.blocked {
            // Lifecycle hooks are intentionally observational in Pi. A late
            // block cannot safely undo a completed session/compaction event;
            // keep the diagnostic visible and leave enforcement to ACP.
            let _ = app.emit(
                PI_AGENT_STDERR,
                format!(
                    "Pi Hook: {} returned a blocking decision after the event; decision ignored",
                    hook_event.as_str()
                ),
            );
        }
    }

    async fn resolve_tool_request(&self, app: &AppHandle, generation: u64, value: &Value) {
        let worker_cwd = match self.worker_cwd(generation).await {
            Ok(cwd) => cwd,
            Err(error) => {
                let command = pi_tool_gateway::fail_for_workspace(value, error);
                self.send_tool_resolution(app, generation, value, command)
                    .await;
                return;
            }
        };
        let root = if let Some(cwd) = pi_tool_gateway::requested_cwd(value) {
            let Some(registry) = app.try_state::<WorkspaceRegistry>() else {
                let command = pi_tool_gateway::fail_for_workspace(
                    value,
                    "Workspace authorization is unavailable.",
                );
                self.send_tool_resolution(app, generation, value, command)
                    .await;
                return;
            };
            match registry.authorize(cwd) {
                // A Pi child may intentionally run from an authorized
                // descendant directory (for example a sub-project or a
                // future managed worktree). The worker still starts from one
                // registered project root; allowing only descendants keeps
                // the Host boundary intact while avoiding a false mismatch
                // for child session tool calls.
                Ok(root) if root == worker_cwd || root.starts_with(&worker_cwd) => root,
                Ok(_) => {
                    let command = pi_tool_gateway::fail_for_workspace(
                        value,
                        "Tool request workspace does not match the active Pi worker workspace.",
                    );
                    self.send_tool_resolution(app, generation, value, command)
                        .await;
                    return;
                }
                Err(error) => {
                    let command = pi_tool_gateway::fail_for_workspace(value, error);
                    self.send_tool_resolution(app, generation, value, command)
                        .await;
                    return;
                }
            }
        } else {
            worker_cwd
        };

        // Directory instruction lookup is an internal worker preflight. It
        // reads only Host-validated AGENTS.md files, bypasses product
        // permission rules/hooks, and cannot execute the model's requested
        // filesystem operation.
        if pi_tool_gateway::is_instruction_scope_request(value) {
            let scope_root = root.clone();
            let scope_value = value.clone();
            let command = match tauri::async_runtime::spawn_blocking(move || {
                pi_tool_gateway::resolve_instruction_scope_request(&scope_root, &scope_value)
            })
            .await
            {
                Ok(command) => command,
                Err(error) => pi_tool_gateway::fail_for_request(
                    value,
                    "pi.instruction_scope_failed",
                    format!("Instruction-scope worker failed: {error}"),
                ),
            };
            self.write_tool_resolution(app, generation, value, command)
                .await;
            return;
        }

        // PreToolUse is the one Hook event whose decision can be enforced
        // before Pi executes anything. Run it after workspace authorization
        // but before persisted permissions or the regular gateway so a Hook
        // can only deny a request inside the active project boundary.
        let pre_hooks = self
            .run_host_tool_hooks(&root, HookEvent::PreToolUse, value, None)
            .await;
        Self::emit_hook_warnings(app, &pre_hooks);
        if pre_hooks.blocked {
            let (session_id, run_id, tool_call_id) = pi_tool_gateway::event_context(value)
                .map(|(session_id, run_id, tool_call_id, _, _, _)| {
                    (session_id, run_id, tool_call_id)
                })
                .unwrap_or(("unknown", None, "unknown"));
            let command = pi_tool_gateway::fail_resolution(
                session_id,
                run_id,
                tool_call_id,
                "pi.hook_blocked",
                pre_hooks
                    .reason
                    .unwrap_or_else(|| "Hook denied this tool call.".to_string()),
            );
            self.write_tool_resolution(app, generation, value, command)
                .await;
            return;
        }
        let persisted_decision = persisted_permission_for_tool_request(app, value);
        let command = if persisted_decision.as_deref() == Some("deny") {
            pi_tool_gateway::deny_for_persisted_permission(value)
        } else if pi_tool_gateway::background_task_tool_kind(value).is_some() {
            // Background terminal processes are owned by the Host registry.
            // Route their get/wait/kill controls through a blocking boundary
            // just like foreground terminal execution; the worker receives
            // only a bounded JSON snapshot.
            let control_root = root.clone();
            let control_value = value.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                pi_tool_gateway::resolve_background_task_request(&control_root, &control_value)
            })
            .await
            {
                Ok(command) => command,
                Err(error) => {
                    let command = pi_tool_gateway::fail_for_workspace(
                        value,
                        format!("Background task control worker failed: {error}"),
                    );
                    self.send_tool_resolution(app, generation, value, command)
                        .await;
                    return;
                }
            }
        } else if pi_tool_gateway::subagent_worktree_tool_kind(value).is_some() {
            // Worktree isolation is provisioned by the Host so the worker
            // never shells out to git or chooses an arbitrary destination.
            // The resulting path is still scoped to the requested child cwd
            // and returned as a bounded JSON payload.
            let worktree_root = root.clone();
            let worktree_value = value.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                pi_tool_gateway::resolve_subagent_worktree_request(&worktree_root, &worktree_value)
            })
            .await
            {
                Ok(command) => command,
                Err(error) => {
                    let command = pi_tool_gateway::fail_for_workspace(
                        value,
                        format!("Subagent worktree worker failed: {error}"),
                    );
                    self.send_tool_resolution(app, generation, value, command)
                        .await;
                    return;
                }
            }
        } else if pi_codebase_runtime::codebase_tool_kind(value).is_some() {
            // The codebase index is owned by the Host. Keep parser work off
            // Tokio's runtime thread and return only bounded JSON locations.
            let codebase_root = root.clone();
            let codebase_value = value.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                pi_codebase_runtime::resolve_request(&codebase_root, &codebase_value)
            })
            .await
            {
                Ok(command) => command,
                Err(error) => {
                    let command = pi_tool_gateway::fail_for_workspace(
                        value,
                        format!("Codebase index worker failed: {error}"),
                    );
                    self.send_tool_resolution(app, generation, value, command)
                        .await;
                    return;
                }
            }
        } else if pi_lsp_runtime::lsp_tool_kind(value).is_some() {
            // LSP processes are owned by the Host bridge.  Keep the one-shot
            // stdio JSON-RPC session off Tokio's runtime thread and return
            // only the bounded, formatted read-only result to the worker.
            let lsp_root = root.clone();
            let lsp_value = value.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                pi_lsp_runtime::resolve_request(&lsp_root, &lsp_value)
            })
            .await
            {
                Ok(command) => command,
                Err(error) => {
                    let command = pi_tool_gateway::fail_for_workspace(
                        value,
                        format!("LSP bridge worker failed: {error}"),
                    );
                    self.send_tool_resolution(app, generation, value, command)
                        .await;
                    return;
                }
            }
        } else if pi_tool_gateway::memory_tool_kind(value).is_some() {
            // Memory files live in Melody's app-owned directory rather than
            // inside the project workspace. The worker emits only a bounded
            // declarative request; the Host owns scope, hashing, indexing and
            // line-range checks.
            if pi_tool_gateway::memory_write_requires_permission(value)
                && persisted_decision.as_deref() != Some("allow")
            {
                pi_tool_gateway::permission_required_for_request(value)
            } else {
                let memory_value = value.clone();
                let memory_root = root.clone();
                match tauri::async_runtime::spawn_blocking(move || {
                    tauri::async_runtime::block_on(pi_memory_runtime::resolve_request(
                        &memory_root,
                        &memory_value,
                    ))
                })
                .await
                {
                    Ok(Ok(output)) => pi_tool_gateway::success_for_request(value, output),
                    Ok(Err(error)) => pi_tool_gateway::fail_resolution(
                        value
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                        value.get("runId").and_then(Value::as_str),
                        value
                            .get("event")
                            .and_then(Value::as_object)
                            .and_then(|event| event.get("toolCallId"))
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                        "pi.memory_tool_failed",
                        error,
                    ),
                    Err(error) => pi_tool_gateway::fail_resolution(
                        value
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                        value.get("runId").and_then(Value::as_str),
                        value
                            .get("event")
                            .and_then(Value::as_object)
                            .and_then(|event| event.get("toolCallId"))
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                        "pi.memory_tool_failed",
                        format!("Memory execution worker failed: {error}"),
                    ),
                }
            }
        } else if pi_tool_gateway::browser_tool_kind(value).is_some() {
            // Browser actions execute only in a session-scoped Host-owned
            // WebviewWindow. Page content and refs are treated as untrusted;
            // navigation/click/type must carry the worker's explicit approval.
            if pi_tool_gateway::browser_action_requires_permission(value) {
                pi_tool_gateway::permission_required_for_request(value)
            } else {
                let Some(browser_runtime) =
                    app.try_state::<crate::pi_browser_runtime::PiBrowserRuntime>()
                else {
                    let command = pi_tool_gateway::fail_for_request(
                        value,
                        "pi.browser_unavailable",
                        "Browser Host is unavailable in this runtime.",
                    );
                    self.send_tool_resolution(app, generation, value, command)
                        .await;
                    return;
                };
                match crate::pi_browser_runtime::resolve_request(app, value, &browser_runtime).await
                {
                    Ok(output) => pi_tool_gateway::success_for_request(value, output),
                    Err(error) => {
                        pi_tool_gateway::fail_for_request(value, "pi.browser_tool_failed", error)
                    }
                }
            }
        } else if pi_tool_gateway::web_tool_kind(value).is_some() {
            // Web search/fetch use a separate Host bridge.  The worker only
            // emits a bounded declarative request; it never receives a raw
            // HTTP client, DNS resolver, or redirect-capable transport.
            match pi_web_runtime::resolve_request(&root, value).await {
                Ok(output) => pi_tool_gateway::success_for_request(value, output),
                Err(error) => pi_tool_gateway::fail_resolution(
                    value
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    value.get("runId").and_then(Value::as_str),
                    value
                        .get("event")
                        .and_then(Value::as_object)
                        .and_then(|event| event.get("toolCallId"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    "pi.web_tool_failed",
                    error,
                ),
            }
        } else if pi_tool_gateway::mcp_tool_kind(value).is_some() {
            // MCP is the one Pi ecosystem capability that crosses the worker
            // boundary asynchronously. The worker only emits the request;
            // the Host owns config parsing, process lifecycle and JSON-RPC.
            // Keep the same permission defense as the regular gateway in case
            // a stale/replayed event bypasses the worker-side interaction.
            if pi_tool_gateway::mcp_call_requires_permission(value)
                && persisted_decision.as_deref() != Some("allow")
            {
                pi_tool_gateway::resolve_request(&root, value)
            } else {
                let Some(mcp_runtime) = app.try_state::<PiMcpRuntime>() else {
                    let command = pi_tool_gateway::fail_for_workspace(
                        value,
                        "MCP Host bridge is unavailable in this runtime.",
                    );
                    self.send_tool_resolution(app, generation, value, command)
                        .await;
                    return;
                };
                match mcp_runtime.resolve_request(&root, value).await {
                    Ok(output) => pi_tool_gateway::success_for_request(value, output),
                    Err(error) => pi_tool_gateway::fail_resolution(
                        value
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                        value.get("runId").and_then(Value::as_str),
                        value
                            .get("event")
                            .and_then(Value::as_object)
                            .and_then(|event| event.get("toolCallId"))
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                        "pi.mcp_tool_failed",
                        error,
                    ),
                }
            }
        } else {
            // File traversal and terminal execution are deliberately
            // synchronous inside the policy gateway. Keep them off Tokio's
            // runtime thread so a long-running tool cannot starve stdout,
            // permission, or cancellation events for other sessions.
            let gateway_root = root.clone();
            let gateway_value = value.clone();
            let permission_override =
                (persisted_decision.as_deref() == Some("allow")).then_some(true);
            // Resolve the visibility policy from Host-owned configuration at
            // the authorization boundary. The worker's boolean is useful for
            // replay shape/diagnostics, but is not trusted to widen access.
            let respect_gitignore = pi_respect_gitignore(&root.to_string_lossy());
            let terminal_policy = pi_terminal_policy(&root.to_string_lossy());
            let monitor_app = app.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                let monitor_app = Some(monitor_app);
                permission_override.map_or_else(
                    || {
                        pi_tool_gateway::resolve_request_with_host_policy(
                            &gateway_root,
                            &gateway_value,
                            None,
                            Some(respect_gitignore),
                            terminal_policy,
                            monitor_app.clone(),
                        )
                    },
                    |override_value| {
                        pi_tool_gateway::resolve_request_with_host_policy(
                            &gateway_root,
                            &gateway_value,
                            Some(override_value),
                            Some(respect_gitignore),
                            terminal_policy,
                            monitor_app.clone(),
                        )
                    },
                )
            })
            .await
            {
                Ok(command) => command,
                Err(error) => {
                    let command = pi_tool_gateway::fail_for_workspace(
                        value,
                        format!("Tool execution worker failed: {error}"),
                    );
                    self.send_tool_resolution(app, generation, value, command)
                        .await;
                    return;
                }
            }
        };
        self.send_tool_resolution(app, generation, value, command)
            .await;
    }

    async fn send_tool_resolution(
        &self,
        app: &AppHandle,
        generation: u64,
        value: &Value,
        command: Value,
    ) {
        let status = command
            .get("resolution")
            .and_then(Value::as_object)
            .and_then(|resolution| resolution.get("status"))
            .and_then(Value::as_str);
        let error_code = command
            .get("resolution")
            .and_then(Value::as_object)
            .and_then(|resolution| resolution.get("error"))
            .and_then(Value::as_object)
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str);
        let post_hook = if error_code != Some("pi.hook_blocked") {
            let event = if error_code == Some("pi.permission_denied") {
                HookEvent::PermissionDenied
            } else if status == Some("completed") {
                HookEvent::PostToolUse
            } else {
                HookEvent::PostToolUseFailure
            };
            self.worker_cwd(generation)
                .await
                .ok()
                .map(|root| (root, event))
        } else {
            None
        };
        // Deliver the resolution first. Post/failure hooks are observational;
        // they must not make Pi wait for a slow external command before it can
        // continue the turn.
        self.write_tool_resolution(app, generation, value, command.clone())
            .await;
        if let Some((root, event)) = post_hook {
            let runtime = self.clone();
            let hook_app = app.clone();
            let hook_value = value.clone();
            tauri::async_runtime::spawn(async move {
                let result = runtime
                    .run_host_tool_hooks(&root, event, &hook_value, Some(&command))
                    .await;
                Self::emit_hook_warnings(&hook_app, &result);
            });
        }
    }

    async fn write_tool_resolution(
        &self,
        app: &AppHandle,
        generation: u64,
        value: &Value,
        command: Value,
    ) {
        let event_id = value
            .get("eventId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let envelope = json!({
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "requestId": format!("pi-tool-{event_id}"),
            "sessionId": value.get("sessionId"),
            "command": command
        });
        let frame = match encode_command(&envelope) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = app.emit(PI_AGENT_STDERR, format!("Pi ToolGateway: {error}"));
                return;
            }
        };
        if let Err(error) = self.write_frame(generation, &frame, true).await {
            let _ = app.emit(
                PI_AGENT_STDERR,
                format!("Pi ToolGateway response failed: {error}"),
            );
        }
    }

    async fn resolve_persisted_permission(
        &self,
        app: &AppHandle,
        generation: u64,
        value: &Value,
        session_id: String,
        interaction_id: String,
        decision: String,
    ) {
        let option_id = if decision == "allow" {
            "allow_always"
        } else {
            // Pi treats any non-allow outcome as a rejection. Use the
            // explicit one-shot option because older workers may not expose
            // `reject_always` even though the Host rule is project-scoped.
            "reject_once"
        };
        let event_id = value
            .get("eventId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let envelope = json!({
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "requestId": format!("pi-permission-{event_id}"),
            "sessionId": session_id,
            "command": {
                "type": "interaction.resolve",
                "sessionId": session_id,
                "interactionId": interaction_id,
                "resolution": {
                    "outcome": { "outcome": "selected", "optionId": option_id }
                }
            }
        });
        let frame = match encode_command(&envelope) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = app.emit(
                    PI_AGENT_STDERR,
                    format!("Pi persisted permission response: {error}"),
                );
                return;
            }
        };
        if let Err(error) = self.write_frame(generation, &frame, true).await {
            let _ = app.emit(
                PI_AGENT_STDERR,
                format!("Pi persisted permission response failed: {error}"),
            );
        }
    }
}

fn lookup_persisted_permission(
    app: &AppHandle,
    session_id: &str,
    tool_key: &str,
) -> Option<String> {
    let database = app.try_state::<AppDatabase>()?;
    match permission_decision_for_session(database.inner(), session_id, tool_key) {
        Ok(Some(decision)) if matches!(decision.as_str(), "allow" | "deny") => Some(decision),
        Ok(Some(_)) => {
            let _ = app.emit(
                PI_AGENT_STDERR,
                "Pi permission store returned an invalid decision; leaving the request interactive.",
            );
            None
        }
        Ok(None) => None,
        Err(error) => {
            // A lookup failure must never widen permissions. Leaving the
            // worker's `ask` interaction in place is safe and lets the user
            // make an explicit one-shot decision.
            let _ = app.emit(
                PI_AGENT_STDERR,
                format!("Pi permission store unavailable: {error}"),
            );
            None
        }
    }
}

fn persisted_permission_for_tool_request(app: &AppHandle, value: &Value) -> Option<String> {
    let session_id = value.get("sessionId").and_then(Value::as_str)?;
    let tool_key = pi_tool_gateway::permission_tool_key(value)?;
    lookup_persisted_permission(app, session_id, &tool_key)
}

fn persisted_permission_for_interaction(
    app: &AppHandle,
    value: &Value,
) -> Option<(String, String, String)> {
    let (session_id, interaction_id, tool_key) = pi_tool_gateway::permission_interaction(value)?;
    let decision = lookup_persisted_permission(app, &session_id, &tool_key)?;
    Some((session_id, interaction_id, decision))
}

/// Emit a Host-authored product event for one session.
///
/// Host-owned subsystems (monitors) produce events without a worker turn. They
/// are persisted through the same event log and delivered on the same channel
/// as engine-reported events, so replay and the UI never need a second path.
/// The envelope deliberately carries no `workerEpoch` or `seq`: those describe
/// a worker generation, and a Host event is not part of one.
pub(crate) fn emit_host_agent_event(
    app: &AppHandle,
    session_id: &str,
    workspace: &Path,
    event: Value,
) -> Result<(), String> {
    let event_id = format!("host-{}", uuid::Uuid::new_v4());
    let envelope = json!({
        "protocolVersion": AGENT_PROTOCOL_VERSION,
        "eventId": event_id,
        "sourceEventId": event_id,
        "sessionId": session_id,
        "replay": false,
        "event": event,
    });
    persist_pi_event(app, &envelope, Some(workspace))?;
    let _ = app.emit(PI_AGENT_EVENT, envelope);
    Ok(())
}

fn is_unscoped_pi_event(value: &Value) -> bool {
    value
        .get("sessionId")
        .and_then(Value::as_str)
        .is_none_or(|session_id| session_id.trim().is_empty())
}

fn persist_pi_event(
    app: &AppHandle,
    value: &Value,
    worker_cwd: Option<&Path>,
) -> Result<PiEventPersistence, String> {
    // Runtime-wide handshake/diagnostic events deliberately have no product
    // session. Do this check before touching Tauri state so a standalone
    // worker smoke test does not require an initialized application database.
    if is_unscoped_pi_event(value) {
        return Ok(PiEventPersistence::Inserted);
    }
    let Some(database) = app.try_state::<AppDatabase>() else {
        return Err("App database is unavailable".to_string());
    };
    let worker_cwd = worker_cwd
        .ok_or_else(|| "Pi worker workspace is unavailable for a session event".to_string())?;
    {
        let connection = database
            .connection
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        let session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Pi event sessionId must be a non-empty string".to_string())?;
        validate_pi_session_workspace(&connection, session_id, worker_cwd)?;
    }
    // Runtime events such as `runtime.ready` are deliberately not product
    // events and have no session identity. Keep the health handshake free of
    // needless database work; an event that names an unknown product session
    // is rejected by the reader while runtime-wide events are accepted.
    append_pi_event(database.inner(), value)
}

async fn reap_child(child: &mut Child) {
    if timeout(CHILD_REAP_TIMEOUT, child.wait()).await.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

fn emit_status(app: &AppHandle, status: &AgentStatus) {
    let _ = app.emit(PI_AGENT_STATUS, status);
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn bound_session_text(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    const SUFFIX: &str = "\n[message truncated]";
    if limit <= SUFFIX.len() {
        let mut end = limit;
        while end > 0 && !value.is_char_boundary(end) {
            end -= 1;
        }
        return value[..end].to_string();
    }
    let mut end = limit - SUFFIX.len();
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut bounded = value[..end].to_string();
    bounded.push_str(SUFFIX);
    bounded
}

fn worker_executable_names() -> [&'static str; 2] {
    if cfg!(windows) {
        ["melody-agent-worker.exe", "agent-worker.exe"]
    } else {
        ["melody-agent-worker", "agent-worker"]
    }
}

fn runtime_target_triples() -> &'static [&'static str] {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        &["aarch64-apple-darwin"]
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        &["x86_64-apple-darwin"]
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        &["aarch64-pc-windows-msvc"]
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        &["x86_64-pc-windows-msvc"]
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        &["aarch64-unknown-linux-gnu"]
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        &["x86_64-unknown-linux-gnu"]
    } else {
        &[]
    }
}

fn worker_target_names() -> Vec<String> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let mut names = Vec::new();
    if let Some(target) = option_env!("MELODY_TARGET_TRIPLE") {
        names.push(format!("melody-agent-worker-{target}{extension}"));
    }
    for target in runtime_target_triples() {
        let name = format!("melody-agent-worker-{target}{extension}");
        if !names.iter().any(|candidate| candidate == &name) {
            names.push(name);
        }
    }
    names
}

fn add_worker_candidates(candidates: &mut Vec<PathBuf>, directory: &Path) {
    let names = worker_executable_names();
    candidates.extend(names.iter().map(|name| directory.join(name)));
    for target_name in worker_target_names() {
        candidates.push(directory.join(target_name));
    }
    // Tauri's `externalBin` may place a target-suffixed resource beside the
    // app executable without preserving the compile-time target environment
    // variable.  Restrict discovery to the exact platform names above; never
    // execute an arbitrary file merely because it starts with our prefix.
    if let Ok(entries) = fs::read_dir(directory) {
        let known_names = worker_target_names();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if known_names.iter().any(|candidate| candidate == name)
                && path.is_file()
                && !candidates.iter().any(|candidate| candidate == &path)
            {
                candidates.push(path);
            }
        }
    }
}

fn resolve_worker_binary(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) = env::var_os("MELODY_PI_WORKER_PATH") {
        candidates.push(PathBuf::from(explicit));
    }
    if let Ok(current_exe) = env::current_exe()
        && let Some(directory) = current_exe.parent()
    {
        add_worker_candidates(&mut candidates, directory);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        add_worker_candidates(&mut candidates, &resource_dir);
        add_worker_candidates(&mut candidates, &resource_dir.join("binaries"));
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for target_name in worker_target_names() {
        candidates.push(manifest.join("binaries").join(target_name));
    }
    candidates.into_iter().find(|path| path.is_file())
}

async fn prepare_worker_models(cwd: &Path) -> Result<Option<PreparedPiModels>, String> {
    // A managed/development path is an explicit escape hatch.  Do not merge
    // into or overwrite a file owned by that caller.
    if env::var_os("MELODY_PI_MODELS_PATH").is_some_and(|value| !value.is_empty()) {
        return Ok(None);
    }
    let Some(home) = melody_home() else {
        return Ok(None);
    };
    pi_model_config::prepare_pi_models_with_remote(cwd, &home)
        .await
        .map(Some)
}

fn configure_worker_command(
    command: &mut Command,
    cwd: &Path,
    prepared_models: Option<&PreparedPiModels>,
    envrc: &[(String, String)],
    model_network_policy: Option<&(bool, Option<String>)>,
) {
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_clear();
    for key in INHERITED_WORKER_ENV {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    if let Some(home) = melody_home() {
        command.env("MELODY_HOME", &home);
        // Pi's native JSONL is kept in an app-owned directory. The worker
        // never falls back to ~/.pi, and the renderer cannot choose this
        // location; this keeps migration data separate from user Pi data.
        command.env("MELODY_PI_SESSION_ROOT", home.join("pi-sessions"));
        // Model credentials/catalogs follow the same app-owned boundary. An
        // explicit environment value is preserved as a deliberate dev or
        // managed-credential override; otherwise never inherit Pi's ambient
        // ~/.pi/agent files.
        command.env(
            "MELODY_PI_AUTH_PATH",
            env::var_os("MELODY_PI_AUTH_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("pi").join("auth.json")),
        );
        let models_path = prepared_models
            .map(|prepared| prepared.path.clone())
            .or_else(|| {
                env::var_os("MELODY_PI_MODELS_PATH")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| home.join("pi").join("models.json"));
        command.env("MELODY_PI_MODELS_PATH", models_path);
        if let Some((enabled, catalog_base_url)) = model_network_policy {
            command.env(
                "MELODY_PI_ALLOW_MODEL_NETWORK",
                if *enabled { "1" } else { "0" },
            );
            if let Some(url) = catalog_base_url {
                command.env("MELODY_PI_CATALOG_BASE_URL", url);
            }
        }
        if let Some(prepared) = prepared_models {
            command.env("MELODY_PI_MODEL_POLICIES_PATH", &prepared.policies_path);
        } else if let Some(path) =
            env::var_os("MELODY_PI_MODEL_POLICIES_PATH").filter(|value| !value.is_empty())
        {
            command.env("MELODY_PI_MODEL_POLICIES_PATH", path);
        }
        if let Ok(skill_paths) = pi_skill_paths(&cwd.to_string_lossy())
            && !skill_paths.is_empty()
        {
            command.env(
                "MELODY_PI_SKILL_PATHS_JSON",
                serde_json::to_string(&skill_paths).unwrap_or_else(|_| "[]".to_string()),
            );
        }
        let resource_manifest = pi_resource_manifest(&cwd.to_string_lossy())
            .ok()
            .or_else(|| {
                // Keep the worker usable when an optional config file is malformed,
                // but fail closed for delegation rather than silently restoring
                // every custom subagent policy.
                Some(json!({
                    "cwd": cwd.to_string_lossy(),
                    "skillRoots": [],
                    "promptRoots": [],
                    "respectGitignore": false,
                    "subagentPolicies": {
                        "enabled": false,
                        "models": {},
                        "toggle": {},
                        "roles": [],
                        "personas": [],
                        "agents": [],
                    },
                }))
            });
        if let Some(manifest) = resource_manifest.as_ref() {
            command.env(
                "MELODY_RESPECT_GITIGNORE",
                if manifest
                    .get("respectGitignore")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    "1"
                } else {
                    "0"
                },
            );
            if let Some(policy) = manifest
                .get("questionTimeoutPolicy")
                .filter(|value| value.is_object())
            {
                command.env(
                    "MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON",
                    serde_json::to_string(policy).unwrap_or_else(|_| "".to_string()),
                );
            }
            if let Some(policy) = manifest.get("goalPolicy").filter(|value| value.is_object()) {
                command.env(
                    "MELODY_PI_GOAL_POLICY_JSON",
                    serde_json::to_string(policy).unwrap_or_else(|_| "".to_string()),
                );
            }
            command.env(
                "MELODY_PI_SKILL_ROOTS_JSON",
                serde_json::to_string(
                    manifest
                        .get("skillRoots")
                        .unwrap_or(&Value::Array(Vec::new())),
                )
                .unwrap_or_else(|_| "[]".to_string()),
            );
            command.env(
                "MELODY_PI_SUBAGENT_POLICIES_JSON",
                serde_json::to_string(manifest.get("subagentPolicies").unwrap_or(&json!({
                    "enabled": true,
                    "models": {},
                    "toggle": {},
                    "roles": [],
                    "personas": [],
                })))
                .unwrap_or_else(|_| {
                    "{\"enabled\":false,\"models\":{},\"toggle\":{},\"roles\":[],\"personas\":[]}"
                        .to_string()
                }),
            );
        }
        if let Ok(prompt_paths) = pi_prompt_paths(&cwd.to_string_lossy())
            && !prompt_paths.is_empty()
        {
            command.env(
                "MELODY_PI_PROMPT_PATHS_JSON",
                serde_json::to_string(&prompt_paths).unwrap_or_else(|_| "[]".to_string()),
            );
        }
        if let Some(manifest) = resource_manifest.as_ref() {
            command.env(
                "MELODY_PI_PROMPT_ROOTS_JSON",
                serde_json::to_string(
                    manifest
                        .get("promptRoots")
                        .unwrap_or(&Value::Array(Vec::new())),
                )
                .unwrap_or_else(|_| "[]".to_string()),
            );
        }
        // `.envrc` is evaluated by the Host under a scrubbed environment.
        // Inject it before generated model credentials so a project file
        // cannot shadow the short-lived values used by the model catalog.
        for (name, value) in envrc {
            command.env(name, value);
        }
        if let Some(prepared) = prepared_models {
            for (name, value) in &prepared.credentials {
                command.env(name, value);
            }
        }
    } else {
        // Keep explicit paths available for development even when the Host
        // cannot derive an application data root.
        for key in [
            "MELODY_PI_AUTH_PATH",
            "MELODY_PI_MODELS_PATH",
            "MELODY_PI_MODEL_POLICIES_PATH",
            "MELODY_PI_SKILL_PATHS_JSON",
            "MELODY_PI_SKILL_ROOTS_JSON",
            "MELODY_PI_PROMPT_PATHS_JSON",
            "MELODY_PI_PROMPT_ROOTS_JSON",
            "MELODY_RESPECT_GITIGNORE",
            "MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON",
            "MELODY_PI_GOAL_POLICY_JSON",
            "MELODY_PI_ALLOW_MODEL_NETWORK",
            "MELODY_PI_CATALOG_BASE_URL",
        ] {
            if let Some(value) = env::var_os(key).filter(|value| !value.is_empty()) {
                command.env(key, value);
            }
        }
    }
}

fn encode_command(value: &Value) -> Result<Vec<u8>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Pi command envelope must be an object".to_string())?;
    if object.get("protocolVersion").and_then(Value::as_u64) != Some(AGENT_PROTOCOL_VERSION) {
        return Err("Unsupported Pi agent protocol version".to_string());
    }
    let request_id = object
        .get("requestId")
        .ok_or_else(|| "Pi command envelope.requestId is required".to_string())?;
    let valid_request_id = match request_id {
        Value::String(value) => !value.trim().is_empty(),
        Value::Number(value) => value
            .as_i64()
            .map(|number| number.unsigned_abs() <= 9_007_199_254_740_991)
            .or_else(|| value.as_u64().map(|number| number <= 9_007_199_254_740_991))
            .unwrap_or(false),
        _ => false,
    };
    if !valid_request_id {
        return Err("Pi command envelope.requestId must be a stable ID".to_string());
    }
    let command_type = object
        .get("command")
        .and_then(Value::as_object)
        .and_then(|command| command.get("type"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Pi command envelope.command.type is required".to_string())?;
    let _ = command_type;
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "Pi command frame exceeds the {} byte limit",
            MAX_FRAME_BYTES
        ));
    }
    Ok(bytes)
}

fn validate_event_metadata(
    value: &Value,
    worker_epoch: &mut Option<String>,
    last_seq: &mut Option<u64>,
) -> Result<bool, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Pi worker event must be an object".to_string())?;
    if object.get("protocolVersion").and_then(Value::as_u64) != Some(AGENT_PROTOCOL_VERSION) {
        return Err("Pi worker event uses an unsupported protocol version".to_string());
    }
    let event_id = object
        .get("eventId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Pi worker eventId must be a non-empty string".to_string())?;
    let _ = event_id;
    if object.get("replay").and_then(Value::as_bool).is_none() {
        return Err("Pi worker event.replay must be a boolean".to_string());
    }
    match object.get("workerEpoch") {
        Some(Value::String(value)) if !value.trim().is_empty() => {
            if let Some(expected) = worker_epoch {
                if expected != value {
                    return Err("Pi worker epoch changed while the process was running".to_string());
                }
            } else {
                *worker_epoch = Some(value.clone());
            }
        }
        Some(_) => return Err("Pi worker workerEpoch must be a non-empty string".to_string()),
        None if worker_epoch.is_some() => {
            return Err("Pi worker workerEpoch is missing from a later event".to_string());
        }
        None => {}
    }
    if let Some(value) = object.get("seq") {
        let sequence = value
            .as_u64()
            .ok_or_else(|| "Pi worker event.seq must be a non-negative integer".to_string())?;
        if let Some(previous) = last_seq
            && sequence <= *previous
        {
            return Err("Pi worker event.seq is not strictly increasing".to_string());
        }
        *last_seq = Some(sequence);
    }
    let event_type = object
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("type"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Pi worker event.type is required".to_string())?;
    Ok(event_type == "runtime.ready")
}

fn is_sequence_violation(error: &str) -> bool {
    error == "Pi worker event.seq is not strictly increasing"
        || error.starts_with("Pi worker event.seq")
}

async fn read_frame<R>(reader: &mut R) -> io::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut frame = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            if frame.is_empty() {
                return Ok(None);
            }
            trim_carriage_return(&mut frame);
            return Ok(Some(frame));
        }
        if let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            if frame.len().saturating_add(newline) > MAX_FRAME_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Pi worker frame exceeds the byte limit",
                ));
            }
            frame.extend_from_slice(&buffer[..newline]);
            reader.consume(newline + 1);
            trim_carriage_return(&mut frame);
            return Ok(Some(frame));
        }
        if frame.len().saturating_add(buffer.len()) > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Pi worker frame exceeds the byte limit",
            ));
        }
        frame.extend_from_slice(buffer);
        let consumed = buffer.len();
        reader.consume(consumed);
    }
}

fn trim_carriage_return(frame: &mut Vec<u8>) {
    if frame.last() == Some(&b'\r') {
        frame.pop();
    }
}

#[tauri::command]
pub fn pi_worker_status(runtime: State<'_, PiWorkerRuntime>) -> AgentStatus {
    runtime.status()
}

#[tauri::command]
pub async fn start_pi_worker(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    runtime: State<'_, PiWorkerRuntime>,
    request: StartPiWorkerRequest,
) -> Result<AgentStatus, String> {
    let cwd = registry.authorize(&request.cwd)?;
    runtime.inner().start(&app, cwd).await
}

#[tauri::command]
pub async fn send_pi_agent_command(
    app: AppHandle,
    database: State<'_, AppDatabase>,
    registry: State<'_, WorkspaceRegistry>,
    runtime: State<'_, PiWorkerRuntime>,
    command: Value,
) -> Result<(), String> {
    let mut command = command;
    let generation = runtime.active_generation();
    if generation == 0 {
        return Err("Pi worker is not running".to_string());
    }
    let command_type = command
        .get("command")
        .and_then(Value::as_object)
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(str::to_string);
    // Validate the outer protocol envelope (including request correlation and
    // the frame bound) before applying the Host-owned refresh shortcut below.
    // The nested manifest itself is intentionally ignored for that command.
    // Resource roots are a Host-owned capability projection.  Do not forward
    // a renderer-supplied manifest, even when its shape looks valid: a stale
    // or forged path must never become a new Pi read boundary.  Rebuild the
    // manifest from the authenticated worker workspace instead.  The normal
    // settings commands use the same helper directly; this branch protects
    // the generic renderer-facing command as well.
    if command_type.as_deref() == Some("session.resources.refresh") {
        let worker_cwd = runtime.inner().worker_cwd(generation).await?;
        return runtime
            .inner()
            .refresh_resources_if_workspace(&worker_cwd)
            .await;
    }
    if command_type.as_deref() == Some("runtime.models.sync") {
        // Model catalogs and their credential references are likewise
        // Host-owned. Ignore any renderer payload and rebuild from the
        // authenticated worker workspace before crossing the pipe.
        let worker_cwd = runtime.inner().worker_cwd(generation).await?;
        return runtime
            .inner()
            .refresh_models_if_workspace(&worker_cwd)
            .await;
    }
    if let Some(command_type) = command_type.as_deref() {
        validate_command_session_identity(&command, command_type)?;
    }
    if command_type.as_deref() == Some("session.fork") {
        let session_command = command
            .get("command")
            .and_then(Value::as_object)
            .ok_or_else(|| "session.fork command must be an object".to_string())?;
        let source_session_id = session_command
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "session.fork.sessionId is required".to_string())?;
        let target_session_id = session_command
            .get("targetSessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "session.fork.targetSessionId is required".to_string())?;
        let cwd = session_command
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or_else(|| "session.fork.cwd is required".to_string())?;
        let native_entry_id = session_command
            .get("nativeEntryId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "session.fork.nativeEntryId is required".to_string())?;
        let request_id = command
            .get("requestId")
            .map(|value| match value {
                Value::String(value) => Some(value.clone()),
                Value::Number(value) => Some(value.to_string()),
                _ => None,
            })
            .flatten()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "session.fork requestId is required".to_string())?;
        let authorized_cwd = registry.authorize(cwd)?;
        let worker_cwd = runtime.inner().worker_cwd(generation).await?;
        if authorized_cwd != worker_cwd {
            return Err("Pi fork workspace differs from the active worker".to_string());
        }
        let mut connection = database
            .connection
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        begin_pi_session_fork(
            &mut connection,
            source_session_id,
            target_session_id,
            native_entry_id,
            &request_id,
            &worker_cwd,
        )?;
    }
    if matches!(
        command_type.as_deref(),
        Some("session.open" | "session.import")
    ) {
        let session_command = command
            .get("command")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{command_type:?} command must be an object"))?;
        let product_session_id = match (
            session_command.get("productSessionId"),
            session_command.get("sessionId"),
        ) {
            (Some(Value::String(product)), Some(Value::String(session)))
                if product != session && command_type.as_deref() == Some("session.open") =>
            {
                return Err(
                    "session.open productSessionId and sessionId must identify the same product session"
                        .to_string(),
                );
            }
            (Some(Value::String(product)), _) | (_, Some(Value::String(product)))
                if !product.trim().is_empty() =>
            {
                product.clone()
            }
            _ => {
                return Err(if command_type.as_deref() == Some("session.import") {
                    "session.import requires sessionId".to_string()
                } else {
                    "session.open requires productSessionId (or a product sessionId)".to_string()
                });
            }
        };
        if command_type.as_deref() == Some("session.import")
            && command
                .get("sessionId")
                .and_then(Value::as_str)
                .is_some_and(|session_id| session_id != product_session_id)
        {
            return Err("session.import envelope and command sessionId must match".to_string());
        }
        let cwd = session_command
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("{command_type:?}.cwd is required"))?;
        let authorized_cwd = registry.authorize(&cwd)?;
        let worker_cwd = runtime.inner().worker_cwd(generation).await?;
        if authorized_cwd != worker_cwd {
            return Err(
                "Pi worker is bound to a different workspace; restart it before opening this session"
                    .to_string(),
            );
        }
        {
            let connection = database
                .connection
                .lock()
                .map_err(|_| "Database lock poisoned".to_string())?;
            if command_type.as_deref() == Some("session.import") {
                let plan = session_command
                    .get("plan")
                    .ok_or_else(|| "session.import.plan is required".to_string())?;
                validate_pi_session_import(&connection, &product_session_id, &cwd, plan)?;
                let migration_id = session_command
                    .get("migrationId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "session.import.migrationId is required".to_string())?;
                let requested_backup = session_command
                    .get("backup")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "session.import.backup is required".to_string())?;
                validate_pi_migration_import(
                    &connection,
                    migration_id,
                    &product_session_id,
                    plan,
                    requested_backup,
                )?;
            } else {
                validate_pi_session_open(&connection, &product_session_id, &authorized_cwd)?;
            }
        }
    }
    if let Some(command_type) = command_type.as_deref()
        && SESSION_BOUND_PI_COMMANDS.contains(&command_type)
    {
        let session_command = command
            .get("command")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{command_type} command must be an object"))?;
        let session_id = session_command
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("{command_type}.sessionId is required"))?;
        let worker_cwd = runtime.inner().worker_cwd(generation).await?;
        let connection = database
            .connection
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        validate_pi_session_command(&connection, session_id, &worker_cwd)?;
    }
    if matches!(
        command_type.as_deref(),
        Some("turn.cancel" | "session.close")
    ) {
        if let Some(session_command) = command.get("command").and_then(Value::as_object) {
            if let Some(session_id) = session_command
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                let run_id = session_command.get("runId").and_then(Value::as_str);
                let cancel_subagents = if command_type.as_deref() == Some("turn.cancel") {
                    session_command
                        .get("cancelSubagents")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                } else {
                    true
                };
                if let Some(mcp_runtime) = app.try_state::<PiMcpRuntime>() {
                    mcp_runtime
                        .cancel_session(session_id, run_id, cancel_subagents)
                        .await;
                }
                // A monitor streams into one conversation: closing the session
                // stops its processes instead of leaving them orphaned.
                if command_type.as_deref() == Some("session.close") {
                    crate::pi_monitor_runtime::cancel_monitors_for_session(session_id);
                }
            }
        }
    }
    if command_type.as_deref() == Some("turn.submit") {
        let worker_cwd = runtime.inner().worker_cwd(generation).await?;
        if let Err(error) = runtime
            .inner()
            .maybe_inject_memory(&mut command, &worker_cwd)
            .await
        {
            // Memory retrieval is best effort, matching Melody-build's
            // session-start hook. A malformed memory file must not prevent a
            // user prompt from reaching Pi; surface the reason for diagnosis.
            let _ = app.emit(
                PI_AGENT_STDERR,
                format!("Pi memory initial injection skipped: {error}"),
            );
        }
    }
    if command_type.as_deref() == Some("session.import") {
        if let Some(session_id) = command
            .get("command")
            .and_then(Value::as_object)
            .and_then(|value| value.get("sessionId"))
            .and_then(Value::as_str)
            .or_else(|| {
                command
                    .get("command")
                    .and_then(Value::as_object)
                    .and_then(|value| value.get("productSessionId"))
                    .and_then(Value::as_str)
            })
        {
            runtime.inner().reset_memory_session(session_id).await;
        }
    } else if command_type.as_deref() == Some("session.close") {
        if let Some(session_id) = command
            .get("command")
            .and_then(Value::as_object)
            .and_then(|value| value.get("sessionId"))
            .and_then(Value::as_str)
        {
            runtime.inner().forget_memory_injection(session_id).await;
        }
    }
    let frame = encode_command(&command)?;
    runtime.write_frame(generation, &frame, true).await
}

/// Keep the optional envelope affinity and the command's product session in
/// lockstep. The envelope is supplied by the renderer and the nested command
/// is what the worker routes, so accepting conflicting identities would make
/// stale or malformed payloads ambiguous at the Host boundary. Runtime
/// commands without a nested session id remain unscoped.
fn validate_command_session_identity(value: &Value, command_type: &str) -> Result<(), String> {
    let Some(envelope) = value.get("sessionId") else {
        return Ok(());
    };
    let envelope_id = match envelope {
        Value::String(id) if !id.trim().is_empty() => id,
        Value::Null => return Ok(()),
        Value::String(_) => {
            return Err("Pi command envelope.sessionId must not be empty".to_string());
        }
        _ => {
            return Err("Pi command envelope.sessionId must be a string".to_string());
        }
    };
    let Some(command_object) = value.get("command").and_then(Value::as_object) else {
        return Err(format!("{command_type} command must be an object"));
    };
    let Some(nested) = command_object.get("sessionId") else {
        return Ok(());
    };
    let nested_id = match nested {
        Value::String(id) if !id.trim().is_empty() => id,
        Value::Null => return Ok(()),
        Value::String(_) => {
            return Err(format!("{command_type}.sessionId must not be empty"));
        }
        _ => return Err(format!("{command_type}.sessionId must be a string")),
    };
    if envelope_id != nested_id {
        return Err(format!(
            "Pi command envelope.sessionId and {command_type}.sessionId must match"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_pi_worker(
    app: AppHandle,
    runtime: State<'_, PiWorkerRuntime>,
) -> Result<AgentStatus, String> {
    let result = runtime.inner().stop(&app).await;
    if let Some(mcp_runtime) = app.try_state::<PiMcpRuntime>() {
        mcp_runtime.stop_all().await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn command_frames_are_bounded_and_protocol_checked() {
        let frame = encode_command(&json!({
            "protocolVersion": 1,
            "requestId": "health",
            "command": {"type": "runtime.health"}
        }))
        .unwrap();
        assert_eq!(frame.last(), Some(&b'\n'));
        assert!(
            encode_command(&json!({
                "protocolVersion": 2,
                "requestId": "health",
                "command": {"type": "runtime.health"}
            }))
            .is_err()
        );
    }

    #[test]
    fn worker_environment_allowlist_keeps_network_transport_without_ambient_flags() {
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS",
            "MELODY_AUTO_COMPACT_THRESHOLD_PERCENT",
            "MELODY_RESPECT_GITIGNORE",
            "MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON",
            "MELODY_PI_GOAL_POLICY_JSON",
        ] {
            assert!(INHERITED_WORKER_ENV.contains(&key));
        }
        // NODE_OPTIONS, package-manager tokens and arbitrary application
        // flags must remain excluded because the worker starts from env_clear.
        assert!(!INHERITED_WORKER_ENV.contains(&"NODE_OPTIONS"));
        assert!(!INHERITED_WORKER_ENV.contains(&"NPM_TOKEN"));
    }

    #[test]
    fn envrc_projection_filters_injection_names_and_invalid_keys() {
        let parsed = parse_envrc_json(
            br#"{
                "SAFE_FLAG": "enabled",
                "NODE_OPTIONS": "--require ./untrusted.js",
                "DYLD_INSERT_LIBRARIES": "/tmp/inject.dylib",
                "bad-name": "ignored",
                "NUMBER": 42
            }"#,
        )
        .unwrap();
        assert_eq!(
            parsed,
            vec![("SAFE_FLAG".to_string(), "enabled".to_string())]
        );
    }

    #[test]
    fn envrc_projection_rejects_oversized_values() {
        let oversized = "x".repeat(ENVRC_MAX_VALUE_BYTES + 1);
        let payload = serde_json::json!({"SAFE_FLAG": oversized});
        let bytes = serde_json::to_vec(&payload).unwrap();
        let error = parse_envrc_json(&bytes).unwrap_err();
        assert!(error.contains("超过大小限制"));
    }

    #[test]
    fn session_message_bound_never_exceeds_requested_bytes() {
        let bounded = bound_session_text("0123456789", 8);
        assert!(bounded.len() <= 8);
        let bounded = bound_session_text("你好世界", 5);
        assert!(bounded.len() <= 5);
        assert!(bounded.is_char_boundary(bounded.len()));
    }

    #[test]
    fn command_session_identity_rejects_conflicting_envelope_affinity() {
        assert!(
            validate_command_session_identity(
                &json!({
                    "sessionId": "s1",
                    "command": {"type": "turn.cancel", "sessionId": "s2"}
                }),
                "turn.cancel"
            )
            .is_err()
        );
        validate_command_session_identity(
            &json!({
                "sessionId": "s1",
                "command": {"type": "turn.cancel", "sessionId": "s1"}
            }),
            "turn.cancel",
        )
        .unwrap();
        validate_command_session_identity(
            &json!({
                "command": {"type": "runtime.health"}
            }),
            "runtime.health",
        )
        .unwrap();
    }

    #[test]
    fn event_metadata_requires_monotonic_epoch_and_ready_shape() {
        let mut epoch = None;
        let mut sequence = None;
        let ready = json!({
            "protocolVersion": 1,
            "eventId": "epoch:0",
            "seq": 0,
            "workerEpoch": "epoch",
            "replay": false,
            "event": {"type": "runtime.ready"}
        });
        assert!(validate_event_metadata(&ready, &mut epoch, &mut sequence).unwrap());
        let duplicate = json!({
            "protocolVersion": 1,
            "eventId": "epoch:0-copy",
            "seq": 0,
            "workerEpoch": "epoch",
            "replay": false,
            "event": {"type": "runtime.warning"}
        });
        assert!(validate_event_metadata(&duplicate, &mut epoch, &mut sequence).is_err());
    }

    #[test]
    fn unscoped_runtime_events_do_not_require_a_product_session() {
        assert!(is_unscoped_pi_event(&json!({
            "event": {"type": "runtime.ready"}
        })));
        assert!(is_unscoped_pi_event(&json!({
            "sessionId": "   ",
            "event": {"type": "runtime.warning"}
        })));
        assert!(!is_unscoped_pi_event(&json!({
            "sessionId": "session-1",
            "event": {"type": "session.opened"}
        })));
    }

    #[tokio::test]
    async fn frames_preserve_crlf_and_reject_oversized_payloads() {
        let mut reader = BufReader::new(std::io::Cursor::new(b"hello\r\nworld".to_vec()));
        assert_eq!(
            read_frame(&mut reader).await.unwrap(),
            Some(b"hello".to_vec())
        );
        assert_eq!(
            read_frame(&mut reader).await.unwrap(),
            Some(b"world".to_vec())
        );
        let mut oversized = BufReader::new(std::io::Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1]));
        assert!(read_frame(&mut oversized).await.is_err());
    }
}
