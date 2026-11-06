use std::{
    env, io,
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::{Mutex, oneshot},
    time::{Duration, timeout},
};

use crate::{
    agent_runtime::{AgentPhase, AgentStatus, melody_home},
    config_runtime::{pi_model_network_policy, pi_resource_manifest},
    database::{AppDatabase, PiEventPersistence, append_pi_event, validate_pi_session_workspace},
    pi_mcp_runtime::PiMcpRuntime,
    pi_model_config::{self, PreparedPiModels},
    pi_tool_gateway,
    workspace_access::WorkspaceRegistry,
};

mod dispatch_ledger;
mod envrc;
mod event_acceptance;
mod event_pipeline;
mod host_tool_routing;
mod launch;
mod memory_lifecycle;
mod protocol;
mod session_commands;

pub(crate) use self::dispatch_ledger::TurnDispatchOutcome;
use self::dispatch_ledger::{DISPATCH_ACK_TIMEOUT, DispatchLedger};
use self::envrc::load_envrc;
use self::event_acceptance::{EventAcceptance, PiWorkerEventAcceptance};
use self::protocol::{AGENT_PROTOCOL_VERSION, encode_command, read_frame};

pub(crate) const PI_AGENT_EVENT: &str = "melody://pi-agent-event";
pub(crate) const PI_AGENT_STDERR: &str = "melody://pi-agent-stderr";
pub(crate) const PI_AGENT_STATUS: &str = "melody://pi-agent-status";

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const CHILD_REAP_TIMEOUT: Duration = Duration::from_secs(2);

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
    memory_lifecycle: memory_lifecycle::HostMemoryLifecycle,
    dispatch: DispatchLedger,
    status: RwLock<AgentStatus>,
    next_generation: AtomicU64,
    active_generation: AtomicU64,
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
    event_acceptance: PiWorkerEventAcceptance,
}

impl Default for PiWorkerInner {
    fn default() -> Self {
        Self {
            operation: Mutex::new(()),
            process: Mutex::new(None),
            memory_lifecycle: memory_lifecycle::HostMemoryLifecycle::default(),
            dispatch: DispatchLedger::default(),
            status: RwLock::new(AgentStatus::default()),
            next_generation: AtomicU64::new(0),
            active_generation: AtomicU64::new(0),
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
        let acceptance = process.event_acceptance.accept(value)?;
        if matches!(acceptance, EventAcceptance::New { ready_event: true }) {
            process.ready = true;
            if let Some(handshake) = process.handshake.take() {
                let _ = handshake.send(Ok(()));
            }
        }
        Ok(acceptance)
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
        let receiver = self.inner.dispatch.begin(prompt_id, request_id)?;
        let mut frame = serde_json::to_vec(command).map_err(|error| error.to_string())?;
        frame.push(b'\n');
        if let Err(error) = self.write_frame(generation, &frame, true).await {
            self.inner.dispatch.clear_prompt(prompt_id);
            return Err(error);
        }
        match tokio::time::timeout(DISPATCH_ACK_TIMEOUT, receiver).await {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(_)) => Ok(TurnDispatchOutcome::Unacknowledged),
            Err(_) => {
                self.inner.dispatch.clear_prompt(prompt_id);
                Ok(TurnDispatchOutcome::Unacknowledged)
            }
        }
    }

    pub(crate) fn session_config_revision(&self, session_id: &str) -> i64 {
        self.inner.dispatch.session_config_revision(session_id)
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
        self.inner.memory_lifecycle.flush_transcripts(app).await;
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
        self.inner.dispatch.clear_generation();
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
        self.inner.memory_lifecycle.flush_transcripts(app).await;
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
            self.inner.memory_lifecycle.clear().await;
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
        self.inner.memory_lifecycle.flush_transcripts(app).await;
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

        let Some(binary) = launch::resolve_worker_binary(app) else {
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
        self.inner.memory_lifecycle.clear().await;

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
        let envrc = match load_envrc(&cwd, launch::INHERITED_WORKER_ENV).await {
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
        launch::configure_worker_command(
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
            event_acceptance: PiWorkerEventAcceptance::default(),
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
                            if let Err(error) = event_pipeline::process_stdout_event(
                                &stdout_runtime,
                                &stdout_app,
                                generation,
                                &value,
                                worker_cwd.as_deref(),
                            )
                            .await
                            {
                                failure = Some(error);
                                break;
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
    session_commands::preflight(
        &command,
        command_type.as_deref(),
        generation,
        runtime.inner(),
        database.inner(),
        registry.inner(),
    )
    .await?;
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
            .inner
            .memory_lifecycle
            .maybe_inject(&mut command, &worker_cwd)
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
            runtime
                .inner()
                .inner
                .memory_lifecycle
                .reset_session(session_id)
                .await;
        }
    } else if command_type.as_deref() == Some("session.close") {
        if let Some(session_id) = command
            .get("command")
            .and_then(Value::as_object)
            .and_then(|value| value.get("sessionId"))
            .and_then(Value::as_str)
        {
            runtime
                .inner()
                .inner
                .memory_lifecycle
                .forget_injection(session_id)
                .await;
        }
    }
    let frame = encode_command(&command)?;
    runtime.write_frame(generation, &frame, true).await
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
