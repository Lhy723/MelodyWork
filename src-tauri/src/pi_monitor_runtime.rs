//! Host-owned monitors: long-running commands whose **lines** become product
//! events.
//!
//! Melody-build's `monitor` tool merges a command's stdout and stderr and turns
//! every new line into a notification in the conversation, stops the monitor
//! automatically when it produces too many events, and lets a
//! `persistent: true` monitor live for the whole session. `run_background_task`
//! is not equivalent: it only accumulates output that the model has to poll, so
//! a monitor needs its own registry and its own event stream.
//!
//! Everything here is Host-owned. The worker never sees the process handle, the
//! output file or an unbounded buffer: it receives bounded line events and a
//! stable monitor id that the existing task tools (`kill_command_or_subagent`,
//! `get_command_or_subagent_output`) can control.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, State};

use super::workspace_access::WorkspaceRegistry;

/// Monitor ids are distinguishable from terminal tasks in the shared tools.
pub(crate) const PI_MONITOR_TASK_PREFIX: &str = "pi-monitor:";
/// Concurrent monitors per workspace and in total; a monitor is a process, so
/// the bound has to exist before the first one starts.
pub(crate) const MAX_MONITORS: usize = 16;
/// Bounded ring of recent lines kept for `get_command_or_subagent_output`.
const MAX_BUFFERED_LINES: usize = 200;
const MAX_LINE_BYTES: usize = 4 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 500;
/// Volume control, mirroring Melody's "stops it automatically": a monitor may
/// emit this many lines per rolling window before the Host stops it, and this
/// many lines in total before it is stopped for good.
const MAX_LINES_PER_WINDOW: u32 = 120;
const VOLUME_WINDOW: Duration = Duration::from_secs(60);
const MAX_LINES_TOTAL: u32 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MonitorStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    /// Stopped by the Host because it produced too many events.
    AutoStopped,
}

impl MonitorStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::AutoStopped => "auto-stopped",
        }
    }
}

/// One line of monitor output, already bounded, as delivered to the product.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MonitorLine {
    pub(crate) task_id: String,
    pub(crate) description: String,
    pub(crate) line: String,
    /// Monotonic per-monitor counter so a consumer can order or drop lines.
    pub(crate) sequence: u64,
    pub(crate) truncated: bool,
}

/// A Host-owned monitor process.
struct MonitorTask {
    task_id: String,
    owner_session_id: String,
    root: PathBuf,
    description: String,
    persistent: bool,
    cancel: AtomicBool,
    /// Set when the Host stopped the monitor for producing too many events.
    auto_stopped: AtomicBool,
    sequence: AtomicU64,
    state: Mutex<MonitorState>,
    changed: Condvar,
}

#[derive(Debug)]
struct MonitorState {
    status: MonitorStatus,
    lines: Vec<String>,
    emitted: u32,
    window_started: Instant,
    window_count: u32,
    last_error: Option<String>,
}

static MONITORS: OnceLock<Mutex<HashMap<String, Arc<MonitorTask>>>> = OnceLock::new();
/// Finished monitors leave the live registry (they hold no process) but their
/// final snapshot stays readable, bounded and oldest-first, so
/// `get_command_or_subagent_output` can still return the tail.
const MAX_FINISHED_MONITORS: usize = 16;
static FINISHED_MONITORS: OnceLock<Mutex<std::collections::VecDeque<MonitorSnapshot>>> =
    OnceLock::new();

fn monitors() -> &'static Mutex<HashMap<String, Arc<MonitorTask>>> {
    MONITORS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn finished_monitors() -> &'static Mutex<std::collections::VecDeque<MonitorSnapshot>> {
    FINISHED_MONITORS.get_or_init(|| Mutex::new(std::collections::VecDeque::new()))
}

/// Why a monitor stopped, as reported in its final snapshot.
#[derive(Clone, Debug)]
pub(crate) struct MonitorOutcome {
    pub(crate) status: MonitorStatus,
    pub(crate) error: Option<String>,
}

/// Handle returned after a monitor is accepted and started.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub(crate) task_id: String,
    /// Kept for ownership checks after the process has exited; a finished
    /// monitor is still readable, so it must still be attributable.
    #[serde(skip)]
    pub(crate) owner_session_id: String,
    pub(crate) description: String,
    pub(crate) status: MonitorStatus,
    pub(crate) persistent: bool,
    pub(crate) emitted: u32,
    pub(crate) output: String,
}

fn bound_line(value: &str) -> (String, bool) {
    if value.len() <= MAX_LINE_BYTES {
        return (value.to_string(), false);
    }
    let mut end = MAX_LINE_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (
        format!("{}… [+{} chars]", &value[..end], value.len() - end),
        true,
    )
}

/// Decide whether one more line may be delivered.
///
/// Returns `Ok(())` to deliver and `Err(reason)` when the monitor must be
/// stopped. Volume is measured twice: a burst inside the rolling window and the
/// lifetime total, so neither a fast producer nor a slow-forever one can flood
/// the conversation.
fn admit_line(state: &mut MonitorState, now: Instant) -> Result<(), String> {
    if now.duration_since(state.window_started) >= VOLUME_WINDOW {
        state.window_started = now;
        state.window_count = 0;
    }
    if state.window_count >= MAX_LINES_PER_WINDOW {
        return Err(format!(
            "monitor produced more than {MAX_LINES_PER_WINDOW} events in {:?}; add a filter such as `grep --line-buffered`",
            VOLUME_WINDOW
        ));
    }
    if state.emitted >= MAX_LINES_TOTAL {
        return Err(format!(
            "monitor reached its {MAX_LINES_TOTAL}-event lifetime limit"
        ));
    }
    state.window_count += 1;
    state.emitted += 1;
    Ok(())
}

fn push_line(state: &mut MonitorState, line: &str) {
    state.lines.push(line.to_string());
    if state.lines.len() > MAX_BUFFERED_LINES {
        let excess = state.lines.len() - MAX_BUFFERED_LINES;
        state.lines.drain(..excess);
    }
}

fn snapshot(task: &MonitorTask) -> MonitorSnapshot {
    let state = task
        .state
        .lock()
        .expect("monitor state must not be poisoned");
    MonitorSnapshot {
        task_id: task.task_id.clone(),
        owner_session_id: task.owner_session_id.clone(),
        description: task.description.clone(),
        status: state.status,
        persistent: task.persistent,
        emitted: state.emitted,
        output: state.lines.join("\n"),
    }
}

fn finish(task: Arc<MonitorTask>, outcome: MonitorOutcome) {
    {
        let Ok(mut state) = task.state.lock() else {
            return;
        };
        state.status = outcome.status;
        state.last_error = outcome.error;
        task.changed.notify_all();
    }
    let snapshot = snapshot(&task);
    if let Ok(mut registry) = monitors().lock() {
        registry.remove(&task.task_id);
    }
    if let Ok(mut finished) = finished_monitors().lock() {
        finished.retain(|entry| entry.task_id != task.task_id);
        finished.push_back(snapshot);
        while finished.len() > MAX_FINISHED_MONITORS {
            finished.pop_front();
        }
    }
}

/// Start a monitor.
///
/// `emit` receives every admitted line exactly once; it runs on the reader
/// threads, so it must be cheap and non-blocking. `command` is executed through
/// the platform shell because monitors are shell pipelines by definition; the
/// caller is responsible for having authorized it (the tool path routes through
/// the Host permission gateway first).
pub(crate) fn start_monitor<E>(
    owner_session_id: &str,
    root: &Path,
    command: &str,
    description: &str,
    persistent: bool,
    emit: E,
) -> Result<MonitorSnapshot, String>
where
    E: Fn(&MonitorLine) + Send + Sync + 'static,
{
    let profile = crate::config_runtime::pi_sandbox_profile(&root.to_string_lossy());
    start_monitor_with_profile(
        owner_session_id,
        root,
        command,
        description,
        persistent,
        profile.as_deref(),
        emit,
    )
}

/// Start a monitor under an explicit sandbox profile.
///
/// Production always resolves the profile from config (see [`start_monitor`]);
/// the explicit form exists so tests can exercise a profile without mutating
/// the process environment, which other parallel tests would observe.
pub(crate) fn start_monitor_with_profile<E>(
    owner_session_id: &str,
    root: &Path,
    command: &str,
    description: &str,
    persistent: bool,
    sandbox_profile: Option<&str>,
    emit: E,
) -> Result<MonitorSnapshot, String>
where
    E: Fn(&MonitorLine) + Send + Sync + 'static,
{
    if command.trim().is_empty() {
        return Err("a monitor needs a command".to_string());
    }
    let description = description.trim();
    if description.is_empty() {
        return Err("a monitor needs a description".to_string());
    }
    let (description, _) = bound_line(description);
    if description.len() > MAX_DESCRIPTION_BYTES {
        return Err(format!(
            "the monitor description exceeds {MAX_DESCRIPTION_BYTES} bytes"
        ));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("the monitor workspace is unavailable: {error}"))?;

    // A monitor is a process like any other, so it goes through the same
    // sandbox decision as a terminal command: otherwise a confined workspace
    // could escape confinement by watching a command instead of running it.
    let mut child = crate::workspace_sandbox::sandboxed_shell_command(
        &canonical_root,
        sandbox_profile,
        command,
        false,
    )?
    .current_dir(&canonical_root)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| format!("failed to start the monitor: {error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let task_id = format!("{PI_MONITOR_TASK_PREFIX}{}", uuid::Uuid::new_v4());
    let task = Arc::new(MonitorTask {
        task_id: task_id.clone(),
        owner_session_id: owner_session_id.to_string(),
        root: canonical_root,
        description,
        persistent,
        cancel: AtomicBool::new(false),
        auto_stopped: AtomicBool::new(false),
        sequence: AtomicU64::new(0),
        state: Mutex::new(MonitorState {
            status: MonitorStatus::Running,
            lines: Vec::new(),
            emitted: 0,
            window_started: Instant::now(),
            window_count: 0,
            last_error: None,
        }),
        changed: Condvar::new(),
    });

    {
        let mut registry = monitors()
            .lock()
            .map_err(|_| "the monitor registry is unavailable".to_string())?;
        if registry.len() >= MAX_MONITORS {
            let _ = child.kill();
            return Err(format!(
                "the Host already runs {MAX_MONITORS} monitors; stop one first"
            ));
        }
        registry.insert(task_id.clone(), task.clone());
    }

    let emit = Arc::new(emit);
    spawn_reader(task.clone(), stdout, emit.clone());
    spawn_reader(task.clone(), stderr, emit);
    spawn_waiter(task.clone(), child);
    Ok(snapshot(&task))
}

/// Read one stream line by line and turn admitted lines into events.
fn spawn_reader<E>(
    task: Arc<MonitorTask>,
    stream: Option<impl std::io::Read + Send + 'static>,
    emit: Arc<E>,
) where
    E: Fn(&MonitorLine) + Send + Sync + 'static,
{
    let Some(stream) = stream else {
        return;
    };
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.split(b'\n') {
            if task.cancel.load(Ordering::Acquire) {
                return;
            }
            let Ok(line) = line else {
                return;
            };
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches('\r');
            if text.is_empty() {
                continue;
            }
            let (line, truncated) = bound_line(text);
            let sequence = {
                let Ok(mut state) = task.state.lock() else {
                    return;
                };
                if state.status != MonitorStatus::Running {
                    return;
                }
                match admit_line(&mut state, Instant::now()) {
                    Ok(()) => {
                        push_line(&mut state, &line);
                    }
                    Err(reason) => {
                        // Volume control: stop the monitor instead of flooding
                        // the conversation, exactly as Melody does.
                        task.auto_stopped.store(true, Ordering::Release);
                        task.cancel.store(true, Ordering::Release);
                        state.status = MonitorStatus::AutoStopped;
                        state.last_error = Some(reason.clone());
                        push_line(&mut state, &format!("[monitor stopped: {reason}]"));
                        task.changed.notify_all();
                        return;
                    }
                }
                let sequence = task.sequence.fetch_add(1, Ordering::AcqRel) + 1;
                (sequence, line, truncated)
            };
            let (sequence, line, truncated) = sequence;
            emit(&MonitorLine {
                task_id: task.task_id.clone(),
                description: task.description.clone(),
                line,
                sequence,
                truncated,
            });
        }
    });
}

fn spawn_waiter(task: Arc<MonitorTask>, mut child: Child) {
    std::thread::spawn(move || {
        let status = child.wait();
        let cancelled = task.cancel.load(Ordering::Acquire);
        let auto_stopped = task.auto_stopped.load(Ordering::Acquire);
        let outcome = if auto_stopped {
            MonitorOutcome {
                status: MonitorStatus::AutoStopped,
                error: None,
            }
        } else if cancelled {
            MonitorOutcome {
                status: MonitorStatus::Cancelled,
                error: None,
            }
        } else {
            match status {
                Ok(status) if status.success() => MonitorOutcome {
                    status: MonitorStatus::Completed,
                    error: None,
                },
                Ok(status) => MonitorOutcome {
                    status: MonitorStatus::Failed,
                    error: Some(format!("monitor exited with {status}")),
                },
                Err(error) => MonitorOutcome {
                    status: MonitorStatus::Failed,
                    error: Some(error.to_string()),
                },
            }
        };
        finish(task.clone(), outcome);
    });
}

/// Snapshot one monitor.
pub(crate) fn monitor_snapshot(task_id: &str) -> Option<MonitorSnapshot> {
    if let Some(snapshot) = monitors()
        .lock()
        .ok()?
        .get(task_id)
        .map(|task| snapshot(task))
    {
        return Some(snapshot);
    }
    finished_monitors()
        .lock()
        .ok()?
        .iter()
        .find(|entry| entry.task_id == task_id)
        .cloned()
}

pub(crate) fn list_monitors() -> Vec<MonitorSnapshot> {
    let mut monitors = monitors()
        .lock()
        .map(|registry| {
            registry
                .values()
                .map(|task| snapshot(task))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Ok(finished) = finished_monitors().lock() {
        monitors.extend(finished.iter().cloned());
    }
    monitors
}

/// Check that a monitor id belongs to the calling session.
///
/// A monitor id is not a capability: the registry is global, so ownership is
/// verified before any read or cancel, exactly like the terminal task registry.
pub(crate) fn authorize_monitor(task_id: &str, owner_session_id: &str) -> Result<(), String> {
    if task_id.trim().is_empty() || task_id.len() > 512 || task_id.chars().any(char::is_control) {
        return Err("task_id must be a bounded non-empty identifier".to_string());
    }
    let live_owner = monitors()
        .lock()
        .map_err(|_| "the monitor registry is unavailable".to_string())?
        .get(task_id)
        .map(|task| task.owner_session_id.clone());
    let owner = match live_owner {
        Some(owner) => Some(owner),
        // A finished monitor left the live registry but stays readable, so
        // ownership is checked against its retained snapshot.
        None => finished_monitors().lock().ok().and_then(|finished| {
            finished
                .iter()
                .find(|entry| entry.task_id == task_id)
                .map(|entry| entry.owner_session_id.clone())
        }),
    };
    match owner {
        Some(owner) if owner != owner_session_id => {
            Err(format!("monitor {task_id} belongs to a different session"))
        }
        Some(_) => Ok(()),
        None => Err(format!("monitor {task_id} does not exist")),
    }
}

/// Ask a running monitor to stop. The process tree is killed after a grace
/// period so a shell that ignores the flag cannot keep running.
pub(crate) fn cancel_monitor(task_id: &str) -> Result<MonitorOutcome, String> {
    let task = monitors()
        .lock()
        .map_err(|_| "the monitor registry is unavailable".to_string())?
        .get(task_id)
        .cloned();
    let Some(task) = task else {
        // Not live: either it already finished, or the id is unknown.
        return monitor_snapshot(task_id)
            .map(|snapshot| MonitorOutcome {
                status: snapshot.status,
                error: None,
            })
            .ok_or_else(|| format!("monitor {task_id} does not exist"));
    };
    task.cancel.store(true, Ordering::Release);
    // Wake a waiter immediately; the process kill is best-effort because the
    // reader loop already stops consuming once the flag is set.
    if let Ok(state) = task.state.lock() {
        if state.status == MonitorStatus::Running {
            task.changed.notify_all();
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(state) = task.state.lock() {
            if state.status != MonitorStatus::Running {
                return Ok(MonitorOutcome {
                    status: state.status,
                    error: state.last_error.clone(),
                });
            }
        }
        if Instant::now() >= deadline {
            return Ok(MonitorOutcome {
                status: MonitorStatus::Cancelled,
                error: Some("monitor did not exit within the grace period".to_string()),
            });
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Stop every monitor owned by a workspace. Called when the worker stops, the
/// workspace changes or the app exits, so no monitor outlives its session.
pub(crate) fn cancel_monitors_for_workspace(root: &Path) {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let Ok(registry) = monitors().lock() else {
        return;
    };
    for task in registry.values() {
        if task.root == canonical_root {
            task.cancel.store(true, Ordering::Release);
            task.changed.notify_all();
        }
    }
}

/// Stop every monitor owned by one product session.
pub(crate) fn cancel_monitors_for_session(session_id: &str) -> usize {
    let Ok(registry) = monitors().lock() else {
        return 0;
    };
    let mut stopped = 0usize;
    for task in registry.values() {
        if task.owner_session_id == session_id {
            task.cancel.store(true, Ordering::Release);
            stopped += 1;
        }
    }
    stopped
}

/// Start a monitor for one product session.
///
/// The command is Host-authorized: the workspace must be registered, and the
/// caller passes the session id so line events land in the right conversation.
/// Melody's model-facing `monitor` tool routes through the same registry once
/// its permission identity is wired; this command is the renderer/diagnostic
/// entry point.
#[tauri::command]
pub fn start_agent_monitor(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    session_id: String,
    cwd: String,
    command: String,
    description: String,
    persistent: bool,
) -> Result<MonitorSnapshot, String> {
    let workspace = registry.authorize(&cwd)?;
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("a monitor needs its product session".to_string());
    }
    let event_app = app.clone();
    let event_workspace = workspace.clone();
    let event_session = session_id.clone();
    start_monitor(
        &session_id,
        &workspace,
        &command,
        &description,
        persistent,
        move |line| {
            let event = json!({
                "type": "task.notification",
                "taskId": line.task_id,
                "description": line.description,
                "line": line.line,
                "sequence": line.sequence,
                "truncated": line.truncated,
            });
            if let Err(error) = crate::pi_worker_runtime::emit_host_agent_event(
                &event_app,
                &event_session,
                &event_workspace,
                event,
            ) {
                // A monitor whose events cannot be persisted must not keep
                // running silently: stop it and let the model/user notice.
                eprintln!("monitor event was not persisted: {error}");
            }
        },
    )
}

#[tauri::command]
pub fn list_agent_monitors() -> Vec<MonitorSnapshot> {
    list_monitors()
}

#[tauri::command]
pub fn cancel_agent_monitor(task_id: String) -> Result<MonitorSnapshot, String> {
    cancel_monitor(&task_id)?;
    monitor_snapshot(&task_id).ok_or_else(|| format!("monitor {task_id} does not exist"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_lines() -> (Arc<Mutex<Vec<MonitorLine>>>, impl Fn(&MonitorLine)) {
        let sink = Arc::new(Mutex::new(Vec::new()));
        let captured = sink.clone();
        (sink, move |line: &MonitorLine| {
            captured.lock().expect("sink").push(line.clone());
        })
    }

    fn wait_for_status(task_id: &str, expected: MonitorStatus) -> MonitorSnapshot {
        // Generous on purpose: this only waits for the state to appear, and a
        // loaded CI machine must not turn slow process startup into a failure.
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(snapshot) = monitor_snapshot(task_id)
                && snapshot.status == expected
            {
                return snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "monitor did not reach {expected:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_monitor_runs_under_the_workspace_sandbox() {
        if !(cfg!(target_os = "macos") || cfg!(target_os = "linux")) {
            // Windows still fails closed; the supported Unix implementations
            // below exercise the same command path used in production.
            return;
        }
        let root = std::env::temp_dir().join(format!("melody-monitor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        // Some managed macOS test hosts expose sandbox-exec but deny nested
        // sandbox creation (the probe exits with status 71). In that
        // environment there is no meaningful monitor assertion to make; the
        // production path still reports the process failure to the user.
        let Ok(mut probe) = crate::workspace_sandbox::sandboxed_shell_command(
            &root,
            Some("workspace"),
            "true",
            false,
        ) else {
            unit_cleanup(&root);
            return;
        };
        let Ok(status) = probe.current_dir(&root).status() else {
            unit_cleanup(&root);
            return;
        };
        if !status.success() {
            unit_cleanup(&root);
            return;
        }

        // A sandboxed monitor may still write inside the workspace.
        let (_, emit) = collect_lines();
        let started = start_monitor_with_profile(
            "session-1",
            &root,
            "printf inside > inside.txt",
            "sandboxed monitor",
            false,
            Some("workspace"),
            emit,
        )
        .unwrap();
        wait_for_status(&started.task_id, MonitorStatus::Completed);
        assert!(
            root.join("inside.txt").exists(),
            "a sandboxed monitor may still write inside the workspace"
        );

        // It must not be able to escape confinement: this is what makes the
        // monitor path equivalent to the terminal path instead of a bypass.
        let home = crate::config_runtime::user_home().unwrap();
        let outside = home.join(format!(
            "melody-monitor-outside-{}.txt",
            uuid::Uuid::new_v4()
        ));
        let (_, emit) = collect_lines();
        let denied = start_monitor_with_profile(
            "session-1",
            &root,
            &format!("printf bad > {}", outside.display()),
            "escapes",
            false,
            Some("workspace"),
            emit,
        )
        .unwrap();
        wait_for_status(&denied.task_id, MonitorStatus::Failed);
        assert!(
            !outside.exists(),
            "a monitor must not be able to escape the sandbox"
        );

        // An unenforceable profile refuses to start the monitor at all.
        let (_, emit) = collect_lines();
        assert!(
            start_monitor_with_profile(
                "session-1",
                &root,
                "echo hi",
                "strict",
                false,
                Some("strict"),
                emit,
            )
            .is_err(),
            "a monitor must not run unconfined when the profile is unenforceable"
        );
        unit_cleanup(&root);
    }

    #[test]
    fn every_line_becomes_a_bounded_event_with_its_description() {
        let root = std::env::temp_dir().join(format!("melody-monitor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let (lines, emit) = collect_lines();
        let started = start_monitor(
            "session-1",
            &root,
            "printf 'first\\nsecond\\n'",
            "watch the log",
            false,
            emit,
        )
        .unwrap();
        assert_eq!(started.status, MonitorStatus::Running);
        assert_eq!(started.description, "watch the log");
        wait_for_status(&started.task_id, MonitorStatus::Completed);

        let lines = lines.lock().unwrap().clone();
        assert_eq!(
            lines
                .iter()
                .map(|line| line.line.clone())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert!(lines.iter().all(|line| line.description == "watch the log"));
        assert_eq!(lines[0].sequence, 1);
        assert_eq!(lines[1].sequence, 2);
        // Stderr is part of the same stream, matching Melody's merged file.
        let (more, emit) = collect_lines();
        let started = start_monitor(
            "session-1",
            &root,
            "printf 'out\\n'; printf 'err\\n' >&2",
            "merged",
            false,
            emit,
        )
        .unwrap();
        wait_for_status(&started.task_id, MonitorStatus::Completed);
        let mut merged = more
            .lock()
            .unwrap()
            .iter()
            .map(|line| line.line.clone())
            .collect::<Vec<_>>();
        merged.sort();
        assert_eq!(merged, vec!["err", "out"]);
        unit_cleanup(&root);
    }

    #[test]
    fn a_chatty_monitor_is_stopped_automatically() {
        let root = std::env::temp_dir().join(format!("melody-monitor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let (lines, emit) = collect_lines();
        // Far beyond the rolling window: the Host must stop it, not forward
        // thousands of events into the conversation.
        let started = start_monitor(
            "session-1",
            &root,
            "i=0; while [ $i -lt 400 ]; do echo line-$i; i=$((i+1)); done",
            "too chatty",
            false,
            emit,
        )
        .unwrap();
        let final_state = wait_for_status(&started.task_id, MonitorStatus::AutoStopped);
        assert!(final_state.emitted <= MAX_LINES_PER_WINDOW + 1);
        let emitted = lines.lock().unwrap().len() as u32;
        assert!(
            emitted <= MAX_LINES_PER_WINDOW + 1,
            "the Host must cap delivered events, saw {emitted}"
        );
        unit_cleanup(&root);
    }

    #[test]
    fn a_monitor_can_be_cancelled_and_snapshots_carry_the_tail() {
        let root = std::env::temp_dir().join(format!("melody-monitor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let (lines, emit) = collect_lines();
        let started = start_monitor(
            "session-1",
            &root,
            "echo start; sleep 30",
            "long running",
            true,
            emit,
        )
        .unwrap();
        assert!(started.persistent);
        // Wait until the first line landed so the snapshot has content.
        let deadline = Instant::now() + Duration::from_secs(20);
        while lines.lock().unwrap().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let outcome = cancel_monitor(&started.task_id).unwrap();
        assert_ne!(outcome.status, MonitorStatus::Running);
        let snapshot = monitor_snapshot(&started.task_id).unwrap();
        assert!(snapshot.output.contains("start"));
        // A finished monitor stays visible so its tail can still be read, and
        // the registry prunes finished entries when the next one starts.
        assert!(
            list_monitors()
                .iter()
                .any(|entry| entry.task_id == started.task_id)
        );
        unit_cleanup(&root);
    }

    #[test]
    fn volume_admission_is_rate_limited_per_window_and_in_total() {
        let mut state = MonitorState {
            status: MonitorStatus::Running,
            lines: Vec::new(),
            emitted: 0,
            window_started: Instant::now(),
            window_count: 0,
            last_error: None,
        };
        for _ in 0..MAX_LINES_PER_WINDOW {
            admit_line(&mut state, Instant::now()).unwrap();
        }
        let error = admit_line(&mut state, Instant::now()).expect_err("window must be capped");
        assert!(error.contains("grep --line-buffered"));
        // A later window admits again.
        state.window_started = Instant::now() - VOLUME_WINDOW;
        admit_line(&mut state, Instant::now()).unwrap();
        state.emitted = MAX_LINES_TOTAL;
        state.window_count = 0;
        state.window_started = Instant::now() - VOLUME_WINDOW;
        assert!(admit_line(&mut state, Instant::now()).is_err());
    }

    #[test]
    fn long_lines_are_bounded_with_an_explicit_marker() {
        let long = "x".repeat(MAX_LINE_BYTES + 25);
        let (line, truncated) = bound_line(&long);
        assert!(truncated);
        assert!(line.contains("+25 chars"));
        assert!(line.len() <= MAX_LINE_BYTES + 24);
    }

    fn unit_cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root);
    }
}
