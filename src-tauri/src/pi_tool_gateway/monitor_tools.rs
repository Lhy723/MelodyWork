//! Host bridge for monitor commands and shared task-control requests.
//!
//! The monitor runtime owns process execution and event sequencing; this module
//! maps approved ToolGateway inputs to that runtime and projects its bounded
//! snapshots into the existing task-control response shape.

use std::{
    path::Path,
    thread,
    time::{Duration, Instant},
};

use serde_json::{Map, Value, json};

use super::{
    GET_COMMAND_OR_SUBAGENT_OUTPUT, HOST_TASK_CONTROL_POLL_INTERVAL, KILL_COMMAND_OR_SUBAGENT,
    WAIT_COMMANDS_OR_SUBAGENTS, raw_task_id_argument, task_timeout_ms,
};

const MONITOR_MAX_COMMAND_BYTES: usize = 16 * 1024;

/// Start a Host-owned monitor for a tool request.
///
/// The command is authorized before reaching this function (`mutating_tool`
/// covers `monitor`), so this only builds the bounded arguments, starts the
/// process and returns the same task shape the other task tools consume.
pub(super) fn start_monitor_tool(
    root: &Path,
    session_id: &str,
    arguments: &Map<String, Value>,
    app: Option<&tauri::AppHandle>,
) -> Result<String, String> {
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "a monitor needs a command".to_string())?;
    if command.len() > MONITOR_MAX_COMMAND_BYTES {
        return Err(format!(
            "the monitor command exceeds {MONITOR_MAX_COMMAND_BYTES} bytes"
        ));
    }
    let description = arguments
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("monitor");
    let persistent = arguments
        .get("persistent")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let workspace = root.to_path_buf();
    let owner_session = session_id.to_string();
    let event_app = app.cloned();
    let event_session = owner_session.clone();
    let event_workspace = workspace.clone();
    let snapshot = crate::pi_monitor_runtime::start_monitor(
        &owner_session,
        &workspace,
        command,
        description,
        persistent,
        move |line| {
            // Without an AppHandle (unit tests, headless bridge) the monitor
            // still runs and its tail stays readable; only delivery is skipped.
            let Some(app) = event_app.as_ref() else {
                return;
            };
            let event = json!({
                "type": "task.notification",
                "taskId": line.task_id,
                "description": line.description,
                "line": line.line,
                "sequence": line.sequence,
                "truncated": line.truncated,
            });
            if let Err(error) = crate::pi_worker_runtime::emit_host_agent_event(
                app,
                &event_session,
                &event_workspace,
                event,
            ) {
                eprintln!("monitor event was not persisted: {error}");
            }
        },
    )?;
    Ok(monitor_task_snapshot(&snapshot).to_string())
}

/// Snapshot shape shared by the monitor and terminal task tools.
fn monitor_task_snapshot(snapshot: &crate::pi_monitor_runtime::MonitorSnapshot) -> Value {
    json!({
        "task_id": snapshot.task_id,
        "status": snapshot.status.as_str(),
        "description": snapshot.description,
        "persistent": snapshot.persistent,
        "emitted": snapshot.emitted,
        "output": snapshot.output,
    })
}

pub(super) fn monitor_task_id(value: &str) -> bool {
    value.starts_with(crate::pi_monitor_runtime::PI_MONITOR_TASK_PREFIX)
}

/// Wait for a monitor to reach a terminal status, bounded by `timeout_ms`.
fn wait_for_monitor(task_id: &str, timeout_ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match crate::pi_monitor_runtime::monitor_snapshot(task_id) {
            Some(snapshot)
                if !matches!(
                    snapshot.status,
                    crate::pi_monitor_runtime::MonitorStatus::Running
                ) =>
            {
                return;
            }
            Some(_) => {}
            None => return,
        }
        if timeout_ms == 0 || Instant::now() >= deadline {
            return;
        }
        thread::sleep(HOST_TASK_CONTROL_POLL_INTERVAL.min(Duration::from_millis(50)));
    }
}

/// Resolve `get`, `kill` and `wait` for monitor task ids.
pub(super) fn resolve_monitor_task_control(
    tool_name: &str,
    owner_session_id: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let snapshot_for = |task_id: &str| -> Result<Value, String> {
        let snapshot = crate::pi_monitor_runtime::monitor_snapshot(task_id)
            .ok_or_else(|| format!("monitor {task_id} does not exist"))?;
        if snapshot.task_id.is_empty() {
            return Err("monitor snapshot is invalid".to_string());
        }
        Ok(monitor_task_snapshot(&snapshot))
    };
    match tool_name {
        GET_COMMAND_OR_SUBAGENT_OUTPUT => {
            let task_id = raw_task_id_argument(arguments)?;
            crate::pi_monitor_runtime::authorize_monitor(task_id, owner_session_id)?;
            wait_for_monitor(task_id, task_timeout_ms(arguments, 0)?);
            Ok(snapshot_for(task_id)?.to_string())
        }
        KILL_COMMAND_OR_SUBAGENT => {
            let task_id = raw_task_id_argument(arguments)?;
            crate::pi_monitor_runtime::authorize_monitor(task_id, owner_session_id)?;
            crate::pi_monitor_runtime::cancel_monitor(task_id)?;
            Ok(snapshot_for(task_id)?.to_string())
        }
        WAIT_COMMANDS_OR_SUBAGENTS => {
            let task_ids = arguments
                .get("task_ids")
                .and_then(Value::as_array)
                .ok_or_else(|| "task_ids must be an array".to_string())?;
            let mode = arguments
                .get("mode")
                .and_then(Value::as_str)
                .ok_or_else(|| "mode must be wait_any or wait_all".to_string())?;
            if !matches!(mode, "wait_any" | "wait_all") {
                return Err(format!("Unsupported wait mode: {mode}"));
            }
            let ids = task_ids
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| "task_ids must contain strings".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let timeout_ms = task_timeout_ms(arguments, 30_000)?;
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                let finished = ids
                    .iter()
                    .filter(|task_id| {
                        !matches!(
                            crate::pi_monitor_runtime::monitor_snapshot(task_id)
                                .map(|snapshot| snapshot.status),
                            Some(crate::pi_monitor_runtime::MonitorStatus::Running)
                        )
                    })
                    .count();
                let should_return = match mode {
                    "wait_any" => finished > 0,
                    "wait_all" => finished == ids.len(),
                    _ => unreachable!(),
                };
                if should_return || timeout_ms == 0 || Instant::now() >= deadline {
                    break;
                }
                thread::sleep(HOST_TASK_CONTROL_POLL_INTERVAL.min(Duration::from_millis(50)));
            }
            let snapshots = ids
                .iter()
                .map(|task_id| snapshot_for(task_id))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Value::Array(snapshots).to_string())
        }
        _ => Err(format!("Unsupported monitor task tool: {tool_name}")),
    }
}
