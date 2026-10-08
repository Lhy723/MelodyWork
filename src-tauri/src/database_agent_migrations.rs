//! Durable, retry-safe bookkeeping for ACP → Pi session conversions.
//!
//! The journal is deliberately separate from both the ACP projection and the
//! Pi native JSONL.  It records the exact source fingerprint and converter
//! plan used for an attempt, so a crash between materializing JSONL and
//! receiving `session.imported` can be diagnosed and retried without silently
//! replacing a legacy session.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use uuid::Uuid;

use super::database_core::{AppDatabase, current_timestamp};

pub(crate) const MAX_MIGRATION_ID_BYTES: usize = 256;
const MAX_SOURCE_DIGEST_BYTES: usize = 256;
const MAX_CONVERTER_VERSION_BYTES: usize = 128;
const MAX_VALIDATION_REPORT_BYTES: usize = 1024 * 1024;
const MAX_PLAN_BYTES: usize = 4 * 1024 * 1024;
const MAX_BACKUP_REF_BYTES: usize = 4096;
const MAX_ERROR_BYTES: usize = 16 * 1024;
const MAX_JOURNAL_ROWS: i64 = 64;

const ACTIVE_STAGES: [&str; 2] = ["planned", "materializing"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiMigrationJournalRecord {
    pub migration_id: String,
    pub session_id: String,
    pub source_engine: String,
    pub target_engine: String,
    pub source_digest: String,
    pub converter_version: String,
    pub stage: String,
    pub validation_report: Value,
    pub plan: Value,
    pub backup_requested: bool,
    pub backup_ref: Option<String>,
    pub target_native_session_id: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginPiMigrationRequest {
    pub session_id: String,
    pub source_digest: String,
    pub converter_version: String,
    pub validation_report: Value,
    pub plan: Value,
    pub backup: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailPiMigrationRequest {
    pub migration_id: String,
    pub session_id: String,
    pub error: String,
}

fn required_text(value: &str, field: &str, limit: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.len() > limit {
        return Err(format!("{field} exceeds the {limit}-byte limit"));
    }
    Ok(())
}

fn optional_text(value: Option<&str>, field: &str, limit: usize) -> Result<(), String> {
    if let Some(value) = value {
        required_text(value, field, limit)?;
    }
    Ok(())
}

fn bounded_json(value: &Value, field: &str, limit: usize) -> Result<String, String> {
    let serialized = serde_json::to_string(value).map_err(|error| error.to_string())?;
    if serialized.len() > limit {
        return Err(format!(
            "{field} exceeds the {} MiB limit",
            limit / (1024 * 1024)
        ));
    }
    Ok(serialized)
}

fn plan_string<'a>(plan: &'a Value, field: &str) -> Result<&'a str, String> {
    plan.as_object()
        .and_then(|object| object.get(field))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("session.import.plan.{field} must be a non-empty string"))
}

fn validate_begin_request(request: &BeginPiMigrationRequest) -> Result<(String, String), String> {
    required_text(&request.session_id, "sessionId", MAX_MIGRATION_ID_BYTES)?;
    required_text(
        &request.source_digest,
        "sourceDigest",
        MAX_SOURCE_DIGEST_BYTES,
    )?;
    required_text(
        &request.converter_version,
        "converterVersion",
        MAX_CONVERTER_VERSION_BYTES,
    )?;
    let validation_report = bounded_json(
        &request.validation_report,
        "validationReport",
        MAX_VALIDATION_REPORT_BYTES,
    )?;
    let plan_json = bounded_json(&request.plan, "plan", MAX_PLAN_BYTES)?;
    if !request.validation_report.is_object() {
        return Err("validationReport must be an object".to_string());
    }
    if !request.plan.is_object() {
        return Err("plan must be an object".to_string());
    }
    if plan_string(&request.plan, "sourceSessionId")? != request.session_id {
        return Err("plan.sourceSessionId must match sessionId".to_string());
    }
    if plan_string(&request.plan, "sourceEngine")? != "melody-acp"
        || plan_string(&request.plan, "targetEngine")? != "pi"
        || plan_string(&request.plan, "targetFormat")? != "pi-coding-agent-v3"
    {
        return Err("plan must describe a melody-acp to pi-coding-agent-v3 migration".to_string());
    }
    if plan_string(&request.plan, "sourceDigest")? != request.source_digest {
        return Err("plan.sourceDigest must match sourceDigest".to_string());
    }
    if plan_string(&request.plan, "converterVersion")? != request.converter_version {
        return Err("plan.converterVersion must match converterVersion".to_string());
    }
    if plan_string(&request.plan, "readiness")? == "blocked" {
        return Err("plan is blocked by unresolved migration issues".to_string());
    }
    let records = request
        .plan
        .get("records")
        .and_then(Value::as_array)
        .ok_or_else(|| "plan.records must be an array".to_string())?;
    if records.len() > 4096 {
        return Err("plan.records exceeds the 4096-entry limit".to_string());
    }
    Ok((validation_report, plan_json))
}

fn row_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PiMigrationJournalRecord> {
    let validation_report_json: String = row.get(7)?;
    let plan_json: String = row.get(8)?;
    let validation_report =
        serde_json::from_str(&validation_report_json).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let plan = serde_json::from_str(&plan_json).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let backup_requested: i64 = row.get(9)?;
    Ok(PiMigrationJournalRecord {
        migration_id: row.get(0)?,
        session_id: row.get(1)?,
        source_engine: row.get(2)?,
        target_engine: row.get(3)?,
        source_digest: row.get(4)?,
        converter_version: row.get(5)?,
        stage: row.get(6)?,
        validation_report,
        plan,
        backup_requested: backup_requested != 0,
        backup_ref: row.get(10)?,
        target_native_session_id: row.get(11)?,
        error: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

const JOURNAL_SELECT: &str = "SELECT migration_id, session_id, source_engine, target_engine,
    source_digest, converter_version, stage, validation_report, plan_json,
    backup_requested, backup_ref, target_native_session_id, error, created_at, updated_at
    FROM migration_journal";

#[cfg(test)]
fn read_journal_by_id(
    connection: &Connection,
    migration_id: &str,
) -> Result<Option<PiMigrationJournalRecord>, String> {
    connection
        .query_row(
            &format!("{JOURNAL_SELECT} WHERE migration_id = ?1"),
            [migration_id],
            row_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_journal_by_id_tx(
    transaction: &Transaction<'_>,
    migration_id: &str,
) -> Result<Option<PiMigrationJournalRecord>, String> {
    transaction
        .query_row(
            &format!("{JOURNAL_SELECT} WHERE migration_id = ?1"),
            [migration_id],
            row_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn active_migration_for_session(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<Option<(String, String, String)>, String> {
    transaction
        .query_row(
            "SELECT migration_id, source_digest, converter_version
             FROM migration_journal
             WHERE session_id = ?1 AND stage IN ('planned', 'materializing')
             ORDER BY updated_at DESC LIMIT 1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())
}

/// Start or resume one conversion attempt. The same source digest and
/// converter are idempotent while active or after success; failed attempts
/// receive a fresh migration ID so a late event from the old worker cannot
/// complete a newer attempt.
#[tauri::command]
pub fn begin_pi_migration(
    database: State<'_, AppDatabase>,
    request: BeginPiMigrationRequest,
) -> Result<PiMigrationJournalRecord, String> {
    begin_pi_migration_inner(database.inner(), request)
}

fn begin_pi_migration_inner(
    database: &AppDatabase,
    request: BeginPiMigrationRequest,
) -> Result<PiMigrationJournalRecord, String> {
    let (validation_report, plan_json) = validate_begin_request(&request)?;
    let backup_requested = request.backup.unwrap_or(true);
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
            [&request.session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !session_exists {
        return Err(format!(
            "Cannot migrate unknown session {}",
            request.session_id
        ));
    }

    let same_attempt: Option<(String, String, String, i64)> = transaction
        .query_row(
            "SELECT migration_id, stage, plan_json, backup_requested FROM migration_journal
             WHERE session_id = ?1 AND source_digest = ?2 AND converter_version = ?3
             ORDER BY updated_at DESC LIMIT 1",
            params![
                request.session_id,
                request.source_digest,
                request.converter_version
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some((migration_id, stage, stored_plan_json, stored_backup_requested)) = same_attempt {
        if stage == "applied" || ACTIVE_STAGES.contains(&stage.as_str()) {
            if request
                .backup
                .is_some_and(|backup| backup != (stored_backup_requested != 0))
            {
                return Err(
                    "Migration retry backup choice does not match the existing journal entry"
                        .to_string(),
                );
            }
            let stored_plan: Value = serde_json::from_str(&stored_plan_json)
                .map_err(|_| "Stored migration plan is invalid".to_string())?;
            if stored_plan != request.plan {
                return Err(
                    "Migration retry plan does not match the existing journal entry".to_string(),
                );
            }
            if stage != "applied" {
                let now = current_timestamp(&transaction)?;
                transaction
                    .execute(
                        "UPDATE migration_journal
                         SET stage = 'materializing', error = NULL, updated_at = ?2
                         WHERE migration_id = ?1",
                        params![migration_id, now],
                    )
                    .map_err(|error| error.to_string())?;
            }
            let record = read_journal_by_id_tx(&transaction, &migration_id)?
                .ok_or_else(|| "Migration journal row disappeared".to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
            debug_assert_eq!(
                record.backup_requested,
                stored_backup_requested != 0,
                "a retry must preserve the original backup choice"
            );
            return Ok(record);
        }
    }

    if let Some(engine) = transaction
        .query_row(
            "SELECT engine FROM agent_session_bindings WHERE session_id = ?1",
            [&request.session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        && engine == "pi"
    {
        return Err("Session is already bound to Pi; no ACP migration is needed".to_string());
    }

    if let Some((migration_id, source_digest, converter_version)) =
        active_migration_for_session(&transaction, &request.session_id)?
    {
        return Err(format!(
            "Session already has an active migration {migration_id} ({source_digest}/{converter_version})"
        ));
    }

    let migration_id = Uuid::new_v4().to_string();
    let now = current_timestamp(&transaction)?;
    transaction
        .execute(
            "INSERT INTO migration_journal
                (migration_id, session_id, source_engine, target_engine, source_digest,
                 converter_version, stage, validation_report, plan_json, backup_requested,
                 created_at, updated_at)
             VALUES (?1, ?2, 'melody-acp', 'pi', ?3, ?4, 'materializing', ?5, ?6, ?7, ?8, ?8)",
            params![
                migration_id,
                request.session_id,
                request.source_digest,
                request.converter_version,
                validation_report,
                plan_json,
                backup_requested,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    let record = read_journal_by_id_tx(&transaction, &migration_id)?
        .ok_or_else(|| "Migration journal row was not created".to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(record)
}

#[tauri::command]
pub fn list_pi_migration_journal(
    database: State<'_, AppDatabase>,
    session_id: String,
) -> Result<Vec<PiMigrationJournalRecord>, String> {
    required_text(&session_id, "sessionId", MAX_MIGRATION_ID_BYTES)?;
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare(&format!(
            "{JOURNAL_SELECT} WHERE session_id = ?1 ORDER BY updated_at DESC LIMIT {MAX_JOURNAL_ROWS}"
        ))
        .map_err(|error| error.to_string())?;
    statement
        .query_map([session_id], row_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn fail_pi_migration(
    database: State<'_, AppDatabase>,
    request: FailPiMigrationRequest,
) -> Result<PiMigrationJournalRecord, String> {
    required_text(&request.migration_id, "migrationId", MAX_MIGRATION_ID_BYTES)?;
    required_text(&request.session_id, "sessionId", MAX_MIGRATION_ID_BYTES)?;
    required_text(&request.error, "error", MAX_ERROR_BYTES)?;
    let mut connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let current = read_journal_by_id_tx(&transaction, &request.migration_id)?
        .ok_or_else(|| "Migration journal entry does not exist".to_string())?;
    if current.session_id != request.session_id {
        return Err("Migration journal sessionId does not match".to_string());
    }
    if current.stage != "applied" {
        let now = current_timestamp(&transaction)?;
        transaction
            .execute(
                "UPDATE migration_journal SET stage = 'failed', error = ?2, updated_at = ?3
                 WHERE migration_id = ?1 AND session_id = ?4",
                params![request.migration_id, request.error, now, request.session_id],
            )
            .map_err(|error| error.to_string())?;
    }
    let record = read_journal_by_id_tx(&transaction, &request.migration_id)?
        .ok_or_else(|| "Migration journal entry disappeared".to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(record)
}

/// Validate the journal identity before a `session.import` command reaches
/// the worker. The stored plan is compared structurally, not as raw JSON, so
/// harmless key-order differences cannot bypass the source fingerprint.
pub(crate) fn validate_pi_migration_import(
    connection: &Connection,
    migration_id: &str,
    session_id: &str,
    plan: &Value,
    requested_backup: bool,
) -> Result<(), String> {
    required_text(migration_id, "migrationId", MAX_MIGRATION_ID_BYTES)?;
    required_text(session_id, "sessionId", MAX_MIGRATION_ID_BYTES)?;
    bounded_json(plan, "session.import.plan", MAX_PLAN_BYTES)?;
    let Some((stored_session_id, stage, stored_plan_json, stored_backup_requested)): Option<(
        String,
        String,
        String,
        i64,
    )> = connection
        .query_row(
            "SELECT session_id, stage, plan_json, backup_requested
                 FROM migration_journal WHERE migration_id = ?1",
            [migration_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
    else {
        return Err(format!(
            "Migration journal entry {migration_id} does not exist"
        ));
    };
    if stored_session_id != session_id {
        return Err("migrationId does not belong to sessionId".to_string());
    }
    if !ACTIVE_STAGES.contains(&stage.as_str()) {
        return Err(format!("Migration journal is not active (stage: {stage})"));
    }
    let stored_plan: Value = serde_json::from_str(&stored_plan_json)
        .map_err(|_| "Stored migration plan is invalid".to_string())?;
    if stored_plan != *plan {
        return Err("session.import.plan does not match the journaled plan".to_string());
    }
    if requested_backup != (stored_backup_requested != 0) {
        return Err("session.import.backup does not match the journaled backup choice".to_string());
    }
    Ok(())
}

/// Complete the journal in the same SQLite transaction that records the
/// authoritative `session.imported` event and switches the engine binding.
pub(crate) fn complete_pi_migration_tx(
    transaction: &Transaction<'_>,
    migration_id: &str,
    session_id: &str,
    target_native_session_id: &str,
    backup_ref: Option<&str>,
) -> Result<(), String> {
    required_text(migration_id, "migrationId", MAX_MIGRATION_ID_BYTES)?;
    required_text(session_id, "sessionId", MAX_MIGRATION_ID_BYTES)?;
    required_text(
        target_native_session_id,
        "targetNativeSessionId",
        MAX_MIGRATION_ID_BYTES,
    )?;
    optional_text(backup_ref, "backupRef", MAX_BACKUP_REF_BYTES)?;
    let stage: Option<String> = transaction
        .query_row(
            "SELECT stage FROM migration_journal WHERE migration_id = ?1 AND session_id = ?2",
            params![migration_id, session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(stage) = stage else {
        return Err(format!(
            "Migration journal entry {migration_id} does not exist"
        ));
    };
    if stage == "applied" {
        let (stored_native, stored_backup): (Option<String>, Option<String>) = transaction
            .query_row(
                "SELECT target_native_session_id, backup_ref
                 FROM migration_journal WHERE migration_id = ?1 AND session_id = ?2",
                params![migration_id, session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| error.to_string())?;
        if stored_native.as_deref() != Some(target_native_session_id) {
            return Err(
                "Migration journal is already applied to a different native session".to_string(),
            );
        }
        if stored_backup.as_deref() != backup_ref {
            return Err("Migration journal backup reference does not match".to_string());
        }
        return Ok(());
    }
    if !ACTIVE_STAGES.contains(&stage.as_str()) {
        return Err(format!(
            "Migration journal cannot be completed from stage {stage}"
        ));
    }
    let now = current_timestamp(transaction)?;
    transaction
        .execute(
            "UPDATE migration_journal
             SET stage = 'applied', target_native_session_id = ?3,
                 backup_ref = ?4, error = NULL, updated_at = ?5
             WHERE migration_id = ?1 AND session_id = ?2",
            params![
                migration_id,
                session_id,
                target_native_session_id,
                backup_ref,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn migration_id_from_event(event: &Value) -> Option<&str> {
    event
        .get("migrationId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

pub(crate) fn backup_ref_from_event(event: &Value) -> Option<&str> {
    event
        .get("backupPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

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

    fn request(digest: &str) -> BeginPiMigrationRequest {
        serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "sourceDigest": digest,
            "converterVersion": "pi-import-v1",
            "validationReport": {"classification": "lossless-candidate"},
            "plan": {
                "planVersion": 1,
                "converterVersion": "pi-import-v1",
                "targetFormat": "pi-coding-agent-v3",
                "sourceSessionId": "s1",
                "sourceEngine": "melody-acp",
                "targetEngine": "pi",
                "sourceDigest": digest,
                "readiness": "native-ready",
                "records": []
            },
            "backup": true
        }))
        .unwrap()
    }

    #[test]
    fn begins_idempotently_and_completes_in_a_transaction() {
        let database = database_with_session();
        let first = begin_pi_migration_inner(&database, request("digest-1")).unwrap();
        let second = begin_pi_migration_inner(&database, request("digest-1")).unwrap();
        assert_eq!(first.migration_id, second.migration_id);
        assert_eq!(second.stage, "materializing");

        let mut connection = database.connection.lock().unwrap();
        let transaction = connection.transaction().unwrap();
        complete_pi_migration_tx(
            &transaction,
            &first.migration_id,
            "s1",
            "native-1",
            Some("/tmp/backup"),
        )
        .unwrap();
        transaction.commit().unwrap();
        let completed = read_journal_by_id(&connection, &first.migration_id)
            .unwrap()
            .unwrap();
        assert_eq!(completed.stage, "applied");
        assert_eq!(
            completed.target_native_session_id.as_deref(),
            Some("native-1")
        );
        assert_eq!(completed.backup_ref.as_deref(), Some("/tmp/backup"));
    }

    #[test]
    fn failed_attempt_gets_a_fresh_id_and_late_completion_is_rejected() {
        let database = database_with_session();
        let first = begin_pi_migration_inner(&database, request("digest-1")).unwrap();
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "UPDATE migration_journal SET stage = 'failed', error = 'boom' WHERE migration_id = ?1",
                params![first.migration_id],
            )
            .unwrap();
        drop(connection);
        let second = begin_pi_migration_inner(&database, request("digest-1")).unwrap();
        assert_ne!(first.migration_id, second.migration_id);
        let mut connection = database.connection.lock().unwrap();
        let transaction = connection.transaction().unwrap();
        let error =
            complete_pi_migration_tx(&transaction, &first.migration_id, "s1", "native", None)
                .unwrap_err();
        assert!(error.contains("does not exist") || error.contains("stage"));
        transaction.rollback().unwrap();
    }

    #[test]
    fn active_retry_cannot_replace_the_journaled_plan() {
        let database = database_with_session();
        let first = begin_pi_migration_inner(&database, request("digest-1")).unwrap();
        let mut changed = request("digest-1");
        changed.plan["records"] = serde_json::json!([{
            "sourceId": "entry-1",
            "classification": "custom-entry"
        }]);
        let error = begin_pi_migration_inner(&database, changed).unwrap_err();
        assert!(error.contains("does not match"));
        let stored = {
            let connection = database.connection.lock().unwrap();
            read_journal_by_id(&connection, &first.migration_id)
                .unwrap()
                .unwrap()
        };
        assert_eq!(stored.plan["records"], serde_json::json!([]));
    }

    #[test]
    fn import_validation_preserves_the_journaled_backup_choice() {
        let database = database_with_session();
        let mut migration_request = request("digest-1");
        migration_request.backup = Some(false);
        let migration = begin_pi_migration_inner(&database, migration_request).unwrap();
        let connection = database.connection.lock().unwrap();
        validate_pi_migration_import(
            &connection,
            &migration.migration_id,
            "s1",
            &migration.plan,
            false,
        )
        .unwrap();
        let error = validate_pi_migration_import(
            &connection,
            &migration.migration_id,
            "s1",
            &migration.plan,
            true,
        )
        .unwrap_err();
        assert!(error.contains("backup choice"));
    }

    #[test]
    fn active_retry_cannot_replace_the_journaled_backup_choice() {
        let database = database_with_session();
        let mut first_request = request("digest-1");
        first_request.backup = Some(false);
        let first = begin_pi_migration_inner(&database, first_request).unwrap();
        let mut changed = request("digest-1");
        changed.backup = Some(true);
        let error = begin_pi_migration_inner(&database, changed).unwrap_err();
        assert!(error.contains("backup choice"));
        let stored = {
            let connection = database.connection.lock().unwrap();
            read_journal_by_id(&connection, &first.migration_id)
                .unwrap()
                .unwrap()
        };
        assert!(!stored.backup_requested);
    }

    #[test]
    fn applied_journal_rejects_a_different_native_session_or_backup() {
        let database = database_with_session();
        let migration = begin_pi_migration_inner(&database, request("digest-1")).unwrap();
        let mut connection = database.connection.lock().unwrap();
        let transaction = connection.transaction().unwrap();
        complete_pi_migration_tx(
            &transaction,
            &migration.migration_id,
            "s1",
            "native-1",
            Some("/tmp/backup"),
        )
        .unwrap();
        transaction.commit().unwrap();

        let transaction = connection.transaction().unwrap();
        let native_error = complete_pi_migration_tx(
            &transaction,
            &migration.migration_id,
            "s1",
            "native-2",
            Some("/tmp/backup"),
        )
        .unwrap_err();
        assert!(native_error.contains("different native session"));
        transaction.rollback().unwrap();

        let transaction = connection.transaction().unwrap();
        let backup_error = complete_pi_migration_tx(
            &transaction,
            &migration.migration_id,
            "s1",
            "native-1",
            Some("/tmp/other-backup"),
        )
        .unwrap_err();
        assert!(backup_error.contains("backup reference"));
        transaction.rollback().unwrap();
    }
}
