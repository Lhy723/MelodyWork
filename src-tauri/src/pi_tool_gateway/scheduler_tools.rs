//! Host adapter for the session-scoped scheduler tool contract.
//!
//! The database remains the schedule source of truth; this module owns only
//! argument mapping, session ownership checks, and the bounded model snapshot.

use serde_json::{Map, Value, json};
use tauri::Manager;

use super::{SCHEDULER_CREATE, SCHEDULER_DELETE, SCHEDULER_LIST};

/// Serve Melody's scheduler tools from the Host-owned schedule store.
///
/// The model can only see and change this session's schedules; the Host keeps
/// the clock, the missed-trigger policy, the identity snapshot and the run
/// journal, so a model-created timer is the same object the UI shows.
pub(super) fn scheduler_tool(
    app: Option<&tauri::AppHandle>,
    tool_name: &str,
    session_id: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let app = app.ok_or_else(|| "scheduler tools require the desktop Host".to_string())?;
    let database = app
        .try_state::<crate::database::AppDatabase>()
        .ok_or_else(|| "the application database is unavailable".to_string())?;
    let connection = database
        .connection
        .lock()
        .map_err(|_| "the application database is unavailable".to_string())?;
    let now = crate::database::current_timestamp(&connection)?;
    match tool_name {
        SCHEDULER_CREATE => {
            let interval = arguments.get("interval").and_then(Value::as_str);
            let cron = arguments.get("cron").and_then(Value::as_str);
            let (kind, interval_ms, cron) = match (interval, cron) {
                (Some(interval), None) => (
                    "interval",
                    Some(crate::database::parse_scheduler_interval(interval)?),
                    None,
                ),
                (None, Some(cron)) => ("cron", None, Some(cron)),
                (Some(_), Some(_)) => {
                    return Err("provide either interval or cron, not both".to_string());
                }
                (None, None) => {
                    return Err(
                        "provide interval (for example 5m) or a 5-field cron rule".to_string()
                    );
                }
            };
            let prompt = arguments
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "prompt is required".to_string())?;
            let fire_immediately = arguments
                .get("fire_immediately")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let task_id = arguments.get("task_id").and_then(Value::as_str);
            let schedule = crate::database::create_schedule_from_tool_with_kind(
                &connection,
                session_id,
                task_id,
                kind,
                interval_ms,
                cron,
                prompt,
                fire_immediately,
                now,
            )?;
            Ok(scheduler_snapshot(&schedule).to_string())
        }
        SCHEDULER_LIST => {
            let schedules = crate::database::list_schedules(&connection, Some(session_id))?;
            Ok(Value::Array(schedules.iter().map(scheduler_snapshot).collect()).to_string())
        }
        SCHEDULER_DELETE => {
            let task_id = arguments
                .get("task_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "task_id is required".to_string())?;
            match crate::database::read_schedule(&connection, task_id)? {
                Some(schedule) if schedule.session_id == session_id => {
                    crate::database::set_schedule_status(&connection, task_id, "cancelled", now)?;
                    Ok(Value::String(format!("cancelled {task_id}")).to_string())
                }
                Some(_) => Err(format!("schedule {task_id} belongs to another session")),
                None => Err(format!("no scheduled task with id {task_id}")),
            }
        }
        other => Err(format!("unsupported scheduler tool: {other}")),
    }
}

/// Bounded, model-facing snapshot of one schedule.
fn scheduler_snapshot(schedule: &crate::database::AgentSchedule) -> Value {
    json!({
        "id": schedule.schedule_id,
        "kind": schedule.kind,
        "status": schedule.status,
        "interval_ms": schedule.interval_ms,
        "cron": schedule.cron,
        "next_run_at": schedule.next_run_at,
        "run_count": schedule.run_count,
        "missed_policy": schedule.missed_policy,
        "prompt": schedule.prompt,
    })
}
