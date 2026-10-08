use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::database_agent_migrations::{
    backup_ref_from_event, complete_pi_migration_tx, migration_id_from_event,
};
use super::database_core::{AppDatabase, current_timestamp};

/// Keep individual events bounded even though the event log itself is
/// append-only. The worker transport has the same 1 MiB frame limit; this
/// guard also protects callers that use the database helper directly.
pub(crate) const MAX_AGENT_EVENT_JSON_BYTES: usize = 1024 * 1024;
const MAX_EVENT_ID_BYTES: usize = 256;
const DEFAULT_EVENT_LOG_LIMIT: i64 = 256;
const MAX_EVENT_LOG_LIMIT: i64 = 2048;
const PI_SESSION_MODES: [&str; 3] = ["default", "plan", "ask"];
const PERMISSION_MODES: [&str; 3] = ["ask", "auto", "always-approve"];
const PI_REASONING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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

fn required_id(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.len() > MAX_EVENT_ID_BYTES {
        return Err(format!(
            "{field} exceeds the {MAX_EVENT_ID_BYTES}-byte limit"
        ));
    }
    Ok(())
}

fn optional_id(value: Option<&str>, field: &str) -> Result<(), String> {
    if let Some(value) = value {
        required_id(value, field)?;
    }
    Ok(())
}

struct ParsedEvent {
    session_id: String,
    event_id: String,
    source_event_id: Option<String>,
    worker_epoch: Option<String>,
    seq: Option<i64>,
    native_session_id: Option<String>,
    session_mode_id: Option<String>,
    permission_mode: Option<String>,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
    migration_id: Option<String>,
    backup_ref: Option<String>,
    event_json: String,
    event: Value,
}

fn parse_event(value: &Value) -> Result<ParsedEvent, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Pi event envelope must be an object".to_string())?;
    if object.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Pi event uses an unsupported protocol version".to_string());
    }
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Pi event sessionId must be a non-empty string".to_string())?;
    required_id(session_id, "sessionId")?;
    let event_id = object
        .get("eventId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Pi event eventId must be a non-empty string".to_string())?;
    required_id(event_id, "eventId")?;
    let stream_session_id = object
        .get("streamSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    optional_id(stream_session_id.as_deref(), "streamSessionId")?;
    if object.get("replay").and_then(Value::as_bool).is_none() {
        return Err("Pi event replay must be a boolean".to_string());
    }
    let event = object
        .get("event")
        .filter(|event| event.is_object())
        .cloned()
        .ok_or_else(|| "Pi event inner event must be an object".to_string())?;
    let event_type = event.get("type").and_then(Value::as_str);
    if event_type == Some("session.imported")
        && event
            .get("nativeSessionId")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err("session.imported must include nativeSessionId".to_string());
    }
    let source_event_id = object
        .get("sourceEventId")
        .and_then(Value::as_str)
        .map(str::to_string);
    optional_id(source_event_id.as_deref(), "sourceEventId")?;
    let worker_epoch = object
        .get("workerEpoch")
        .and_then(Value::as_str)
        .map(str::to_string);
    optional_id(worker_epoch.as_deref(), "workerEpoch")?;
    let seq = object
        .get("seq")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| "Pi event seq must be a non-negative integer".to_string())
                .and_then(|seq| {
                    i64::try_from(seq)
                        .map_err(|_| "Pi event seq exceeds the SQLite integer range".to_string())
                })
        })
        .transpose()?;
    let native_session_id = event
        .get("nativeSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    optional_id(native_session_id.as_deref(), "nativeSessionId")?;
    let optional_enum = |field: &str, allowed: &[&str]| -> Result<Option<String>, String> {
        match event.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) if allowed.contains(&value.as_str()) => {
                Ok(Some(value.clone()))
            }
            Some(Value::String(value)) => {
                Err(format!("Pi event {field} has unsupported value {value}"))
            }
            Some(_) => Err(format!("Pi event {field} must be a string when present")),
        }
    };
    let session_mode_id = optional_enum("sessionModeId", &PI_SESSION_MODES)?;
    let permission_mode = optional_enum("permissionMode", &PERMISSION_MODES)?;
    let model_id = match event.get("modelId") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            required_id(value, "modelId")?;
            Some(value.clone())
        }
        Some(_) => return Err("Pi event modelId must be a string when present".to_string()),
    };
    let reasoning_effort = optional_enum("reasoningEffort", &PI_REASONING_LEVELS)?;
    let migration_id = migration_id_from_event(&event).map(str::to_string);
    optional_id(migration_id.as_deref(), "migrationId")?;
    let backup_ref = backup_ref_from_event(&event).map(str::to_string);
    if backup_ref
        .as_deref()
        .is_some_and(|value| value.len() > 4096)
    {
        return Err("backupPath exceeds the 4096-byte limit".to_string());
    }
    let event_json = serde_json::to_string(value).map_err(|error| error.to_string())?;
    if event_json.len() > MAX_AGENT_EVENT_JSON_BYTES {
        return Err(format!(
            "Pi event exceeds the {} MiB limit",
            MAX_AGENT_EVENT_JSON_BYTES / (1024 * 1024)
        ));
    }
    Ok(ParsedEvent {
        session_id: session_id.to_string(),
        event_id: event_id.to_string(),
        source_event_id,
        worker_epoch,
        seq,
        native_session_id,
        session_mode_id,
        permission_mode,
        model_id,
        reasoning_effort,
        migration_id,
        backup_ref,
        event_json,
        event: value.clone(),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn database_with_session() -> AppDatabase {
        let database = AppDatabase::in_memory();
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO projects VALUES ('p1', 'Demo', '/tmp/demo', 1, 0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sessions VALUES
                 ('s1', 'p1', 'Test', '/tmp/demo', NULL, '[]', NULL, 0, 1, 1)",
                [],
            )
            .unwrap();
        drop(connection);
        database
    }

    fn event(id: &str, seq: u64, epoch: &str) -> Value {
        serde_json::json!({
            "protocolVersion": 1,
            "eventId": id,
            "sourceEventId": id,
            "sessionId": "s1",
            "seq": seq,
            "workerEpoch": epoch,
            "replay": false,
            "event": {"type": "message.completed", "messageId": id, "role": "assistant"}
        })
    }

    #[test]
    fn appends_events_idempotently_and_advances_the_binding() {
        let database = database_with_session();
        assert_eq!(
            append_pi_event(&database, &event("e1", 0, "epoch-1")).unwrap(),
            PiEventPersistence::Inserted
        );
        assert_eq!(
            append_pi_event(&database, &event("e1", 0, "epoch-1")).unwrap(),
            PiEventPersistence::Duplicate
        );
        assert_eq!(
            append_pi_event(&database, &event("e2", 1, "epoch-1")).unwrap(),
            PiEventPersistence::Inserted
        );
        let connection = database.connection.lock().unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM agent_event_log WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        let last_seq: i64 = connection
            .query_row(
                "SELECT last_seq FROM agent_session_bindings WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last_seq, 1);
    }

    #[test]
    fn persists_authoritative_session_modes_and_keeps_partial_updates() {
        let database = database_with_session();
        let mut opened = event("opened", 0, "epoch-1");
        opened["event"] = serde_json::json!({
            "type": "session.opened",
            "nativeSessionId": "native-1",
            "revision": 0,
            "modelId": "demo/model-1",
            "reasoningEffort": "high",
            "sessionModeId": "plan",
            "permissionMode": "auto"
        });
        append_pi_event(&database, &opened).unwrap();

        let mut configured = event("configured", 1, "epoch-1");
        configured["event"] = serde_json::json!({
            "type": "session.configured",
            "revision": 1,
            "sessionModeId": "ask"
        });
        append_pi_event(&database, &configured).unwrap();

        let connection = database.connection.lock().unwrap();
        let modes: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT session_mode_id, permission_mode, model_id, reasoning_effort
                 FROM agent_session_bindings WHERE session_id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(modes.0.as_deref(), Some("ask"));
        assert_eq!(modes.1.as_deref(), Some("auto"));
        assert_eq!(modes.2.as_deref(), Some("demo/model-1"));
        assert_eq!(modes.3.as_deref(), Some("high"));
    }

    #[test]
    fn rejects_unknown_persisted_session_modes() {
        let database = database_with_session();
        let mut invalid = event("invalid", 0, "epoch-1");
        invalid["event"] = serde_json::json!({
            "type": "session.configured",
            "sessionModeId": "unsafe"
        });
        let error = append_pi_event(&database, &invalid).unwrap_err();
        assert!(error.contains("sessionModeId"));
    }

    #[test]
    fn rejects_unknown_persisted_reasoning_levels() {
        let database = database_with_session();
        let mut invalid = event("invalid-reasoning", 0, "epoch-1");
        invalid["event"] = serde_json::json!({
            "type": "session.configured",
            "reasoningEffort": "ultra"
        });
        let error = append_pi_event(&database, &invalid).unwrap_err();
        assert!(error.contains("reasoningEffort"));
    }

    #[test]
    fn permits_a_new_worker_epoch_but_rejects_old_sequence_in_one_epoch() {
        let database = database_with_session();
        append_pi_event(&database, &event("e1", 4, "epoch-1")).unwrap();
        assert_eq!(
            append_pi_event(&database, &event("e2", 0, "epoch-2")).unwrap(),
            PiEventPersistence::Inserted
        );
        let error = append_pi_event(&database, &event("e3", 0, "epoch-2")).unwrap_err();
        assert!(error.contains("not greater"));
    }

    #[test]
    fn rejects_same_event_id_with_a_changed_payload() {
        let database = database_with_session();
        append_pi_event(&database, &event("e1", 0, "epoch-1")).unwrap();
        let mut changed = event("e1", 0, "epoch-1");
        changed["event"]["messageId"] = Value::String("different".to_string());
        let error = append_pi_event(&database, &changed).unwrap_err();
        assert!(error.contains("different payload"));
    }

    #[test]
    fn does_not_replace_a_legacy_binding_implicitly() {
        let database = database_with_session();
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO agent_session_bindings
                 (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                 VALUES ('s1', 'melody-acp', 'acp-1', NULL, NULL, 1)",
                [],
            )
            .unwrap();
        drop(connection);
        let error = append_pi_event(&database, &event("e1", 0, "epoch-1")).unwrap_err();
        assert!(error.contains("explicit migration"));
        let connection = database.connection.lock().unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM agent_event_log WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn migration_event_switches_legacy_binding_before_normal_pi_events() {
        let database = database_with_session();
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO agent_session_bindings
                 (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                 VALUES ('s1', 'melody-acp', 'acp-1', NULL, NULL, 1)",
                [],
            )
            .unwrap();
        drop(connection);

        let mut imported = event("import", 0, "epoch-1");
        imported["event"] = serde_json::json!({
            "type": "session.imported",
            "nativeSessionId": "pi-native-1",
            "importedRecords": 2
        });
        assert_eq!(
            append_pi_event(&database, &imported).unwrap(),
            PiEventPersistence::Inserted
        );
        assert_eq!(
            append_pi_event(&database, &event("next", 1, "epoch-1")).unwrap(),
            PiEventPersistence::Inserted
        );
        let connection = database.connection.lock().unwrap();
        let binding: (String, String) = connection
            .query_row(
                "SELECT engine, native_session_id FROM agent_session_bindings WHERE session_id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(binding, ("pi".to_string(), "pi-native-1".to_string()));
    }

    #[test]
    fn imported_event_completes_the_journal_atomically() {
        let database = database_with_session();
        let migration_id = "migration-1";
        let plan = serde_json::json!({
            "planVersion": 1,
            "converterVersion": "pi-import-v1",
            "targetFormat": "pi-coding-agent-v3",
            "sourceSessionId": "s1",
            "sourceEngine": "melody-acp",
            "targetEngine": "pi",
            "sourceDigest": "digest-1",
            "readiness": "native-ready",
            "records": []
        });
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO agent_session_bindings
                 (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                 VALUES ('s1', 'melody-acp', 'acp-1', NULL, NULL, 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO migration_journal
                 (migration_id, session_id, source_engine, target_engine, source_digest,
                  converter_version, stage, validation_report, plan_json, backup_requested,
                  created_at, updated_at)
                 VALUES (?1, 's1', 'melody-acp', 'pi', 'digest-1', 'pi-import-v1',
                         'materializing', ?2, ?3, 1, 1, 1)",
                rusqlite::params![migration_id, plan.to_string(), plan.to_string()],
            )
            .unwrap();
        drop(connection);

        let mut imported = event("import-with-journal", 0, "epoch-1");
        imported["event"] = serde_json::json!({
            "type": "session.imported",
            "nativeSessionId": "pi-native-1",
            "importedRecords": 2,
            "migrationId": migration_id,
            "backupPath": "/tmp/melody-backup"
        });
        assert_eq!(
            append_pi_event(&database, &imported).unwrap(),
            PiEventPersistence::Inserted
        );

        let connection = database.connection.lock().unwrap();
        let journal: (String, String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT stage, target_native_session_id, backup_ref, error
                 FROM migration_journal WHERE migration_id = ?1",
                [migration_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            journal,
            (
                "applied".to_string(),
                "pi-native-1".to_string(),
                Some("/tmp/melody-backup".to_string()),
                None
            )
        );
        let event_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM agent_event_log WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 1);
    }

    #[test]
    fn imported_event_with_unknown_journal_rolls_back_event_and_binding() {
        let database = database_with_session();
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO agent_session_bindings
                 (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                 VALUES ('s1', 'melody-acp', 'acp-1', NULL, NULL, 1)",
                [],
            )
            .unwrap();
        drop(connection);

        let mut imported = event("import-without-journal", 0, "epoch-1");
        imported["event"] = serde_json::json!({
            "type": "session.imported",
            "nativeSessionId": "pi-native-1",
            "migrationId": "missing-migration"
        });
        let error = append_pi_event(&database, &imported).unwrap_err();
        assert!(error.contains("does not exist"));

        let connection = database.connection.lock().unwrap();
        let event_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM agent_event_log WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 0);
        let binding: (String, String) = connection
            .query_row(
                "SELECT engine, native_session_id FROM agent_session_bindings WHERE session_id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(binding, ("melody-acp".to_string(), "acp-1".to_string()));
    }

    #[test]
    fn read_is_ordered_and_bounded() {
        let database = database_with_session();
        for sequence in 0..3 {
            append_pi_event(
                &database,
                &event(&format!("e{sequence}"), sequence, "epoch-1"),
            )
            .unwrap();
        }
        let connection = database.connection.lock().unwrap();
        let mut statement = connection
            .prepare(
                "SELECT ordinal, event_id FROM agent_event_log
                 WHERE session_id = 's1' AND ordinal > 0 ORDER BY ordinal ASC LIMIT 1",
            )
            .unwrap();
        let row = statement
            .query_row([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        assert_eq!(row, (1, "e1".to_string()));
        drop(statement);
        drop(connection);
        assert!(normalize_limit(Some(-2)).is_err());
    }

    #[test]
    fn distinguishes_unknown_product_sessions_from_duplicate_replays() {
        let database = database_with_session();
        assert_eq!(
            append_pi_event(&database, &event("e1", 0, "epoch-1")).unwrap(),
            PiEventPersistence::Inserted
        );
        assert_eq!(
            append_pi_event(&database, &event("e1", 0, "epoch-1")).unwrap(),
            PiEventPersistence::Duplicate
        );

        let mut unknown = event("e2", 1, "epoch-1");
        unknown["sessionId"] = Value::String("missing".to_string());
        assert_eq!(
            append_pi_event(&database, &unknown).unwrap(),
            PiEventPersistence::UnknownSession
        );
    }
}
