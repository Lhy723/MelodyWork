//! Host-owned persistent schedule state.
//!
//! Pi's Host owns durable schedule definitions, their permission identity, the
//! next fire time, and the policy for triggers missed while the app was closed.
//!
//! This module is deliberately *state only*. It defines the product record, the
//! lifecycle transitions and the claim/record seams a dispatcher needs; the
//! Monitor lifecycle and streamed output are separate Host-owned features; a
//! recurring schedule is never reported as a monitor.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::database_core::{AppDatabase, current_timestamp};
#[path = "database_agent_schedules/policy.rs"]
mod policy;
pub(crate) use policy::{
    MAX_SCHEDULE_INTERVAL_MS, MAX_SCHEDULE_RUNS, MIN_SCHEDULE_INTERVAL_MS,
    advance_after_fire_with_cron, missed_decision, next_fire_after_with_cron,
    parse_scheduler_interval, required_id, validate_kind, validate_policy, validate_status,
};

const MAX_SCHEDULE_PROMPT_BYTES: usize = 32 * 1024;
const MAX_SCHEDULE_RUN_ROWS: i64 = 512;
const RUN_STATUSES: [&str; 3] = ["fired", "skipped", "failed"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSchedule {
    pub(crate) schedule_id: String,
    pub(crate) session_id: String,
    pub(crate) project_id: String,
    pub(crate) kind: String,
    pub(crate) interval_ms: Option<i64>,
    pub(crate) run_at: Option<i64>,
    /// 5-field cron expression, set only when `kind` is `cron`.
    pub(crate) cron: Option<String>,
    pub(crate) prompt: String,
    pub(crate) missed_policy: String,
    pub(crate) max_runs: Option<i64>,
    pub(crate) expires_at: Option<i64>,
    pub(crate) status: String,
    pub(crate) next_run_at: Option<i64>,
    pub(crate) last_run_at: Option<i64>,
    pub(crate) run_count: i64,
    /// Identity captured when the schedule was created. A trigger never gets
    /// more authority than the session had at that moment.
    pub(crate) permission_mode: String,
    pub(crate) session_mode_id: String,
    pub(crate) model_id: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) revision: i64,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScheduleRun {
    pub(crate) schedule_id: String,
    pub(crate) run_ordinal: i64,
    pub(crate) status: String,
    pub(crate) fired_at: i64,
    pub(crate) run_id: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentScheduleRequest {
    pub(crate) schedule_id: String,
    pub(crate) session_id: String,
    pub(crate) project_id: String,
    pub(crate) kind: String,
    pub(crate) interval_ms: Option<i64>,
    pub(crate) run_at: Option<i64>,
    pub(crate) cron: Option<String>,
    pub(crate) prompt: String,
    pub(crate) missed_policy: Option<String>,
    pub(crate) max_runs: Option<i64>,
    pub(crate) expires_at: Option<i64>,
    pub(crate) permission_mode: String,
    pub(crate) session_mode_id: String,
    pub(crate) model_id: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
    /// Injected by the Host from the current clock so a renderer cannot forge
    /// the starting point of an interval.
    pub(crate) now: i64,
}

/// Create a schedule on behalf of a model tool call.
///
/// The permission/session identity is read from the session's binding rather
/// than from the tool arguments: a model cannot grant its schedule more
/// authority than the session currently has, and the dispatcher narrows it
/// further against the live binding at fire time.

pub(crate) fn create_schedule_from_tool_with_kind(
    connection: &Connection,
    session_id: &str,
    task_id: Option<&str>,
    kind: &str,
    interval_ms: Option<i64>,
    cron: Option<&str>,
    prompt: &str,
    fire_immediately: bool,
    now: i64,
) -> Result<AgentSchedule, String> {
    // One read supplies the owner, the engine and the authoritative identity: a
    // model cannot hand its schedule more authority than the session has.
    let row = connection
        .query_row(
            "SELECT sessions.project_id,
                    agent_session_bindings.engine,
                    agent_session_bindings.session_mode_id,
                    agent_session_bindings.permission_mode,
                    agent_session_bindings.model_id,
                    agent_session_bindings.reasoning_effort
               FROM sessions
               LEFT JOIN agent_session_bindings
                      ON agent_session_bindings.session_id = sessions.id
              WHERE sessions.id = ?1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("session {session_id} does not exist"))?;
    let (project_id, engine, session_mode_id, permission_mode, model_id, reasoning_effort) = row;
    match engine.as_deref() {
        Some("pi") => {}
        Some(_) => {
            return Err(
                "scheduled prompts are only supported for Pi sessions; this session runs on the compatibility engine"
                    .to_string(),
            );
        }
        None => {
            return Err(
                "this session has no Pi engine binding yet; open it with Pi before scheduling work"
                    .to_string(),
            );
        }
    }
    let schedule_id = task_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("scheduler-{value}"))
        .unwrap_or_else(|| format!("scheduler-{}", uuid::Uuid::new_v4()));
    let request = CreateAgentScheduleRequest {
        schedule_id: schedule_id.clone(),
        session_id: session_id.to_string(),
        project_id,
        kind: kind.to_string(),
        interval_ms,
        run_at: None,
        cron: cron.map(str::to_string),
        prompt: prompt.to_string(),
        missed_policy: Some("skip".to_string()),
        max_runs: None,
        expires_at: None,
        permission_mode: permission_mode.unwrap_or_else(|| "ask".to_string()),
        session_mode_id: session_mode_id.unwrap_or_else(|| "default".to_string()),
        model_id,
        reasoning_effort,
        now,
    };
    // Reusing a `task_id` updates that schedule, which is what a skill re-running
    // its own setup expects; a different session may never be adopted.
    let created = match read_schedule(connection, &schedule_id)? {
        Some(existing) if existing.session_id == session_id => {
            connection
                .execute(
                    "UPDATE agent_schedules
                        SET kind = ?2, interval_ms = ?3, run_at = NULL, cron = ?4,
                            prompt = ?5, status = 'active', next_run_at = ?6,
                            revision = revision + 1, updated_at = ?7
                      WHERE schedule_id = ?1",
                    params![
                        schedule_id,
                        if kind == "cron" { "interval" } else { kind },
                        request.interval_ms,
                        request.cron,
                        request.prompt,
                        next_run_at(&request)?,
                        current_timestamp(connection)?
                    ],
                )
                .map_err(|error| error.to_string())?;
            read_schedule(connection, &schedule_id)?
                .ok_or_else(|| "the schedule disappeared after the update".to_string())?
        }
        Some(_) => return Err(format!("schedule {schedule_id} belongs to another session")),
        None => insert_schedule(connection, &request)?,
    };
    if fire_immediately {
        // The dispatcher picks due rows up on its next tick, so "immediately"
        // means "due now" rather than a second scheduler path.
        connection
            .execute(
                "UPDATE agent_schedules SET next_run_at = ?2, updated_at = ?3 WHERE schedule_id = ?1",
                params![schedule_id, now, current_timestamp(connection)?],
            )
            .map_err(|error| error.to_string())?;
        return read_schedule(connection, &schedule_id)?
            .ok_or_else(|| "the schedule disappeared after the immediate trigger".to_string());
    }
    Ok(created)
}

fn next_run_at(request: &CreateAgentScheduleRequest) -> Result<i64, String> {
    next_fire_after_with_cron(
        &request.kind,
        request.interval_ms,
        request.run_at,
        request.cron.as_deref(),
        request.now,
    )
    .ok_or_else(|| "the schedule has no future trigger".to_string())
}

pub(crate) fn ensure_agent_schedule_schema(
    connection: &Connection,
) -> Result<(), Box<dyn std::error::Error>> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS agent_schedules (
            schedule_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('once', 'interval')),
            interval_ms INTEGER,
            run_at INTEGER,
            cron TEXT,
            prompt TEXT NOT NULL,
            missed_policy TEXT NOT NULL CHECK(missed_policy IN ('skip', 'run-once')),
            max_runs INTEGER,
            expires_at INTEGER,
            status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'expired', 'cancelled')),
            next_run_at INTEGER,
            last_run_at INTEGER,
            run_count INTEGER NOT NULL DEFAULT 0,
            permission_mode TEXT NOT NULL,
            session_mode_id TEXT NOT NULL,
            model_id TEXT,
            reasoning_effort TEXT,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS agent_schedules_due
            ON agent_schedules(status, next_run_at);
        CREATE INDEX IF NOT EXISTS agent_schedules_session
            ON agent_schedules(session_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS agent_schedule_runs (
            schedule_id TEXT NOT NULL,
            run_ordinal INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('fired', 'skipped', 'failed')),
            fired_at INTEGER NOT NULL,
            run_id TEXT,
            error TEXT,
            PRIMARY KEY(schedule_id, run_ordinal),
            FOREIGN KEY(schedule_id) REFERENCES agent_schedules(schedule_id) ON DELETE CASCADE
        );
        ",
    )?;
    // The v11 CHECK constraint permits only once/interval. Preserve it (and
    // all existing rows/FK relationships) by storing cron as interval kind
    // plus an expression; SCHEDULE_COLUMNS projects the public kind as cron.
    // This also upgrades databases created before schema v12.
    let mut columns = connection.prepare("PRAGMA table_info(agent_schedules)")?;
    let names = columns
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    if !names.contains("cron") {
        connection.execute("ALTER TABLE agent_schedules ADD COLUMN cron TEXT", [])?;
    }
    Ok(())
}

fn schedule_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSchedule> {
    Ok(AgentSchedule {
        schedule_id: row.get(0)?,
        session_id: row.get(1)?,
        project_id: row.get(2)?,
        kind: row.get(3)?,
        interval_ms: row.get(4)?,
        run_at: row.get(5)?,
        prompt: row.get(6)?,
        missed_policy: row.get(7)?,
        max_runs: row.get(8)?,
        expires_at: row.get(9)?,
        status: row.get(10)?,
        next_run_at: row.get(11)?,
        last_run_at: row.get(12)?,
        run_count: row.get(13)?,
        permission_mode: row.get(14)?,
        session_mode_id: row.get(15)?,
        model_id: row.get(16)?,
        reasoning_effort: row.get(17)?,
        revision: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        cron: row.get(21)?,
    })
}

const SCHEDULE_COLUMNS: &str = "schedule_id, session_id, project_id,
    CASE WHEN cron IS NOT NULL THEN 'cron' ELSE kind END, interval_ms, run_at,
    prompt, missed_policy, max_runs, expires_at, status, next_run_at, last_run_at, run_count,
    permission_mode, session_mode_id, model_id, reasoning_effort, revision, created_at, updated_at,
    cron";

pub(crate) fn insert_schedule(
    connection: &Connection,
    request: &CreateAgentScheduleRequest,
) -> Result<AgentSchedule, String> {
    required_id(&request.schedule_id, "scheduleId")?;
    required_id(&request.session_id, "sessionId")?;
    required_id(&request.project_id, "projectId")?;
    validate_kind(&request.kind)?;
    let missed_policy = request
        .missed_policy
        .clone()
        .unwrap_or_else(|| "skip".to_string());
    validate_policy(&missed_policy)?;
    if request.prompt.trim().is_empty() {
        return Err("schedule prompt must not be empty".to_string());
    }
    if request.prompt.len() > MAX_SCHEDULE_PROMPT_BYTES {
        return Err(format!(
            "schedule prompt exceeds the {MAX_SCHEDULE_PROMPT_BYTES}-byte limit"
        ));
    }
    match request.kind.as_str() {
        "once" => {
            if request.interval_ms.is_some() || request.cron.is_some() {
                return Err("a once schedule cannot include intervalMs or cron".to_string());
            }
            if request.run_at.is_none() {
                return Err("a once schedule needs runAt".to_string());
            }
        }
        "interval" => {
            let interval = request.interval_ms.unwrap_or_default();
            if !(MIN_SCHEDULE_INTERVAL_MS..=MAX_SCHEDULE_INTERVAL_MS).contains(&interval) {
                return Err(format!(
                    "intervalMs must be between {MIN_SCHEDULE_INTERVAL_MS} and {MAX_SCHEDULE_INTERVAL_MS}"
                ));
            }
            if request.run_at.is_some() || request.cron.is_some() {
                return Err("an interval schedule cannot include runAt or cron".to_string());
            }
        }
        "cron" => {
            let expression = request
                .cron
                .as_deref()
                .ok_or_else(|| "a cron schedule needs a cron expression".to_string())?;
            crate::cron_schedule::parse_cron_expression(expression)?;
            if request.interval_ms.is_some() || request.run_at.is_some() {
                return Err("a cron schedule cannot include intervalMs or runAt".to_string());
            }
        }
        _ => unreachable!("validate_kind checks schedule kind"),
    }
    if let Some(max_runs) = request.max_runs {
        if max_runs < 1 || max_runs > MAX_SCHEDULE_RUNS {
            return Err(format!("maxRuns must be between 1 and {MAX_SCHEDULE_RUNS}"));
        }
    }
    if let Some(expires_at) = request.expires_at {
        if expires_at <= request.now {
            return Err("expiresAt must be in the future".to_string());
        }
    }
    let next_run_at = next_fire_after_with_cron(
        &request.kind,
        request.interval_ms,
        request.run_at,
        request.cron.as_deref(),
        request.now,
    );
    let Some(next_run_at) = next_run_at else {
        return Err("the schedule has no future trigger".to_string());
    };
    let session_mode_id = request.session_mode_id.trim();
    if session_mode_id.is_empty() || session_mode_id.len() > 32 {
        return Err("sessionModeId is not a bounded mode id".to_string());
    }
    let permission_mode = request.permission_mode.trim();
    if !["ask", "auto", "always-approve"].contains(&permission_mode) {
        return Err("permissionMode is not a supported mode".to_string());
    }
    let timestamp = current_timestamp(connection)?;
    connection
        .execute(
            "INSERT INTO agent_schedules
                (schedule_id, session_id, project_id, kind, interval_ms, run_at, cron, prompt,
                 missed_policy, max_runs, expires_at, status, next_run_at, last_run_at, run_count,
                 permission_mode, session_mode_id, model_id, reasoning_effort, revision,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12, NULL, 0,
                 ?13, ?14, ?15, ?16, 1, ?17, ?17)",
            params![
                request.schedule_id,
                request.session_id,
                request.project_id,
                if request.kind == "cron" {
                    "interval"
                } else {
                    request.kind.as_str()
                },
                request.interval_ms,
                request.run_at,
                request.cron,
                request.prompt,
                missed_policy,
                request.max_runs,
                request.expires_at,
                next_run_at,
                permission_mode,
                session_mode_id,
                request.model_id,
                request.reasoning_effort,
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;
    read_schedule(connection, &request.schedule_id)?
        .ok_or_else(|| "the schedule disappeared after it was written".to_string())
}

pub(crate) fn read_schedule(
    connection: &Connection,
    schedule_id: &str,
) -> Result<Option<AgentSchedule>, String> {
    connection
        .query_row(
            &format!("SELECT {SCHEDULE_COLUMNS} FROM agent_schedules WHERE schedule_id = ?1"),
            params![schedule_id],
            schedule_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub(crate) fn list_schedules(
    connection: &Connection,
    session_id: Option<&str>,
) -> Result<Vec<AgentSchedule>, String> {
    let mut statement = match session_id {
        Some(_) => connection.prepare(&format!(
            "SELECT {SCHEDULE_COLUMNS} FROM agent_schedules
                 WHERE session_id = ?1 ORDER BY updated_at DESC LIMIT 256"
        )),
        None => connection.prepare(&format!(
            "SELECT {SCHEDULE_COLUMNS} FROM agent_schedules
                 ORDER BY updated_at DESC LIMIT 256"
        )),
    }
    .map_err(|error| error.to_string())?;
    let rows = match session_id {
        Some(session_id) => statement.query_map(params![session_id], schedule_from_row),
        None => statement.query_map([], schedule_from_row),
    }
    .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// Move a schedule between the user-controllable states.
///
/// `paused` keeps the definition and its next fire time is recomputed on
/// resume, so a long pause never produces a burst of catch-up runs.
pub(crate) fn set_schedule_status(
    connection: &Connection,
    schedule_id: &str,
    status: &str,
    now: i64,
) -> Result<AgentSchedule, String> {
    validate_status(status)?;
    let current = read_schedule(connection, schedule_id)?
        .ok_or_else(|| "the schedule does not exist".to_string())?;
    // A finished schedule is final: only cancelling it (again) is meaningful, so
    // a stale renderer cannot resurrect a completed or expired timer.
    let terminal = matches!(
        current.status.as_str(),
        "completed" | "expired" | "cancelled"
    );
    if terminal && status != "cancelled" {
        return Err(format!(
            "a {} schedule cannot become {status}",
            current.status
        ));
    }
    let next_run_at = if status == "active" {
        next_fire_after_with_cron(
            &current.kind,
            current.interval_ms,
            current.run_at,
            current.cron.as_deref(),
            now,
        )
    } else {
        None
    };
    connection
        .execute(
            "UPDATE agent_schedules
                SET status = ?2, next_run_at = ?3, revision = revision + 1, updated_at = ?4
              WHERE schedule_id = ?1",
            params![
                schedule_id,
                status,
                next_run_at,
                current_timestamp(connection)?
            ],
        )
        .map_err(|error| error.to_string())?;
    read_schedule(connection, schedule_id)?
        .ok_or_else(|| "the schedule disappeared after it was updated".to_string())
}

/// Apply one fire (or one skip) and persist the next state.
pub(crate) fn record_schedule_run(
    connection: &Connection,
    schedule_id: &str,
    status: &str,
    run_id: Option<&str>,
    error: Option<&str>,
    fired_at: i64,
) -> Result<AgentSchedule, String> {
    if !RUN_STATUSES.contains(&status) {
        return Err("run status must be fired, skipped or failed".to_string());
    }
    let current = read_schedule(connection, schedule_id)?
        .ok_or_else(|| "the schedule does not exist".to_string())?;
    let ordinal = current.run_count;
    let advance = advance_after_fire_with_cron(
        &current.kind,
        current.interval_ms,
        current.run_at,
        current.cron.as_deref(),
        current.run_count,
        current.max_runs,
        current.expires_at,
        fired_at,
    );
    // A failed dispatch still counts as an attempt, but keeps the schedule
    // alive so a transient outage does not silently cancel the user's timer.
    // It advances past this slot so a broken dispatcher cannot retry in a loop,
    // while `runCount` stays untouched because nothing ran.
    let (status_after, next_run_at, run_count) = if status == "failed" {
        (
            current.status.clone(),
            next_fire_after_with_cron(
                &current.kind,
                current.interval_ms,
                current.run_at,
                current.cron.as_deref(),
                fired_at,
            ),
            current.run_count,
        )
    } else {
        (advance.status, advance.next_run_at, advance.run_count)
    };
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO agent_schedule_runs
                (schedule_id, run_ordinal, status, fired_at, run_id, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![schedule_id, ordinal, status, fired_at, run_id, error],
        )
        .map_err(|error| error.to_string())?;
    let updated_at = current_timestamp(connection)?;
    transaction
        .execute(
            "UPDATE agent_schedules
                SET status = ?2, next_run_at = ?3, last_run_at = ?4, run_count = ?5,
                    revision = revision + 1, updated_at = ?6
              WHERE schedule_id = ?1",
            params![
                schedule_id,
                status_after,
                next_run_at,
                fired_at,
                run_count,
                updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    read_schedule(connection, schedule_id)?
        .ok_or_else(|| "the schedule disappeared after the run".to_string())
}

/// Schedules that are due right now, oldest first.
///
/// The caller decides run-versus-skip with [`missed_decision`] and then records
/// the outcome; nothing here depends on in-process timers, so a restart simply
/// re-queries.
pub(crate) fn due_schedules(
    connection: &Connection,
    now: i64,
    limit: i64,
) -> Result<Vec<AgentSchedule>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {SCHEDULE_COLUMNS} FROM agent_schedules
              WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?1
              ORDER BY next_run_at ASC LIMIT ?2"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![now, limit.clamp(1, 64)], schedule_from_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn list_schedule_runs(
    connection: &Connection,
    schedule_id: &str,
) -> Result<Vec<AgentScheduleRun>, String> {
    let mut statement = connection
        .prepare(
            "SELECT schedule_id, run_ordinal, status, fired_at, run_id, error
               FROM agent_schedule_runs WHERE schedule_id = ?1
              ORDER BY run_ordinal DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![schedule_id, MAX_SCHEDULE_RUN_ROWS], |row| {
            Ok(AgentScheduleRun {
                schedule_id: row.get(0)?,
                run_ordinal: row.get(1)?,
                status: row.get(2)?,
                fired_at: row.get(3)?,
                run_id: row.get(4)?,
                error: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn delete_schedule(connection: &Connection, schedule_id: &str) -> Result<(), String> {
    required_id(schedule_id, "scheduleId")?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM agent_schedule_runs WHERE schedule_id = ?1",
            params![schedule_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM agent_schedules WHERE schedule_id = ?1",
            params![schedule_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

fn connection(database: &AppDatabase) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    database
        .connection
        .lock()
        .map_err(|_| "the application database is unavailable".to_string())
}

#[tauri::command]
pub fn create_agent_schedule(
    database: State<'_, AppDatabase>,
    request: CreateAgentScheduleRequest,
) -> Result<AgentSchedule, String> {
    let connection = connection(&database)?;
    insert_schedule(&connection, &request)
}

#[tauri::command]
pub fn list_agent_schedules(
    database: State<'_, AppDatabase>,
    session_id: Option<String>,
) -> Result<Vec<AgentSchedule>, String> {
    let connection = connection(&database)?;
    list_schedules(&connection, session_id.as_deref())
}

#[tauri::command]
pub fn set_agent_schedule_status(
    database: State<'_, AppDatabase>,
    schedule_id: String,
    status: String,
    now: i64,
) -> Result<AgentSchedule, String> {
    let connection = connection(&database)?;
    set_schedule_status(&connection, &schedule_id, &status, now)
}

#[tauri::command]
pub fn list_agent_schedule_runs(
    database: State<'_, AppDatabase>,
    schedule_id: String,
) -> Result<Vec<AgentScheduleRun>, String> {
    let connection = connection(&database)?;
    list_schedule_runs(&connection, &schedule_id)
}

#[tauri::command]
pub fn delete_agent_schedule(
    database: State<'_, AppDatabase>,
    schedule_id: String,
) -> Result<(), String> {
    let connection = connection(&database)?;
    delete_schedule(&connection, &schedule_id)
}
