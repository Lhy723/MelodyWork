//! Host-owned foreground and background terminal process lifecycle.
//!
//! This module keeps bounded output capture, process supervision, cancellation,
//! and session/workspace ownership of terminal tasks together. The parent
//! gateway remains responsible for approving requests and routing the shared
//! task-control protocol between terminals and monitors.

use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{RecvTimeoutError, SyncSender, sync_channel},
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{Map, Value, json};

use crate::config_core::PiTerminalPolicy;
use crate::pi_tool_output_archive::TerminalOutputCapture;

use super::{
    GET_COMMAND_OR_SUBAGENT_OUTPUT, HOST_TASK_CONTROL_POLL_INTERVAL, KILL_COMMAND_OR_SUBAGENT,
    WAIT_COMMANDS_OR_SUBAGENTS, task_timeout_ms,
};

const TERMINAL_OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const TERMINAL_OUTPUT_CHANNEL_CAPACITY: usize = 32;
pub(super) const PI_BACKGROUND_TERMINAL_TASK_PREFIX: &str = "pi-terminal-task:";
const BACKGROUND_TERMINAL_MAX_TASKS: usize = 64;
const BACKGROUND_TASK_CONTROL_MAX_OUTPUT_BYTES: usize = 64 * 1024;
// Melody-build's bash tool defaults to a two-minute timeout. Keep the Pi
// gateway default identical; callers may still request a shorter bound.
const TERMINAL_DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const TERMINAL_MAX_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackgroundTaskStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl BackgroundTaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug)]
struct BackgroundTaskState {
    status: BackgroundTaskStatus,
    output: String,
    /// Set once the collector published the final status and output. Waiters use
    /// it instead of `status` because a cancel publishes `cancelled` before the
    /// child is reaped, and the reaping must still be observable.
    finished: bool,
}

/// The two flags the collector and the cancel path share.
///
/// `reaped` is published by the collector the moment `try_wait`/`wait` yields an
/// exit status, so a cancel that arrives afterwards can tell the difference
/// between "still running" and "already finished, pipes draining".
#[derive(Debug, Default)]
struct BackgroundTaskControl {
    cancel: AtomicBool,
    reaped: AtomicBool,
}

/// A Host-owned terminal process. The child is deliberately kept inside the
/// collector thread: the cancellation flag is the only cross-thread control
/// surface, so callers never gain a raw process handle or an unbounded output
/// buffer.
struct BackgroundTerminalTask {
    task_id: String,
    owner_session_id: String,
    root: PathBuf,
    /// The exact shell command, kept so the session panel can label the task
    /// without re-reading model history.
    command: String,
    /// Unix milliseconds. The panel uses it to order finished tasks so it can
    /// keep the most recent ones without inventing a second registry.
    started_at: u64,
    control: BackgroundTaskControl,
    state: Mutex<BackgroundTaskState>,
    changed: Condvar,
}

static BACKGROUND_TERMINAL_TASKS: OnceLock<Mutex<HashMap<String, Arc<BackgroundTerminalTask>>>> =
    OnceLock::new();

fn background_terminal_tasks() -> &'static Mutex<HashMap<String, Arc<BackgroundTerminalTask>>> {
    BACKGROUND_TERMINAL_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn background_task_snapshot(task: &BackgroundTerminalTask) -> Value {
    let state = task
        .state
        .lock()
        .expect("background task state must not be poisoned");
    json!({
        "task_id": task.task_id,
        "command": task.command,
        "status": state.status.as_str(),
        "output": bound_task_output(&state.output),
    })
}

/// The lightweight shape the session panel reads: no captured output, so a
/// four-second poll of the whole registry stays small. Output remains available
/// to the model through `get_command_or_subagent_output`.
fn background_task_entry(task: &BackgroundTerminalTask) -> Value {
    let status = task
        .state
        .lock()
        .map(|state| state.status.as_str())
        .unwrap_or("unknown");
    json!({
        "task_id": task.task_id,
        "command": task.command,
        "status": status,
        "started_at": task.started_at,
    })
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn bound_task_output(value: &str) -> String {
    if value.len() <= BACKGROUND_TASK_CONTROL_MAX_OUTPUT_BYTES {
        return value.to_string();
    }
    const SUFFIX: &str = "\n[task output truncated]";
    let limit = BACKGROUND_TASK_CONTROL_MAX_OUTPUT_BYTES;
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
    let mut output = value[..end].to_string();
    output.push_str(SUFFIX);
    output
}

fn prune_background_terminal_tasks(
    tasks: &mut HashMap<String, Arc<BackgroundTerminalTask>>,
) -> Result<(), String> {
    if tasks.len() < BACKGROUND_TERMINAL_MAX_TASKS {
        return Ok(());
    }
    let completed = tasks
        .iter()
        .filter_map(|(id, task)| {
            let state = task.state.lock().ok()?;
            state.finished.then(|| id.clone())
        })
        .collect::<Vec<_>>();
    for id in completed {
        tasks.remove(&id);
        if tasks.len() < BACKGROUND_TERMINAL_MAX_TASKS {
            return Ok(());
        }
    }
    Err(format!(
        "Too many background terminal tasks are active (maximum {})",
        BACKGROUND_TERMINAL_MAX_TASKS
    ))
}

enum TerminalOutputMessage {
    Chunk(Vec<u8>),
    Finished(Option<String>),
}

fn spawn_terminal_output_reader<R>(mut reader: R, sender: SyncSender<TerminalOutputMessage>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = vec![0_u8; TERMINAL_OUTPUT_CHUNK_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.send(TerminalOutputMessage::Finished(None));
                    return;
                }
                Ok(bytes_read) => {
                    if sender
                        .send(TerminalOutputMessage::Chunk(buffer[..bytes_read].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(TerminalOutputMessage::Finished(Some(error.to_string())));
                    return;
                }
            }
        }
    });
}

fn collect_terminal_output(
    root: &Path,
    child: &mut std::process::Child,
    timeout_ms: u64,
    policy: Option<PiTerminalPolicy>,
) -> Result<(std::process::ExitStatus, String), String> {
    let (status, output, _) =
        collect_terminal_output_controlled(root, child, Some(timeout_ms), policy, None)?;
    Ok((status, output))
}

fn collect_terminal_output_controlled(
    root: &Path,
    child: &mut std::process::Child,
    timeout_ms: Option<u64>,
    policy: Option<PiTerminalPolicy>,
    control: Option<&BackgroundTaskControl>,
) -> Result<(std::process::ExitStatus, String, bool), String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Terminal command stdout pipe is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Terminal command stderr pipe is unavailable".to_string())?;
    let (sender, receiver) = sync_channel(TERMINAL_OUTPUT_CHANNEL_CAPACITY);
    spawn_terminal_output_reader(stdout, sender.clone());
    spawn_terminal_output_reader(stderr, sender);

    let deadline = timeout_ms.map(|timeout_ms| Instant::now() + Duration::from_millis(timeout_ms));
    let mut capture = TerminalOutputCapture::with_policy(root, policy);
    let mut finished_readers = 0_usize;
    let mut reader_errors = Vec::new();
    let mut status = None;
    let mut timed_out = false;
    let mut cancelled = false;
    let mut drain_deadline = None;

    while finished_readers < 2 {
        if status.is_none() {
            // A cancel request wins over a concurrent exit: the caller asked for
            // this task to stop while it was running, so the task must report
            // `cancelled` even if the kill and the child's own exit land in the
            // same poll. Only a child that was already reaped before the request
            // (the `status.is_none()` guard) keeps its natural outcome.
            if control.is_some_and(|control| control.cancel.load(Ordering::Acquire)) {
                cancelled = true;
                let _ = child.kill();
                status = Some(child.wait().map_err(|error| {
                    format!("Failed to stop cancelled terminal command: {error}")
                })?);
                // A command can leave a grandchild holding the pipe open;
                // keep a short drain window, then detach the reader threads.
                drain_deadline = Some(Instant::now() + Duration::from_millis(250));
            } else if let Some(child_status) = child
                .try_wait()
                .map_err(|error| format!("Failed to poll terminal command: {error}"))?
            {
                status = Some(child_status);
                drain_deadline = Some(Instant::now() + Duration::from_secs(1));
            } else if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                timed_out = true;
                let _ = child.kill();
                status = Some(child.wait().map_err(|error| {
                    format!("Failed to stop timed-out terminal command: {error}")
                })?);
                // A command can leave a grandchild holding the pipe open;
                // keep a short drain window, then detach the reader threads.
                drain_deadline = Some(Instant::now() + Duration::from_millis(250));
            }
            if status.is_some() {
                if let Some(control) = control {
                    control.reaped.store(true, Ordering::Release);
                }
            }
        }

        if let Some(drain_deadline) = drain_deadline {
            if Instant::now() >= drain_deadline {
                break;
            }
        }

        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(TerminalOutputMessage::Chunk(bytes)) => capture.push(&bytes),
            Ok(TerminalOutputMessage::Finished(error)) => {
                finished_readers += 1;
                if let Some(error) = error {
                    reader_errors.push(error);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let status = match status {
        Some(status) => status,
        None => child
            .wait()
            .map_err(|error| format!("Failed to wait for terminal command: {error}"))?,
    };
    let mut output = capture.finish();
    if !reader_errors.is_empty() {
        output.push_str("\n[terminal output read warning: ");
        output.push_str(&reader_errors.join("; "));
        output.push(']');
    }
    if timed_out {
        return Err(format!(
            "command timed out after {} ms: {output}",
            timeout_ms.unwrap_or_default()
        ));
    }
    Ok((status, output, cancelled))
}

/// Run a terminal command with the default policy.
///
/// Test-only: production dispatch always passes the Host-resolved policy and the
/// session id, so the default-policy wrapper exists only for the sandbox tests.

/// Build the process that runs one terminal command.
///
/// The sandbox decision lives in `workspace_sandbox` so the monitor path cannot
/// drift from the terminal path; a profile that cannot be enforced fails closed
/// instead of running the command unsandboxed.
pub(super) fn terminal_process(
    root: &Path,
    command: &str,
    sandbox_profile: Option<&str>,
) -> Result<Command, String> {
    crate::workspace_sandbox::sandboxed_shell_command(root, sandbox_profile, command, true)
}

pub(super) fn effective_terminal_timeout_ms(
    arguments: &Value,
    policy: Option<PiTerminalPolicy>,
) -> u64 {
    let (default_timeout_ms, max_timeout_ms) = policy
        .map(|policy| (policy.default_timeout_ms, policy.max_timeout_ms))
        .unwrap_or((
            TERMINAL_DEFAULT_TIMEOUT.as_millis() as u64,
            TERMINAL_MAX_TIMEOUT.as_millis() as u64,
        ));
    arguments
        .as_object()
        .and_then(|arguments| arguments.get("timeoutMs"))
        .and_then(Value::as_u64)
        .filter(|timeout_ms| *timeout_ms > 0)
        .unwrap_or(default_timeout_ms)
        .clamp(1, max_timeout_ms.max(1))
}

pub(super) fn run_terminal_with_policy(
    root: &Path,
    arguments: &Value,
    policy: Option<PiTerminalPolicy>,
    owner_session_id: Option<&str>,
) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "run_terminal_command arguments must be an object".to_string())?;
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "command must be a string".to_string())?;
    if command.trim().is_empty() {
        return Err("command must not be empty".to_string());
    }
    let background = arguments
        .get("background")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "background must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    if background {
        let owner_session_id = owner_session_id.ok_or_else(|| {
            "background terminal tasks require a product session identity".to_string()
        })?;
        return start_background_terminal(root, arguments, policy, owner_session_id);
    }
    let timeout_ms = effective_terminal_timeout_ms(&Value::Object(arguments.clone()), policy);
    let sandbox_profile = crate::config_runtime::pi_sandbox_profile(&root.to_string_lossy());
    let mut process = terminal_process(root, command, sandbox_profile.as_deref())?;
    let mut child = process
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start terminal command: {error}"))?;
    let (status, output) = collect_terminal_output(root, &mut child, timeout_ms, policy)?;
    if status.success() {
        Ok(output)
    } else {
        Err(format!("command exited with {status}: {output}"))
    }
}

fn effective_background_timeout_ms(
    arguments: &Map<String, Value>,
    policy: Option<PiTerminalPolicy>,
) -> Result<Option<u64>, String> {
    let Some(value) = arguments.get("timeoutMs") else {
        return Ok(None);
    };
    let requested = value
        .as_u64()
        .ok_or_else(|| "timeoutMs must be a non-negative integer".to_string())?;
    if requested == 0 {
        return Ok(None);
    }
    let max_timeout_ms = policy
        .map(|policy| policy.max_timeout_ms)
        .unwrap_or(TERMINAL_MAX_TIMEOUT.as_millis() as u64)
        .clamp(1, TERMINAL_MAX_TIMEOUT.as_millis() as u64);
    Ok(Some(requested.clamp(1, max_timeout_ms)))
}

fn spawn_terminal_process(root: &Path, command: &str) -> Result<std::process::Child, String> {
    let sandbox_profile = crate::config_runtime::pi_sandbox_profile(&root.to_string_lossy());
    let mut process = terminal_process(root, command, sandbox_profile.as_deref())?;
    process
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start terminal command: {error}"))
}

fn start_background_terminal(
    root: &Path,
    arguments: &Map<String, Value>,
    policy: Option<PiTerminalPolicy>,
    owner_session_id: &str,
) -> Result<String, String> {
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "command must be a string".to_string())?;
    if command.trim().is_empty() {
        return Err("command must not be empty".to_string());
    }
    let timeout_ms = effective_background_timeout_ms(arguments, policy)?;
    let mut child = spawn_terminal_process(root, command)?;
    let task_id = format!(
        "{}{}",
        PI_BACKGROUND_TERMINAL_TASK_PREFIX,
        uuid::Uuid::new_v4().simple()
    );
    let task = Arc::new(BackgroundTerminalTask {
        task_id: task_id.clone(),
        owner_session_id: owner_session_id.to_string(),
        root: root.to_path_buf(),
        command: command.to_string(),
        started_at: unix_millis(),
        control: BackgroundTaskControl::default(),
        state: Mutex::new(BackgroundTaskState {
            status: BackgroundTaskStatus::Running,
            output: String::new(),
            finished: false,
        }),
        changed: Condvar::new(),
    });
    if let Err(error) = (|| {
        let mut tasks = background_terminal_tasks()
            .lock()
            .map_err(|_| "Background terminal task registry is unavailable".to_string())?;
        prune_background_terminal_tasks(&mut tasks)?;
        tasks.insert(task_id.clone(), Arc::clone(&task));
        Ok::<(), String>(())
    })() {
        // `std::process::Child` is not killed when dropped. If the bounded
        // registry rejects a new task, terminate the just-created process so
        // a failed request cannot leak an orphan shell.
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    let worker_task = Arc::clone(&task);
    let worker_root = root.to_path_buf();
    thread::spawn(move || {
        let mut child = child;
        let result = collect_terminal_output_controlled(
            &worker_root,
            &mut child,
            timeout_ms,
            policy,
            Some(&worker_task.control),
        );
        let (status, output) = match result {
            Ok((exit_status, output, cancelled)) => {
                if cancelled {
                    (BackgroundTaskStatus::Cancelled, output)
                } else if exit_status.success() {
                    (BackgroundTaskStatus::Completed, output)
                } else {
                    (
                        BackgroundTaskStatus::Failed,
                        format!("command exited with {exit_status}: {output}"),
                    )
                }
            }
            Err(error) => {
                let cancelled = worker_task.control.cancel.load(Ordering::Acquire);
                (
                    if cancelled {
                        BackgroundTaskStatus::Cancelled
                    } else {
                        BackgroundTaskStatus::Failed
                    },
                    error,
                )
            }
        };
        if let Ok(mut state) = worker_task.state.lock() {
            // A cancel request published `cancelled` while the child was still
            // running; the collector's own outcome must not downgrade it.
            if state.status != BackgroundTaskStatus::Cancelled {
                state.status = status;
            }
            state.output = output;
            state.finished = true;
            worker_task.changed.notify_all();
        }
    });

    Ok(json!({
        "task_id": task_id,
        "status": BackgroundTaskStatus::Running.as_str(),
        "message": "Background terminal task started; use get_command_or_subagent_output to inspect it."
    })
    .to_string())
}

fn task_id_argument(arguments: &Map<String, Value>) -> Result<&str, String> {
    let task_id = arguments
        .get("task_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "task_id must be a non-empty string".to_string())?;
    if !task_id.starts_with(PI_BACKGROUND_TERMINAL_TASK_PREFIX) {
        return Err("task_id is not a Host-owned background terminal task".to_string());
    }
    Ok(task_id)
}

/// Read a task id without assuming its kind. `task_id_argument` keeps the
/// terminal-only guard for the terminal registry; monitors share the same tool
/// surface but their own registry.
fn authorize_background_task(
    root: &Path,
    owner_session_id: &str,
    task_id: &str,
) -> Result<Arc<BackgroundTerminalTask>, String> {
    let task = background_terminal_tasks()
        .lock()
        .map_err(|_| "Background terminal task registry is unavailable".to_string())?
        .get(task_id)
        .cloned()
        .ok_or_else(|| format!("Background task not found: {task_id}"))?;
    if !owns(&task, root, owner_session_id) {
        return Err("Background task does not belong to this session workspace".to_string());
    }
    Ok(task)
}

/// The one ownership rule for Host terminal tasks: the caller's product session
/// must be the recorded owner and its workspace must be the task's root.
fn owns(task: &BackgroundTerminalTask, root: &Path, owner_session_id: &str) -> bool {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let task_root = task
        .root
        .canonicalize()
        .unwrap_or_else(|_| task.root.clone());
    task.owner_session_id == owner_session_id && task_root == canonical_root
}

/// List this session's terminal tasks as lightweight entries. Ownership uses the
/// same rule as cancellation; finished tasks stay listed until the bounded
/// registry prunes them, so the panel can show a final state.
pub(super) fn list_background_tasks(root: &Path, owner_session_id: &str) -> Vec<Value> {
    let Ok(tasks) = background_terminal_tasks().lock() else {
        return Vec::new();
    };
    let mut entries = tasks
        .values()
        .filter(|task| owns(task, root, owner_session_id))
        .map(|task| background_task_entry(task))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left["task_id"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["task_id"].as_str().unwrap_or_default())
    });
    entries
}

/// Cancel one of this session's terminal tasks and return its resulting entry.
/// A task that already finished is not an error: the entry reports its terminal
/// status so the caller can render "already ended" instead of a failure.
pub(super) fn cancel_background_task(
    root: &Path,
    owner_session_id: &str,
    task_id: &str,
) -> Result<Value, String> {
    let task_id = task_id.trim();
    if !task_id.starts_with(PI_BACKGROUND_TERMINAL_TASK_PREFIX) {
        return Err("task_id is not a Host-owned background terminal task".to_string());
    }
    let task = authorize_background_task(root, owner_session_id, task_id)?;
    request_cancel(&task);
    wait_background_task(&task, 2_000);
    Ok(background_task_entry(&task))
}

/// Claim a still-running task for cancellation and return whether it was claimed.
///
/// The status is published here, under the state lock, instead of being derived
/// later from the child's exit: `SIGTERM` makes a killed child look like a normal
/// exit to the collector, so classifying on `try_wait` alone reported a stopped
/// task as completed. Publishing first also means the entry returned to the panel
/// and every later poll already read `cancelled`.
///
/// A task that already settled keeps its terminal status; a cancel racing a
/// natural exit is not allowed to relabel finished work.
fn request_cancel(task: &BackgroundTerminalTask) -> bool {
    let Ok(mut state) = task.state.lock() else {
        return false;
    };
    if state.finished {
        return false;
    }
    // Reaped but not yet published: the child already exited on its own, and the
    // collector is only draining pipes. Claiming it here would relabel finished
    // work as stopped; `wait_background_task` waits for the real outcome instead.
    if task.control.reaped.load(Ordering::Acquire) {
        return false;
    }
    if state.status != BackgroundTaskStatus::Cancelled {
        state.status = BackgroundTaskStatus::Cancelled;
    }
    task.control.cancel.store(true, Ordering::Release);
    task.changed.notify_all();
    true
}

/// Wait for the collector to publish the final status, not for a status change:
/// a cancelled task already reads `cancelled` while its child is still dying.
fn wait_background_task(task: &BackgroundTerminalTask, timeout_ms: u64) {
    let mut state = match task.state.lock() {
        Ok(state) => state,
        Err(_) => return,
    };
    if state.finished || timeout_ms == 0 {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while !state.finished {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (next, result) = match task.changed.wait_timeout(state, remaining) {
            Ok(value) => value,
            Err(_) => return,
        };
        state = next;
        if result.timed_out() {
            break;
        }
    }
}

pub(super) fn resolve_control(
    root: &Path,
    owner_session_id: &str,
    tool_name: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    match tool_name {
        GET_COMMAND_OR_SUBAGENT_OUTPUT => {
            let task_id = task_id_argument(arguments)?;
            let task = authorize_background_task(root, owner_session_id, task_id)?;
            wait_background_task(&task, task_timeout_ms(arguments, 0)?);
            Ok(background_task_snapshot(&task).to_string())
        }
        KILL_COMMAND_OR_SUBAGENT => {
            let task_id = task_id_argument(arguments)?;
            let task = authorize_background_task(root, owner_session_id, task_id)?;
            request_cancel(&task);
            wait_background_task(&task, 5_000);
            Ok(background_task_snapshot(&task).to_string())
        }
        WAIT_COMMANDS_OR_SUBAGENTS => {
            let task_ids = arguments
                .get("task_ids")
                .and_then(Value::as_array)
                .ok_or_else(|| "task_ids must be an array".to_string())?;
            if task_ids.is_empty() || task_ids.len() > 20 {
                return Err("task_ids must contain between 1 and 20 entries".to_string());
            }
            let mode = arguments
                .get("mode")
                .and_then(Value::as_str)
                .ok_or_else(|| "mode must be wait_any or wait_all".to_string())?;
            if !matches!(mode, "wait_any" | "wait_all") {
                return Err(format!("Unsupported wait mode: {mode}"));
            }
            let tasks = task_ids
                .iter()
                .map(|value| {
                    let task_id = value
                        .as_str()
                        .ok_or_else(|| "task_ids must contain strings".to_string())?;
                    authorize_background_task(root, owner_session_id, task_id)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let timeout_ms = task_timeout_ms(arguments, 30_000)?;
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                let completed = tasks.iter().filter(|task| {
                    task.state
                        .lock()
                        .map(|state| state.finished)
                        .unwrap_or(true)
                });
                let should_return = match mode {
                    "wait_any" => completed.count() > 0,
                    "wait_all" => completed.count() == tasks.len(),
                    _ => unreachable!(),
                };
                if should_return || timeout_ms == 0 || Instant::now() >= deadline {
                    break;
                }
                thread::sleep(
                    HOST_TASK_CONTROL_POLL_INTERVAL
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            let snapshots = tasks
                .iter()
                .map(|task| background_task_snapshot(task))
                .collect::<Vec<_>>();
            Ok(Value::Array(snapshots).to_string())
        }
        _ => Err(format!("Unsupported background task tool: {tool_name}")),
    }
}

pub(super) fn cancel_background_tasks_for_workspace(root: &Path) {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let Ok(tasks) = background_terminal_tasks().lock() else {
        return;
    };
    for task in tasks.values() {
        let task_root = task
            .root
            .canonicalize()
            .unwrap_or_else(|_| task.root.clone());
        if task_root == canonical_root {
            request_cancel(task);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_task(
        id: &str,
        owner: &str,
        root: &Path,
        command: &str,
        status: BackgroundTaskStatus,
        output: &str,
    ) -> BackgroundTerminalTask {
        BackgroundTerminalTask {
            task_id: id.to_string(),
            owner_session_id: owner.to_string(),
            root: root.to_path_buf(),
            command: command.to_string(),
            started_at: 1_700_000_000_000,
            control: BackgroundTaskControl::default(),
            state: Mutex::new(BackgroundTaskState {
                status,
                output: output.to_string(),
                finished: status != BackgroundTaskStatus::Running,
            }),
            changed: Condvar::new(),
        }
    }

    #[test]
    fn owns_accepts_the_recorded_owner_in_the_same_workspace() {
        let root = std::env::temp_dir();
        let task = test_task(
            "pi-terminal-task:a",
            "session-a",
            &root,
            "sleep 300",
            BackgroundTaskStatus::Running,
            "",
        );
        assert!(owns(&task, &root, "session-a"));
    }

    #[test]
    fn owns_rejects_a_foreign_session_or_workspace() {
        let root = std::env::temp_dir();
        let task = test_task(
            "pi-terminal-task:a",
            "session-a",
            &root,
            "sleep 300",
            BackgroundTaskStatus::Running,
            "",
        );
        assert!(!owns(&task, &root, "session-b"));
        assert!(!owns(&task, &root.join("other-workspace"), "session-a"));
    }

    #[test]
    fn entry_reports_identity_status_and_command_without_output() {
        let root = std::env::temp_dir();
        let task = test_task(
            "pi-terminal-task:a",
            "session-a",
            &root,
            "sleep 300",
            BackgroundTaskStatus::Cancelled,
            "noise",
        );
        let entry = background_task_entry(&task);
        assert_eq!(entry["task_id"].as_str(), Some("pi-terminal-task:a"));
        assert_eq!(entry["command"].as_str(), Some("sleep 300"));
        assert_eq!(entry["status"].as_str(), Some("cancelled"));
        assert_eq!(entry["started_at"].as_u64(), Some(1_700_000_000_000));
        assert!(entry.get("output").is_none());
    }

    #[test]
    fn model_snapshot_carries_the_command_and_bounded_output() {
        let root = std::env::temp_dir();
        let task = test_task(
            "pi-terminal-task:a",
            "session-a",
            &root,
            "sleep 300",
            BackgroundTaskStatus::Running,
            "line",
        );
        let snapshot = background_task_snapshot(&task);
        assert_eq!(snapshot["command"].as_str(), Some("sleep 300"));
        assert_eq!(snapshot["output"].as_str(), Some("line"));
        assert_eq!(snapshot["status"].as_str(), Some("running"));
    }

    #[test]
    fn owner_lists_and_cancels_a_real_background_task() {
        let root =
            std::env::temp_dir().join(format!("melody-bg-task-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).expect("scratch workspace");
        let mut arguments = Map::new();
        arguments.insert("command".into(), json!("sleep 30"));
        arguments.insert("background".into(), json!(true));
        let started: Value = serde_json::from_str(
            &start_background_terminal(&root, &arguments, None, "session-owner")
                .expect("background task starts"),
        )
        .expect("start result is JSON");
        let task_id = started["task_id"]
            .as_str()
            .expect("start result carries a task id")
            .to_string();

        let listed = list_background_tasks(&root, "session-owner");
        assert!(listed.iter().any(|entry| {
            entry["task_id"].as_str() == Some(task_id.as_str())
                && entry["command"].as_str() == Some("sleep 30")
                && entry["status"].as_str() == Some("running")
        }));
        assert!(list_background_tasks(&root, "session-other").is_empty());
        assert!(list_background_tasks(&root.join("elsewhere"), "session-owner").is_empty());

        let cancelled = cancel_background_task(&root, "session-owner", &task_id)
            .expect("the owner may cancel its task");
        assert_eq!(cancelled["status"].as_str(), Some("cancelled"));
        assert!(cancelled.get("output").is_none());
        // A cancelled status is only reported after the collector reaped the
        // child, so this also proves the process is gone.
        let listed_after = list_background_tasks(&root, "session-owner");
        assert!(
            listed_after
                .iter()
                .any(|entry| entry["task_id"].as_str() == Some(task_id.as_str())
                    && entry["status"].as_str() == Some("cancelled"))
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cancel_rejects_ids_that_are_not_host_terminal_tasks() {
        let root = std::env::temp_dir();
        let error = cancel_background_task(&root, "session-a", "session:task:1")
            .expect_err("a worker task id must not reach the terminal registry");
        assert!(error.contains("not a Host-owned background terminal task"));
    }

    fn start_task_in(root: &Path, command: &str, session: &str) -> String {
        let mut arguments = Map::new();
        arguments.insert("command".into(), json!(command));
        arguments.insert("background".into(), json!(true));
        let started: Value = serde_json::from_str(
            &start_background_terminal(root, &arguments, None, session)
                .expect("background task starts"),
        )
        .expect("start result is JSON");
        started["task_id"]
            .as_str()
            .expect("start result carries a task id")
            .to_string()
    }

    /// The child is alive when the cancel arrives but exits on its own moments
    /// later. `SIGKILL` makes that look like a normal exit to the collector, so a
    /// status derived from `try_wait` reported `completed`; the cancel request
    /// must win because the task was still running when the user asked to stop it.
    #[test]
    fn cancel_reports_cancelled_when_the_child_is_still_running() {
        let root =
            std::env::temp_dir().join(format!("melody-bg-race-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).expect("scratch workspace");
        // Short enough that the natural exit lands inside the same collector
        // poll as the kill, long enough that the cancel request arrives first.
        let task_id = start_task_in(&root, "sleep 0.3", "session-owner");

        let cancelled = cancel_background_task(&root, "session-owner", &task_id)
            .expect("the owner may cancel its task");
        assert_eq!(cancelled["status"].as_str(), Some("cancelled"));
        assert_eq!(cancelled["command"].as_str(), Some("sleep 0.3"));

        // The later poll must agree with the returned snapshot.
        let listed = list_background_tasks(&root, "session-owner");
        assert!(listed.iter().any(|entry| {
            entry["task_id"].as_str() == Some(task_id.as_str())
                && entry["status"].as_str() == Some("cancelled")
        }));

        std::fs::remove_dir_all(&root).ok();
    }

    /// The panel must never reach another session's task. The rejection text is
    /// what the user sees in the row, so it is pinned here.
    #[test]
    fn cancel_from_another_session_is_rejected_with_the_ownership_message() {
        let root =
            std::env::temp_dir().join(format!("melody-bg-own-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).expect("scratch workspace");
        let task_id = start_task_in(&root, "sleep 30", "session-owner");

        let error = cancel_background_task(&root, "session-intruder", &task_id)
            .expect_err("a foreign session must not cancel this task");
        assert_eq!(
            error,
            "Background task does not belong to this session workspace"
        );

        // The owner can still stop it afterwards.
        let cancelled = cancel_background_task(&root, "session-owner", &task_id)
            .expect("the owner may cancel its task");
        assert_eq!(cancelled["status"].as_str(), Some("cancelled"));

        std::fs::remove_dir_all(&root).ok();
    }

    /// A task that already reached a terminal state keeps it: cancelling finished
    /// work must not relabel it as stopped.
    #[test]
    fn cancel_keeps_the_terminal_status_of_a_finished_task() {
        let root =
            std::env::temp_dir().join(format!("melody-bg-done-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).expect("scratch workspace");
        let task_id = start_task_in(&root, "true", "session-owner");

        // The collector publishes status and `finished` under one lock, so a
        // non-running status means the task has settled.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let settled = list_background_tasks(&root, "session-owner")
                .iter()
                .any(|entry| {
                    entry["task_id"].as_str() == Some(task_id.as_str())
                        && entry["status"].as_str() != Some("running")
                });
            if settled || Instant::now() >= deadline {
                assert!(settled, "the short-lived command must finish on its own");
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        let after_cancel = cancel_background_task(&root, "session-owner", &task_id)
            .expect("cancelling finished work is not an error");
        assert_eq!(after_cancel["status"].as_str(), Some("completed"));

        std::fs::remove_dir_all(&root).ok();
    }
}
