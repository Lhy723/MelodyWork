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

const MAX_SCHEDULE_ID_BYTES: usize = 256;
const MAX_SCHEDULE_PROMPT_BYTES: usize = 32 * 1024;
/// A schedule must not be able to spin the Host: the floor is a rate limit, not
/// a user preference, and matches the handoff's requirement that scheduling has
/// a bounded trigger rate.
pub(crate) const MIN_SCHEDULE_INTERVAL_MS: i64 = 5_000;
pub(crate) const MAX_SCHEDULE_INTERVAL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
pub(crate) const MAX_SCHEDULE_RUNS: i64 = 1_000;
const MAX_SCHEDULE_RUN_ROWS: i64 = 512;
const SCHEDULE_KINDS: [&str; 3] = ["once", "interval", "cron"];
const MISSED_POLICIES: [&str; 2] = ["skip", "run-once"];
const SCHEDULE_STATUSES: [&str; 5] = ["active", "paused", "completed", "expired", "cancelled"];
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

/// The outcome of moving a schedule forward in time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScheduleAdvance {
    pub(crate) status: String,
    pub(crate) next_run_at: Option<i64>,
    pub(crate) run_count: i64,
    pub(crate) completed: bool,
}

/// Next fire time at or after `after`, or `None` for a spent schedule.
#[cfg(test)]
pub(crate) fn next_fire_after(
    kind: &str,
    interval_ms: Option<i64>,
    run_at: Option<i64>,
    after: i64,
) -> Option<i64> {
    next_fire_after_with_cron(kind, interval_ms, run_at, None, after)
}

/// Cron expressions are validated at creation; failure here means the stored
/// row is corrupt or the expression has no match in the bounded search window.
pub(crate) fn next_fire_after_with_cron(
    kind: &str,
    interval_ms: Option<i64>,
    run_at: Option<i64>,
    cron: Option<&str>,
    after: i64,
) -> Option<i64> {
    match kind {
        // A one-shot fires when its instant arrives, so `run_at == now` is due.
        "once" => run_at.filter(|at| *at >= after),
        "interval" => {
            let interval = interval_ms?;
            if interval <= 0 {
                return None;
            }
            match run_at {
                Some(first) if first > after => Some(first),
                _ => {
                    // An interval is anchored at its first run time (or at
                    // creation), and a missed trigger is advanced over rather
                    // than replayed as a burst.
                    let base = run_at.unwrap_or(after);
                    let elapsed = after.saturating_sub(base);
                    let steps = elapsed / interval + 1;
                    Some(base.saturating_add(steps.saturating_mul(interval)))
                }
            }
        }
        "cron" => {
            let expression = cron?;
            crate::cron_schedule::next_cron_fire_after_ms(expression, after).ok()
        }
        _ => None,
    }
}

/// Advance a schedule after one fire (real or skipped).
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(crate) fn advance_after_fire(
    kind: &str,
    interval_ms: Option<i64>,
    run_at: Option<i64>,
    run_count: i64,
    max_runs: Option<i64>,
    expires_at: Option<i64>,
    fired_at: i64,
) -> ScheduleAdvance {
    advance_after_fire_with_cron(
        kind,
        interval_ms,
        run_at,
        None,
        run_count,
        max_runs,
        expires_at,
        fired_at,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn advance_after_fire_with_cron(
    kind: &str,
    interval_ms: Option<i64>,
    run_at: Option<i64>,
    cron: Option<&str>,
    run_count: i64,
    max_runs: Option<i64>,
    expires_at: Option<i64>,
    fired_at: i64,
) -> ScheduleAdvance {
    let run_count = run_count.saturating_add(1);
    let exhausted = max_runs.is_some_and(|limit| run_count >= limit)
        || (kind == "once" && run_at.is_some_and(|at| at <= fired_at));
    if exhausted {
        return ScheduleAdvance {
            status: "completed".to_string(),
            next_run_at: None,
            run_count,
            completed: true,
        };
    }
    let next = next_fire_after_with_cron(kind, interval_ms, run_at, cron, fired_at);
    match next {
        Some(next) if expires_at.is_some_and(|expiry| next > expiry) => ScheduleAdvance {
            status: "expired".to_string(),
            next_run_at: None,
            run_count,
            completed: true,
        },
        Some(next) => ScheduleAdvance {
            status: "active".to_string(),
            next_run_at: Some(next),
            run_count,
            completed: false,
        },
        None => ScheduleAdvance {
            status: "completed".to_string(),
            next_run_at: None,
            run_count,
            completed: true,
        },
    }
}

/// Whether a due schedule should run or be skipped because it was missed.
///
/// `grace` is how late a trigger may be and still count as on time. Anything
/// later follows the schedule's missed policy: `skip` advances without running,
/// `run-once` fires a single catch-up run.
pub(crate) fn missed_decision(due_at: i64, now: i64, grace_ms: i64, missed_policy: &str) -> bool {
    if now.saturating_sub(due_at) <= grace_ms {
        return true;
    }
    missed_policy == "run-once"
}

fn required_id(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.len() > MAX_SCHEDULE_ID_BYTES {
        return Err(format!(
            "{field} exceeds the {MAX_SCHEDULE_ID_BYTES}-byte limit"
        ));
    }
    Ok(())
}

fn validate_kind(value: &str) -> Result<(), String> {
    if SCHEDULE_KINDS.contains(&value) {
        return Ok(());
    }
    Err("schedule kind must be once, interval or cron".to_string())
}

fn validate_status(value: &str) -> Result<(), String> {
    if SCHEDULE_STATUSES.contains(&value) {
        return Ok(());
    }
    Err("schedule status is not recognised".to_string())
}

fn validate_policy(value: &str) -> Result<(), String> {
    if MISSED_POLICIES.contains(&value) {
        return Ok(());
    }
    Err("missedPolicy must be skip or run-once".to_string())
}

/// Parse Melody's compact interval form (`5m`, `2h`, `1d`, `90s`).
///
/// Melody clamps anything below 60 seconds up to 60; the Host keeps that rule so
/// a skill that asks for a tight loop still cannot spin the scheduler.
pub(crate) fn parse_scheduler_interval(value: &str) -> Result<i64, String> {
    let trimmed = value.trim();
    // Split on the last *character*, not the last byte: a multi-byte suffix such
    // as "5分" would otherwise make the slice panic on a non-boundary index.
    let Some(suffix) = trimmed.chars().next_back() else {
        return Err(format!(
            "invalid interval {trimmed:?}: expected e.g. 5m, 2h, 1d"
        ));
    };
    if trimmed.len() < 2 {
        return Err(format!(
            "invalid interval {trimmed:?}: expected e.g. 5m, 2h, 1d"
        ));
    }
    let digits = &trimmed[..trimmed.len() - suffix.len_utf8()];
    let amount: i64 = digits
        .parse()
        .map_err(|_| format!("invalid interval {trimmed:?}: expected e.g. 5m, 2h, 1d"))?;
    if amount <= 0 {
        return Err("interval value must be greater than 0".to_string());
    }
    let unit_ms = match suffix {
        's' => 1_000,
        'm' => 60_000,
        'h' => 3_600_000,
        'd' => 86_400_000,
        other => {
            return Err(format!(
                "invalid interval suffix {other:?}: expected s, m, h or d"
            ));
        }
    };
    // Melody's floor is one minute; the Host's is lower, so the clamp here is
    // what a model-created schedule actually gets.
    let millis = amount.saturating_mul(unit_ms);
    Ok(millis.clamp(
        MIN_SCHEDULE_INTERVAL_MS.max(60_000),
        MAX_SCHEDULE_INTERVAL_MS,
    ))
}

/// Create a schedule on behalf of a model tool call.
///
/// The permission/session identity is read from the session's binding rather
/// than from the tool arguments: a model cannot grant its schedule more
/// authority than the session currently has, and the dispatcher narrows it
/// further against the live binding at fire time.
#[cfg(test)]
pub(crate) fn create_schedule_from_tool(
    connection: &Connection,
    session_id: &str,
    task_id: Option<&str>,
    interval_ms: i64,
    prompt: &str,
    fire_immediately: bool,
    now: i64,
) -> Result<AgentSchedule, String> {
    create_schedule_from_tool_with_kind(
        connection,
        session_id,
        task_id,
        "interval",
        Some(interval_ms),
        None,
        prompt,
        fire_immediately,
        now,
    )
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT NOT NULL);
                 CREATE TABLE agent_session_bindings (
                     session_id TEXT PRIMARY KEY,
                     engine TEXT NOT NULL,
                     native_session_id TEXT,
                     worker_epoch TEXT,
                     last_seq INTEGER,
                     session_mode_id TEXT,
                     permission_mode TEXT,
                     model_id TEXT,
                     reasoning_effort TEXT,
                     updated_at INTEGER NOT NULL
                 );
                 INSERT INTO sessions (id, project_id, title, cwd) VALUES ('s1', 'p1', 't', '/tmp');",
            )
            .unwrap();
        ensure_agent_schedule_schema(&connection).unwrap();
        connection
    }

    fn request(
        kind: &str,
        interval_ms: Option<i64>,
        run_at: Option<i64>,
    ) -> CreateAgentScheduleRequest {
        CreateAgentScheduleRequest {
            schedule_id: "schedule-1".to_string(),
            session_id: "s1".to_string(),
            project_id: "p1".to_string(),
            kind: kind.to_string(),
            interval_ms,
            run_at,
            cron: None,
            prompt: "Summarize the open work".to_string(),
            missed_policy: Some("skip".to_string()),
            max_runs: None,
            expires_at: None,
            permission_mode: "ask".to_string(),
            session_mode_id: "default".to_string(),
            model_id: None,
            reasoning_effort: None,
            now: 1_000_000,
        }
    }

    #[test]
    fn scheduler_intervals_follow_melody_parsing_and_clamping() {
        assert_eq!(parse_scheduler_interval("5m").unwrap(), 300_000);
        assert_eq!(parse_scheduler_interval("2h").unwrap(), 7_200_000);
        assert_eq!(parse_scheduler_interval("1d").unwrap(), 86_400_000);
        assert_eq!(parse_scheduler_interval("90s").unwrap(), 90_000);
        // Melody clamps anything faster than a minute, so a skill cannot spin us.
        assert_eq!(parse_scheduler_interval("10s").unwrap(), 60_000);
        assert_eq!(parse_scheduler_interval("1s").unwrap(), 60_000);
        for invalid in ["", "m", "5x", "0m", "-5m", "5"] {
            assert!(
                parse_scheduler_interval(invalid).is_err(),
                "{invalid:?} must be rejected"
            );
        }
        // A multi-byte suffix must be a clean error, not a slice panic: the
        // model can send any text as the interval.
        for non_ascii in ["5分", "5分钟", "每次5m", "５m"] {
            assert!(
                parse_scheduler_interval(non_ascii).is_err(),
                "{non_ascii:?} must be rejected"
            );
        }
        // Absurd but parseable values saturate instead of overflowing.
        assert_eq!(
            parse_scheduler_interval("9223372036854775807d").unwrap(),
            MAX_SCHEDULE_INTERVAL_MS
        );
    }

    #[test]
    fn a_model_created_schedule_inherits_the_session_identity() {
        let connection = memory_database();
        connection
            .execute_batch(
                "INSERT INTO agent_session_bindings
                    (session_id, engine, session_mode_id, permission_mode, model_id,
                     reasoning_effort, updated_at)
                 VALUES ('s1', 'pi', 'plan', 'auto', 'provider/model', 'high', 1);",
            )
            .unwrap();
        let schedule = create_schedule_from_tool(
            &connection,
            "s1",
            Some("nightly"),
            300_000,
            "Summarize open work",
            false,
            1_000_000,
        )
        .unwrap();
        assert_eq!(schedule.schedule_id, "scheduler-nightly");
        assert_eq!(schedule.permission_mode, "auto");
        assert_eq!(schedule.session_mode_id, "plan");
        assert_eq!(schedule.model_id.as_deref(), Some("provider/model"));
        assert_eq!(schedule.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(schedule.next_run_at, Some(1_300_000));

        // Reusing the task id updates the same timer instead of duplicating it.
        let updated = create_schedule_from_tool(
            &connection,
            "s1",
            Some("nightly"),
            600_000,
            "Summarize open work (updated)",
            false,
            1_100_000,
        )
        .unwrap();
        assert_eq!(updated.revision, schedule.revision + 1);
        assert_eq!(list_schedules(&connection, Some("s1")).unwrap().len(), 1);
        assert!(updated.prompt.contains("updated"));
    }

    #[test]
    fn a_model_created_schedule_refuses_other_engines_and_sessions() {
        let connection = memory_database();
        connection
            .execute_batch(
                "INSERT INTO sessions (id, project_id, title, cwd)
                    VALUES ('s2', 'p1', 'Other', '/tmp');
                 INSERT INTO agent_session_bindings (session_id, engine, updated_at)
                    VALUES ('s2', 'melody-acp', 1);",
            )
            .unwrap();
        // No binding yet is a different situation from an ACP binding, and the
        // two must not share one misleading message.
        let unbound = create_schedule_from_tool(&connection, "s1", None, 60_000, "x", false, 1)
            .expect_err("a session without a Pi binding cannot be scheduled");
        assert!(unbound.contains("no Pi engine binding"), "{unbound}");
        let error = create_schedule_from_tool(&connection, "s2", None, 60_000, "x", false, 1)
            .expect_err("an ACP session must not take a Host schedule");
        assert!(error.contains("compatibility engine"), "{error}");
    }

    #[test]
    fn fire_immediately_makes_the_schedule_due_now() {
        let connection = memory_database();
        connection
            .execute_batch(
                "INSERT INTO agent_session_bindings (session_id, engine, updated_at)
                 VALUES ('s1', 'pi', 1);",
            )
            .unwrap();
        let schedule = create_schedule_from_tool(
            &connection,
            "s1",
            None,
            3_600_000,
            "Check the deploy",
            true,
            2_000_000,
        )
        .unwrap();
        assert_eq!(schedule.next_run_at, Some(2_000_000));
        let due = due_schedules(&connection, 2_000_000, 8).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].schedule_id, schedule.schedule_id);
    }

    #[test]
    fn interval_schedules_never_replay_missed_slots_as_a_burst() {
        // Ten intervals elapsed while the app was closed: the next fire time
        // jumps forward instead of queueing ten runs.
        let next = next_fire_after("interval", Some(60_000), None, 1_600_000);
        assert_eq!(next, Some(1_660_000));
        assert_eq!(
            next_fire_after("interval", Some(60_000), None, 1_000_000),
            Some(1_060_000)
        );
        assert_eq!(
            next_fire_after("once", None, Some(1_500_000), 1_600_000),
            None
        );
        assert_eq!(
            next_fire_after("once", None, Some(1_500_000), 1_400_000),
            Some(1_500_000)
        );
    }

    #[test]
    fn missed_policy_decides_between_catch_up_and_skip() {
        assert!(missed_decision(1_000, 1_000, 30_000, "skip"));
        assert!(missed_decision(1_000, 20_000, 30_000, "skip"));
        assert!(!missed_decision(1_000, 60_000, 30_000, "skip"));
        assert!(missed_decision(1_000, 60_000, 30_000, "run-once"));
    }

    #[test]
    fn advancing_respects_max_runs_expiry_and_completion() {
        let completed =
            advance_after_fire("interval", Some(60_000), None, 2, Some(3), None, 5_000_000);
        assert!(completed.completed);
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.run_count, 3);

        let expired = advance_after_fire(
            "interval",
            Some(60_000),
            None,
            0,
            None,
            Some(5_030_000),
            5_000_000,
        );
        assert_eq!(expired.status, "expired");
        assert!(expired.next_run_at.is_none());

        let once = advance_after_fire("once", None, Some(5_000_000), 0, None, None, 5_000_000);
        assert!(once.completed);
    }

    #[test]
    fn stores_and_validates_a_schedule() {
        let connection = memory_database();
        let created =
            insert_schedule(&connection, &request("interval", Some(60_000), None)).unwrap();
        assert_eq!(created.status, "active");
        assert_eq!(created.next_run_at, Some(1_060_000));
        assert_eq!(created.revision, 1);

        // A renderer cannot forge the starting point or skip the rate floor.
        let mut too_fast = request("interval", Some(1_000), None);
        too_fast.schedule_id = "schedule-2".to_string();
        assert!(insert_schedule(&connection, &too_fast).is_err());

        let mut no_future = request("once", None, Some(0));
        no_future.schedule_id = "schedule-3".to_string();
        no_future.now = 1_000_000;
        assert!(insert_schedule(&connection, &no_future).is_err());

        let mut bad_mode = request("interval", Some(60_000), None);
        bad_mode.schedule_id = "schedule-4".to_string();
        bad_mode.permission_mode = "yolo".to_string();
        assert!(insert_schedule(&connection, &bad_mode).is_err());
    }

    #[test]
    fn recording_a_run_advances_and_journals_the_outcome() {
        let connection = memory_database();
        insert_schedule(&connection, &request("interval", Some(60_000), None)).unwrap();
        let due = due_schedules(&connection, 1_060_000, 8).unwrap();
        assert_eq!(due.len(), 1);

        let after = record_schedule_run(
            &connection,
            "schedule-1",
            "fired",
            Some("run-1"),
            None,
            1_060_000,
        )
        .unwrap();
        assert_eq!(after.run_count, 1);
        assert_eq!(after.last_run_at, Some(1_060_000));
        assert_eq!(after.next_run_at, Some(1_120_000));
        assert_eq!(due_schedules(&connection, 1_060_000, 8).unwrap().len(), 0);

        let runs = list_schedule_runs(&connection, "schedule-1").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "fired");
        assert_eq!(runs[0].run_id.as_deref(), Some("run-1"));

        // A skipped trigger is journaled too, so the user can tell the
        // difference between "ran" and "the app was closed".
        record_schedule_run(&connection, "schedule-1", "skipped", None, None, 1_200_000).unwrap();
        let runs = list_schedule_runs(&connection, "schedule-1").unwrap();
        assert_eq!(runs[0].status, "skipped");
        assert_eq!(runs[0].run_ordinal, 1);
    }

    #[test]
    fn a_failed_dispatch_keeps_the_schedule_alive() {
        let connection = memory_database();
        insert_schedule(&connection, &request("interval", Some(60_000), None)).unwrap();
        let after = record_schedule_run(
            &connection,
            "schedule-1",
            "failed",
            None,
            Some("worker unavailable"),
            1_060_000,
        )
        .unwrap();
        assert_eq!(after.status, "active");
        assert_eq!(
            after.run_count, 0,
            "a failed attempt is not a completed run"
        );
        assert_eq!(after.next_run_at, Some(1_120_000));
    }

    #[test]
    fn pause_resume_and_cancel_follow_the_lifecycle_rules() {
        let connection = memory_database();
        insert_schedule(&connection, &request("interval", Some(60_000), None)).unwrap();

        let paused = set_schedule_status(&connection, "schedule-1", "paused", 2_000_000).unwrap();
        assert_eq!(paused.status, "paused");
        assert!(paused.next_run_at.is_none());
        assert!(due_schedules(&connection, 9_000_000, 8).unwrap().is_empty());

        let resumed = set_schedule_status(&connection, "schedule-1", "active", 2_000_000).unwrap();
        assert_eq!(
            resumed.next_run_at,
            Some(2_060_000),
            "resume skips the missed window"
        );
        assert_eq!(resumed.run_count, 0);

        let cancelled =
            set_schedule_status(&connection, "schedule-1", "cancelled", 2_100_000).unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(set_schedule_status(&connection, "schedule-1", "active", 2_200_000).is_err());
        assert!(due_schedules(&connection, 9_000_000, 8).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_schedule_removes_its_run_journal() {
        let connection = memory_database();
        insert_schedule(&connection, &request("interval", Some(60_000), None)).unwrap();
        record_schedule_run(&connection, "schedule-1", "fired", None, None, 1_060_000).unwrap();
        delete_schedule(&connection, "schedule-1").unwrap();
        assert!(read_schedule(&connection, "schedule-1").unwrap().is_none());
        assert!(
            list_schedule_runs(&connection, "schedule-1")
                .unwrap()
                .is_empty()
        );
    }
}
