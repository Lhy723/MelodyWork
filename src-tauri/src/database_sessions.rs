use std::path::Path;

use rusqlite::{OptionalExtension, params};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::pi_storage::remove_pi_session_artifacts;
use crate::pi_worker_runtime::PiWorkerRuntime;
use crate::workspace_access::WorkspaceRegistry;

use super::database_core::{
    AppDatabase, SessionRecord, UpdateSessionRequest, current_timestamp, session_from_row,
    validate_timeline_archive_entry, validate_timeline_json,
};

#[tauri::command]
pub fn list_sessions(
    database: State<'_, AppDatabase>,
    registry: State<'_, WorkspaceRegistry>,
    project_id: String,
) -> Result<Vec<SessionRecord>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let project_path: String = connection
        .query_row(
            "SELECT path FROM projects WHERE id = ?1",
            [&project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    registry.register(Path::new(&project_path))?;
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, title, cwd, acp_session_id, timeline_json,
                    acp_cursor, timeline_version,
                    created_at, updated_at
             FROM sessions
             WHERE project_id = ?1
             ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    statement
        .query_map([project_id], session_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_session(
    database: State<'_, AppDatabase>,
    registry: State<'_, WorkspaceRegistry>,
    project_id: String,
    cwd: String,
) -> Result<SessionRecord, String> {
    let project_path: String;
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    project_path = connection
        .query_row(
            "SELECT path FROM projects WHERE id = ?1",
            [&project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let project_root = registry.authorize(&project_path)?;
    let cwd = registry.authorize(&cwd)?;
    if !cwd.starts_with(&project_root) {
        return Err("Session directory must be inside the selected project".to_string());
    }
    let cwd = cwd.to_string_lossy().into_owned();
    let now = current_timestamp(&connection)?;
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO sessions
                (id, project_id, title, cwd, timeline_json, created_at, updated_at)
             VALUES (?1, ?2, '新会话', ?3, '[]', ?4, ?4)",
            params![id, project_id, cwd, now],
        )
        .map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT id, project_id, title, cwd, acp_session_id, timeline_json,
                    acp_cursor, timeline_version,
                    created_at, updated_at
             FROM sessions WHERE id = ?1",
            [&id],
            session_from_row,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_session(
    database: State<'_, AppDatabase>,
    request: UpdateSessionRequest,
) -> Result<SessionRecord, String> {
    if let Some(timeline_json) = request.timeline_json.as_deref() {
        validate_timeline_json(timeline_json)?;
    }
    if let Some(entries) = request.timeline_entries.as_deref() {
        for entry in entries {
            validate_timeline_archive_entry(entry)?;
        }
    }
    let mut connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let now = current_timestamp(&connection)?;
    let timeline_entries = request.timeline_entries.as_deref().unwrap_or(&[]);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let updated = transaction
        .execute(
            "UPDATE sessions SET
                title = COALESCE(?2, title),
                acp_session_id = COALESCE(?3, acp_session_id),
                timeline_json = COALESCE(?4, timeline_json),
                acp_cursor = CASE WHEN ?5 THEN ?6 ELSE acp_cursor END,
                timeline_version = COALESCE(?7, timeline_version),
                updated_at = ?8
             WHERE id = ?1",
            params![
                request.id,
                request.title,
                request.acp_session_id,
                request.timeline_json,
                request.acp_cursor.is_some(),
                request.acp_cursor.flatten(),
                request.timeline_version,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("Session does not exist".to_string());
    }
    for entry in timeline_entries {
        transaction
            .execute(
                "INSERT INTO session_timeline_entries
                    (session_id, ordinal, entry_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_id, ordinal) DO UPDATE SET
                    entry_json = excluded.entry_json,
                    updated_at = excluded.updated_at",
                params![request.id, entry.ordinal, entry.entry_json, now],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT id, project_id, title, cwd, acp_session_id, timeline_json,
                    acp_cursor, timeline_version,
                    created_at, updated_at
             FROM sessions WHERE id = ?1",
            [&request.id],
            session_from_row,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_session_timeline(
    database: State<'_, AppDatabase>,
    id: String,
) -> Result<Option<String>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT ordinal, entry_json
             FROM session_timeline_entries
             WHERE session_id = ?1
             ORDER BY ordinal ASC",
        )
        .map_err(|error| error.to_string())?;
    let entries = statement
        .query_map([id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if entries.is_empty() {
        return Ok(None);
    }
    let mut values = Vec::with_capacity(entries.len());
    for (expected_ordinal, (ordinal, entry)) in entries.into_iter().enumerate() {
        if ordinal != expected_ordinal as i64 {
            return Err("Timeline archive has a missing ordinal".to_string());
        }
        let value =
            serde_json::from_str::<serde_json::Value>(&entry).map_err(|error| error.to_string())?;
        if !value.is_object() {
            return Err("Timeline archive entry must be a JSON object".to_string());
        }
        values.push(value);
    }
    serde_json::to_string(&values)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_session(
    app: AppHandle,
    database: State<'_, AppDatabase>,
    runtime: State<'_, PiWorkerRuntime>,
    id: String,
) -> Result<(), String> {
    let (cwd, engine) = {
        let connection = database
            .connection
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        connection
            .query_row(
                "SELECT s.cwd, b.engine
                 FROM sessions AS s
                 LEFT JOIN agent_session_bindings AS b ON b.session_id = s.id
                 WHERE s.id = ?1",
                [&id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Session does not exist".to_string())?
    };
    if engine.as_deref() == Some("pi") {
        runtime
            .inner()
            .stop_if_workspace(&app, Path::new(&cwd))
            .await?;
    }
    // Keep SQLite rows and the app-owned Pi JSONL lifecycle aligned. The
    // helper only touches the opaque file and its import/crash leftovers for
    // this exact product session; it never follows a symlink target.
    remove_pi_session_artifacts(&cwd, &id)?;

    let mut connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    purge_session_agent_rows(&transaction, &id)?;
    let deleted = transaction
        .execute("DELETE FROM sessions WHERE id = ?1", [&id])
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("Session does not exist".to_string());
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

/// Remove every Host-owned row that belongs to one product session.
///
/// Cleanup is explicit rather than left to the foreign-key cascade because
/// databases created before foreign-key enforcement was enabled still exist in
/// the wild, and none of these rows may outlive the session they describe: an
/// engine binding carries native IDs, the event log is the session's replay
/// source, the migration journal holds source plans, and a schedule is a timer
/// that would otherwise keep firing into a deleted conversation.
pub(crate) fn purge_session_agent_rows(
    transaction: &rusqlite::Transaction<'_>,
    id: &str,
) -> Result<(), String> {
    for statement in [
        "DELETE FROM session_timeline_entries WHERE session_id = ?1",
        "DELETE FROM pi_session_forks
          WHERE branch_session_id = ?1 OR source_session_id = ?1",
        "DELETE FROM agent_session_bindings WHERE session_id = ?1",
        "DELETE FROM agent_event_log WHERE session_id = ?1",
        "DELETE FROM migration_journal WHERE session_id = ?1",
        "DELETE FROM agent_schedule_runs
          WHERE schedule_id IN (
              SELECT schedule_id FROM agent_schedules WHERE session_id = ?1
          )",
        "DELETE FROM agent_schedules WHERE session_id = ?1",
    ] {
        transaction
            .execute(statement, [id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::database_agent_schedules::{
        CreateAgentScheduleRequest, ensure_agent_schedule_schema, insert_schedule,
        list_schedule_runs, read_schedule, record_schedule_run,
    };
    use crate::database::database_core::{initialize_schema, migrate_schema};
    use rusqlite::Connection;

    #[test]
    fn deleting_a_session_purges_its_schedules_and_run_journal() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        migrate_schema(&connection).unwrap();
        ensure_agent_schedule_schema(&connection).unwrap();
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, path, last_opened_at, archived)
                    VALUES ('p1', 'Demo', '/tmp/demo', 1, 0);
                 INSERT INTO sessions (id, project_id, title, cwd, timeline_json, created_at, updated_at)
                    VALUES ('s1', 'p1', 'Test', '/tmp/demo', '[]', 1, 1);",
            )
            .unwrap();
        insert_schedule(
            &connection,
            &CreateAgentScheduleRequest {
                schedule_id: "schedule-1".to_string(),
                session_id: "s1".to_string(),
                project_id: "p1".to_string(),
                kind: "interval".to_string(),
                interval_ms: Some(60_000),
                run_at: None,
                cron: None,
                prompt: "Summarize".to_string(),
                missed_policy: Some("skip".to_string()),
                max_runs: None,
                expires_at: None,
                permission_mode: "ask".to_string(),
                session_mode_id: "default".to_string(),
                model_id: None,
                reasoning_effort: None,
                now: 1_000_000,
            },
        )
        .unwrap();
        record_schedule_run(&connection, "schedule-1", "fired", None, None, 1_060_000).unwrap();

        let transaction = connection.transaction().unwrap();
        purge_session_agent_rows(&transaction, "s1").unwrap();
        transaction
            .execute("DELETE FROM sessions WHERE id = 's1'", [])
            .unwrap();
        transaction.commit().unwrap();

        assert!(read_schedule(&connection, "schedule-1").unwrap().is_none());
        assert!(
            list_schedule_runs(&connection, "schedule-1")
                .unwrap()
                .is_empty()
        );
        let schedules: i64 = connection
            .query_row("SELECT COUNT(*) FROM agent_schedules", [], |row| row.get(0))
            .unwrap();
        assert_eq!(schedules, 0);
    }
}
