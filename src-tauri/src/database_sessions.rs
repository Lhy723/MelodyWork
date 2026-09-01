use std::path::Path;

use rusqlite::params;
use tauri::State;
use uuid::Uuid;

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
pub fn delete_session(database: State<'_, AppDatabase>, id: String) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let deleted = connection
        .execute("DELETE FROM sessions WHERE id = ?1", [&id])
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("Session does not exist".to_string());
    }
    Ok(())
}
