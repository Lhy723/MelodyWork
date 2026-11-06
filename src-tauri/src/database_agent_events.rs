use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::database_agent_migrations::complete_pi_migration_tx;
use super::database_core::{AppDatabase, current_timestamp};
#[path = "database_agent_events/event_contract.rs"]
mod event_contract;
use event_contract::{parse_event, required_id};

const DEFAULT_EVENT_LOG_LIMIT: i64 = 256;
const MAX_EVENT_LOG_LIMIT: i64 = 2048;

/// Outcome of appending a normalized Pi event to the Host log.
///
/// These states must stay distinct: an identical replay is safe to ignore,
/// while an event for an unknown product session is a protocol violation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PiEventPersistence {
    Inserted,
    Duplicate,
    UnknownSession,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventLogRecord {
    pub(crate) session_id: String,
    pub(crate) ordinal: i64,
    pub(crate) event_id: String,
    pub(crate) source_event_id: Option<String>,
    pub(crate) worker_epoch: Option<String>,
    pub(crate) seq: Option<i64>,
    /// The complete normalized event envelope. Keeping the envelope instead
    /// of only the inner event preserves request/session correlation for
    /// replay and diagnostics without making the renderer reconstruct it.
    pub(crate) event: Value,
    pub(crate) created_at: i64,
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentEventLogRecord> {
    let event_json: String = row.get(6)?;
    let event = serde_json::from_str(&event_json).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(AgentEventLogRecord {
        session_id: row.get(0)?,
        ordinal: row.get(1)?,
        event_id: row.get(2)?,
        source_event_id: row.get(3)?,
        worker_epoch: row.get(4)?,
        seq: row.get(5)?,
        event,
        created_at: row.get(7)?,
    })
}

/// Append one Pi event to the Host-owned product log.
///
/// The insert and native-session checkpoint share one SQLite transaction, so
/// a successful checkpoint can never point past an event that was not
/// recorded. An identical replay is explicitly distinguished from an unknown
/// product session so the worker reader can ignore the former without hiding
/// the latter.
pub(crate) fn append_pi_event(
    database: &AppDatabase,
    value: &Value,
) -> Result<PiEventPersistence, String> {
    let parsed = parse_event(value)?;
    let is_import_event = parsed
        .event
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("type"))
        .and_then(Value::as_str)
        == Some("session.imported");
    let mut connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    let session_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            [&parsed.session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !session_exists {
        // Standalone worker health/open smoke tests do not have an app
        // database session. Ignore those events just like the binding helper.
        transaction.rollback().map_err(|error| error.to_string())?;
        return Ok(PiEventPersistence::UnknownSession);
    }

    let existing: Option<String> = transaction
        .query_row(
            "SELECT event_json FROM agent_event_log
             WHERE session_id = ?1 AND event_id = ?2",
            params![parsed.session_id, parsed.event_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(existing) = existing {
        let same = serde_json::from_str::<Value>(&existing)
            .map(|value| value == parsed.event)
            .unwrap_or(false);
        if same {
            transaction.rollback().map_err(|error| error.to_string())?;
            return Ok(PiEventPersistence::Duplicate);
        }
        return Err(format!(
            "Pi event {} was replayed with a different payload",
            parsed.event_id
        ));
    }

    if let Some(existing_engine) = transaction
        .query_row(
            "SELECT engine FROM agent_session_bindings WHERE session_id = ?1",
            [&parsed.session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        && existing_engine != "pi"
        && !is_import_event
    {
        return Err(format!(
            "Cannot append Pi events to session {} bound to {}; an explicit migration is required",
            parsed.session_id, existing_engine
        ));
    }

    // A new worker epoch is allowed to restart seq at zero. Within one epoch
    // sequence numbers remain strictly increasing; this catches accidental
    // duplicate/out-of-order writes even if a caller bypasses the supervisor.
    if let Some(seq) = parsed.seq {
        let prior: Option<(Option<String>, Option<i64>)> = transaction
            .query_row(
                "SELECT worker_epoch, last_seq FROM agent_session_bindings
                 WHERE session_id = ?1 AND engine = 'pi'",
                [&parsed.session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some((Some(prior_epoch), Some(prior_seq))) = prior
            && Some(prior_epoch) == parsed.worker_epoch
            && seq <= prior_seq
        {
            return Err(format!(
                "Pi event seq {seq} is not greater than the last persisted seq {prior_seq}"
            ));
        }
    }

    let ordinal: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(ordinal) + 1, 0) FROM agent_event_log
             WHERE session_id = ?1",
            [&parsed.session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let now = current_timestamp(&transaction)?;
    transaction
        .execute(
            "INSERT INTO agent_event_log
                (session_id, ordinal, event_id, source_event_id, worker_epoch, seq, event_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                parsed.session_id,
                ordinal,
                parsed.event_id,
                parsed.source_event_id,
                parsed.worker_epoch,
                parsed.seq,
                parsed.event_json,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    if is_import_event {
        if let Some(migration_id) = parsed.migration_id.as_deref() {
            let native_session_id = parsed.native_session_id.as_deref().ok_or_else(|| {
                "session.imported must include nativeSessionId for journal completion".to_string()
            })?;
            complete_pi_migration_tx(
                &transaction,
                migration_id,
                &parsed.session_id,
                native_session_id,
                parsed.backup_ref.as_deref(),
            )?;
        }
    }
    super::database_agent_forks::apply_fork_event_tx(&transaction, &parsed.event)?;
    transaction
        .execute(
            "INSERT INTO agent_session_bindings
                (session_id, engine, native_session_id, worker_epoch, last_seq,
                 session_mode_id, permission_mode, model_id, reasoning_effort, updated_at)
             VALUES (?1, 'pi', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(session_id) DO UPDATE SET
                engine = 'pi',
                native_session_id = COALESCE(excluded.native_session_id, native_session_id),
                worker_epoch = COALESCE(excluded.worker_epoch, worker_epoch),
                last_seq = COALESCE(excluded.last_seq, last_seq),
                session_mode_id = COALESCE(excluded.session_mode_id, session_mode_id),
                permission_mode = COALESCE(excluded.permission_mode, permission_mode),
                model_id = COALESCE(excluded.model_id, model_id),
                reasoning_effort = COALESCE(excluded.reasoning_effort, reasoning_effort),
                updated_at = excluded.updated_at",
            params![
                parsed.session_id,
                parsed.native_session_id,
                parsed.worker_epoch,
                parsed.seq,
                parsed.session_mode_id,
                parsed.permission_mode,
                parsed.model_id,
                parsed.reasoning_effort,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
            params![parsed.session_id, now],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(PiEventPersistence::Inserted)
}

fn normalize_limit(limit: Option<i64>) -> Result<i64, String> {
    let limit = limit.unwrap_or(DEFAULT_EVENT_LOG_LIMIT);
    if !(1..=MAX_EVENT_LOG_LIMIT).contains(&limit) {
        return Err(format!(
            "event log limit must be between 1 and {MAX_EVENT_LOG_LIMIT}"
        ));
    }
    Ok(limit)
}

#[tauri::command]
pub fn read_agent_event_log(
    database: State<'_, AppDatabase>,
    session_id: String,
    after_ordinal: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<AgentEventLogRecord>, String> {
    required_id(&session_id, "sessionId")?;
    let after_ordinal = after_ordinal.unwrap_or(-1);
    if after_ordinal < -1 {
        return Err("afterOrdinal must be -1 or a non-negative integer".to_string());
    }
    let limit = normalize_limit(limit)?;
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT session_id, ordinal, event_id, source_event_id, worker_epoch, seq,
                    event_json, created_at
             FROM agent_event_log
             WHERE session_id = ?1 AND ordinal > ?2
             ORDER BY ordinal ASC
             LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    statement
        .query_map(params![session_id, after_ordinal, limit], record_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}
