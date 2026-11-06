//! Dispatch Host-owned schedules into their product sessions.
//!
//! The state layer (`database_agent_schedules`) answers *when* a schedule is
//! due; this module answers *whether the Host may start a turn for it right
//! now*, and records the real outcome in the run journal.
//!
//! Two rules drive every decision:
//!
//! * A trigger never widens authority. The turn is submitted with the
//!   permission/session/mode identity stored on the schedule intersected with
//!   the session's live configuration, and the Host's `turn.submit` is only
//!   built from the persisted binding, never from renderer input.
//! * A trigger is never reported as successful until the worker acknowledged
//!   it. A refusal (busy session, unknown model, stale revision) or a timeout
//!   is journaled as such, so the audit trail cannot claim a run that never
//!   happened.
//!
//! Melody-build's monitor semantics (line-by-line output events, rate limits,
//! archiving) and the Rhai workflow engine remain ACP-owned; this dispatcher
//! only starts an ordinary turn.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::database::AppDatabase;
use crate::database::{
    AgentSchedule, due_schedules, missed_decision, record_schedule_run, set_schedule_status,
};

use crate::pi_worker_runtime::{PiWorkerRuntime, TurnDispatchOutcome};

/// How late a due trigger may be and still count as on time. Anything older
/// follows the schedule's missed policy instead.
const DISPATCH_GRACE_MS: i64 = 5 * 60 * 1_000;
/// How often the Host looks for due schedules.
const DISPATCH_TICK: Duration = Duration::from_secs(20);
/// Upper bound per tick so one slow provider call cannot monopolize the loop.
const MAX_DISPATCHES_PER_TICK: i64 = 8;

/// What the dispatcher should do with a due schedule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DispatchPlan {
    /// Start the stored prompt in its session.
    Run,
    /// Advance the timer without running (missed beyond grace, the engine is
    /// not available right now, or the session already has a turn in flight).
    /// The reason is recorded in the journal.
    Skip(&'static str),
    /// A configuration problem the user has to fix; recorded as a failure.
    Fail(&'static str),
    /// The referenced session no longer exists: stop the timer instead of
    /// failing forever. Only reachable on a database that predates the
    /// explicit cleanup, or after external corruption.
    Abandon(&'static str),
}

/// Decide what to do with one due schedule.
///
/// A missing engine is a *skip*, not a failure: the user closing a project or
/// not having started the worker yet is not an error, and the schedule's own
/// missed policy already decides whether a late trigger still runs.
pub(crate) fn plan_dispatch(
    schedule: &AgentSchedule,
    now: i64,
    grace_ms: i64,
    session_state: SessionDispatchState,
) -> DispatchPlan {
    let Some(due_at) = schedule.next_run_at else {
        return DispatchPlan::Skip("no-next-run");
    };
    if schedule.status != "active" {
        return DispatchPlan::Skip("not-active");
    }
    if schedule.expires_at.is_some_and(|expiry| expiry <= now) {
        return DispatchPlan::Skip("expired");
    }
    if !missed_decision(due_at, now, grace_ms, &schedule.missed_policy) {
        return DispatchPlan::Skip("missed");
    }
    match session_state {
        SessionDispatchState::Ready => DispatchPlan::Run,
        SessionDispatchState::Busy => DispatchPlan::Skip("session-busy"),
        SessionDispatchState::WorkerStopped => DispatchPlan::Skip("worker-stopped"),
        SessionDispatchState::WorkspaceMismatch => DispatchPlan::Skip("workspace-mismatch"),
        SessionDispatchState::UnknownSession => DispatchPlan::Abandon("session-missing"),
        SessionDispatchState::NotPiSession => DispatchPlan::Fail("engine-not-pi"),
    }
}

/// What the Host knows about the target session at dispatch time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionDispatchState {
    Ready,
    Busy,
    WorkerStopped,
    UnknownSession,
    NotPiSession,
    WorkspaceMismatch,
}

/// Map the worker's acknowledgement to a journal status.
///
/// A refusal caused by the session being busy is a *skip*: nothing is broken
/// and the user's timer should survive it. Every other refusal is a failure
/// with the worker's own code, so the UI can explain it.
pub(crate) fn outcome_status(
    outcome: &TurnDispatchOutcome,
) -> (&'static str, Option<String>, Option<String>) {
    match outcome {
        TurnDispatchOutcome::Accepted => ("fired", None, None),
        TurnDispatchOutcome::Rejected { code, message } => {
            if matches!(
                code.as_str(),
                "pi.streaming_behavior_required" | "pi.run_not_streaming"
            ) {
                ("skipped", None, Some(format!("session busy ({code})")))
            } else {
                ("failed", None, Some(format!("{code}: {message}")))
            }
        }
        TurnDispatchOutcome::Unacknowledged => (
            "failed",
            None,
            Some("the worker did not acknowledge the scheduled turn".to_string()),
        ),
    }
}

/// Sessions with an in-flight Host-initiated turn.
///
/// The Host does not otherwise track per-session run state, and the worker
/// rejects an overlapping submit anyway; this registry is what lets the
/// dispatcher record a *skip* instead of provoking that rejection.
#[derive(Default)]
pub(crate) struct DispatchRegistry {
    in_flight: Mutex<HashMap<String, ()>>,
}

impl DispatchRegistry {
    fn claim(&self, session_id: &str) -> bool {
        match self.in_flight.lock() {
            Ok(mut in_flight) => in_flight.insert(session_id.to_string(), ()).is_none(),
            Err(_) => false,
        }
    }

    fn release(&self, session_id: &str) {
        if let Ok(mut in_flight) = self.in_flight.lock() {
            in_flight.remove(session_id);
        }
    }

    /// Non-mutating check used by the planner.
    fn can_claim(&self, session_id: &str) -> bool {
        self.in_flight
            .lock()
            .map(|in_flight| !in_flight.contains_key(session_id))
            .unwrap_or(false)
    }
}

/// Build the `turn.submit` frame for one schedule.
///
/// The identity comes from the schedule (captured at creation) but never
/// exceeds the session's current binding: the live permission mode and mode id
/// win when they are narrower.
pub(crate) fn scheduled_turn_command(
    schedule: &AgentSchedule,
    prompt: &str,
    live: &LiveSessionIdentity,
    revision: i64,
    run_ordinal: i64,
) -> Value {
    let prompt_id = format!("pi-schedule-{}-{run_ordinal}", schedule.schedule_id);
    let request_id = format!("pi-schedule-{}", Uuid::new_v4());
    json!({
        "protocolVersion": 1,
        "requestId": request_id,
        "sessionId": schedule.session_id,
        "idempotencyKey": prompt_id,
        "command": {
            "type": "turn.submit",
            "sessionId": schedule.session_id,
            "promptId": prompt_id,
            "content": prompt,
            "attachments": [],
            "config": {
                "permissionMode": live.permission_mode,
                "sessionModeId": live.session_mode_id,
                "configRevision": revision,
                "modelId": live.model_id,
                "reasoningEffort": live.reasoning_effort,
            },
        },
    })
}

/// The session's live configuration, read from the persisted binding.
#[derive(Clone, Debug, Default)]
pub(crate) struct LiveSessionIdentity {
    pub(crate) permission_mode: String,
    pub(crate) session_mode_id: String,
    pub(crate) model_id: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
}

/// Narrowest permission mode of the pair, so a trigger can never exceed the
/// session's current authority.
pub(crate) fn narrow_permission_mode<'a>(scheduled: &'a str, live: &'a str) -> &'a str {
    const ORDER: [&str; 3] = ["ask", "auto", "always-approve"];
    let rank = |value: &str| ORDER.iter().position(|mode| *mode == value).unwrap_or(0);
    if rank(scheduled) <= rank(live) {
        scheduled
    } else {
        live
    }
}

/// Run one dispatch pass. Returns how many schedules were acted on.
pub(crate) async fn dispatch_due_schedules(app: &AppHandle, now: i64) -> Result<usize, String> {
    let Some(database) = app.try_state::<AppDatabase>() else {
        return Ok(0);
    };
    let Some(runtime) = app.try_state::<PiWorkerRuntime>() else {
        return Ok(0);
    };
    let Some(dispatch_registry) = app.try_state::<DispatchRegistry>() else {
        return Ok(0);
    };
    let due = {
        let connection = database
            .connection
            .lock()
            .map_err(|_| "the application database is unavailable".to_string())?;
        due_schedules(&connection, now, MAX_DISPATCHES_PER_TICK)?
    };
    let mut acted = 0usize;
    for schedule in due {
        let state =
            session_dispatch_state(&schedule, &runtime, &database, &dispatch_registry).await;
        match plan_dispatch(&schedule, now, DISPATCH_GRACE_MS, state) {
            DispatchPlan::Fail(reason) => {
                record(
                    &database,
                    &schedule.schedule_id,
                    "failed",
                    None,
                    Some(reason),
                )?;
                acted += 1;
            }
            DispatchPlan::Skip(reason) => {
                record(
                    &database,
                    &schedule.schedule_id,
                    "skipped",
                    None,
                    Some(reason),
                )?;
                acted += 1;
            }
            DispatchPlan::Abandon(reason) => {
                // Stop the timer rather than retrying a session that is gone;
                // leaving it active would keep it in every due query.
                cancel_schedule(&database, &schedule.schedule_id, reason)?;
                acted += 1;
            }
            DispatchPlan::Run => {
                dispatch_one(&database, &runtime, &dispatch_registry, &schedule, now).await?;
                acted += 1;
            }
        }
    }
    Ok(acted)
}

/// Resolve what the Host knows about the target session.
async fn session_dispatch_state(
    schedule: &AgentSchedule,
    runtime: &PiWorkerRuntime,
    database: &AppDatabase,
    dispatch_registry: &DispatchRegistry,
) -> SessionDispatchState {
    let generation = runtime.active_generation();
    if generation == 0 {
        return SessionDispatchState::WorkerStopped;
    }
    // A session with a Host turn already in flight is busy even though the
    // worker would accept the frame and then refuse the run.
    if !dispatch_registry.can_claim(&schedule.session_id) {
        return SessionDispatchState::Busy;
    }
    // The database lock is confined to a synchronous helper: holding a
    // connection guard across the worker await would make this future
    // non-`Send`, and the dispatcher runs on the async runtime.
    let Some((session_cwd, engine)) = session_binding(database, &schedule.session_id) else {
        return SessionDispatchState::UnknownSession;
    };
    if engine.as_deref() != Some("pi") {
        return SessionDispatchState::NotPiSession;
    }
    match runtime.worker_cwd(generation).await {
        // A scheduled turn may only run inside the workspace the worker owns.
        Ok(worker_cwd) => {
            match (
                Path::new(&session_cwd).canonicalize(),
                worker_cwd.canonicalize(),
            ) {
                (Ok(session), Ok(worker)) if session == worker => SessionDispatchState::Ready,
                _ => SessionDispatchState::WorkspaceMismatch,
            }
        }
        Err(_) => SessionDispatchState::WorkerStopped,
    }
}

/// Read a session's working directory and engine binding.
fn session_binding(database: &AppDatabase, session_id: &str) -> Option<(String, Option<String>)> {
    let connection = database.connection.lock().ok()?;
    connection
        .query_row(
            "SELECT s.cwd, b.engine
               FROM sessions AS s
               LEFT JOIN agent_session_bindings AS b ON b.session_id = s.id
              WHERE s.id = ?1",
            [session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .ok()
        .flatten()
}

/// Build the identity for one dispatch from the persisted binding.
fn live_identity(database: &AppDatabase, schedule: &AgentSchedule) -> LiveSessionIdentity {
    let mut identity = LiveSessionIdentity {
        permission_mode: schedule.permission_mode.clone(),
        session_mode_id: schedule.session_mode_id.clone(),
        model_id: schedule.model_id.clone(),
        reasoning_effort: schedule.reasoning_effort.clone(),
    };
    let Ok(connection) = database.connection.lock() else {
        return identity;
    };
    let binding: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = connection
        .query_row(
            "SELECT session_mode_id, permission_mode, model_id, reasoning_effort
                   FROM agent_session_bindings WHERE session_id = ?1",
            [&schedule.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .ok()
        .flatten();
    if let Some((mode, permission, model, effort)) = binding {
        if let Some(mode) = mode.filter(|value| !value.trim().is_empty()) {
            identity.session_mode_id = mode;
        }
        if let Some(permission) = permission.filter(|value| !value.trim().is_empty()) {
            identity.permission_mode =
                narrow_permission_mode(&schedule.permission_mode, &permission).to_string();
        }
        identity.model_id = model.or(identity.model_id);
        identity.reasoning_effort = effort.or(identity.reasoning_effort);
    }
    identity
}

/// Stable prompt identity for one attempt, shared by the frame and the
/// acknowledgement channel.
pub(crate) fn scheduled_prompt_id(schedule: &AgentSchedule) -> String {
    format!(
        "pi-schedule-{}-{}",
        schedule.schedule_id, schedule.run_count
    )
}

async fn dispatch_one(
    database: &AppDatabase,
    runtime: &PiWorkerRuntime,
    dispatch_registry: &DispatchRegistry,
    schedule: &AgentSchedule,
    _now: i64,
) -> Result<(), String> {
    let generation = runtime.active_generation();
    let identity = live_identity(database, schedule);
    let revision = runtime.session_config_revision(&schedule.session_id);
    let prompt_id = scheduled_prompt_id(schedule);
    let command = scheduled_turn_command(
        schedule,
        &schedule.prompt,
        &identity,
        revision,
        schedule.run_count,
    );
    let request_id = command
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "the scheduled command is missing its request id".to_string())?
        .to_string();

    if !dispatch_registry.claim(&schedule.session_id) {
        return record(
            database,
            &schedule.schedule_id,
            "skipped",
            None,
            Some("session-busy"),
        );
    }
    let outcome = runtime
        .submit_and_await(generation, &command, &prompt_id, &request_id)
        .await;
    dispatch_registry.release(&schedule.session_id);

    match outcome {
        Ok(outcome) => {
            let (status, run_id, error) = outcome_status(&outcome);
            let run_id = match &outcome {
                TurnDispatchOutcome::Accepted => Some(prompt_id.as_str()),
                _ => run_id.as_deref(),
            };
            record(
                database,
                &schedule.schedule_id,
                status,
                run_id,
                error.as_deref(),
            )
        }
        Err(error) => record(
            database,
            &schedule.schedule_id,
            "failed",
            None,
            Some(&error),
        ),
    }
}

/// Cancel a schedule whose session disappeared, recording why.
fn cancel_schedule(database: &AppDatabase, schedule_id: &str, reason: &str) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "the application database is unavailable".to_string())?;
    let now = crate::database::current_timestamp(&connection)?;
    set_schedule_status(&connection, schedule_id, "cancelled", now)?;
    record_schedule_run(&connection, schedule_id, "failed", None, Some(reason), now)?;
    Ok(())
}

fn record(
    database: &AppDatabase,
    schedule_id: &str,
    status: &str,
    run_id: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "the application database is unavailable".to_string())?;
    let now = crate::database::current_timestamp(&connection)?;
    record_schedule_run(&connection, schedule_id, status, run_id, error, now)?;
    Ok(())
}

/// Start the periodic dispatch loop.
pub(crate) fn spawn_dispatch_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(DISPATCH_TICK).await;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as i64)
                .unwrap_or_default();
            if let Err(error) = dispatch_due_schedules(&app, now).await {
                // A failed pass is a Host diagnostic, not a session failure.
                eprintln!("scheduled dispatch pass failed: {error}");
            }
        }
    });
}
