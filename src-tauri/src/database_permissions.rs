use rusqlite::{OptionalExtension, params};
use tauri::State;
use uuid::Uuid;

use super::database_core::{
    AppDatabase, PermissionRule, current_timestamp, permission_rule_from_row,
};

/// Resolve the persisted decision for a session-scoped tool. Keeping this
/// lookup in the database module prevents the Pi worker from choosing a
/// project or permission rule based on renderer-provided metadata.
pub(crate) fn permission_decision_for_session(
    database: &AppDatabase,
    session_id: &str,
    tool_key: &str,
) -> Result<Option<String>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    connection
        .query_row(
            "SELECT permission_rules.decision
             FROM sessions
             JOIN permission_rules ON permission_rules.project_id = sessions.project_id
             WHERE sessions.id = ?1 AND permission_rules.tool_key = ?2",
            params![session_id, tool_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_permission_rules(
    database: State<'_, AppDatabase>,
    project_id: String,
) -> Result<Vec<PermissionRule>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, tool_key, title, command, decision, created_at
             FROM permission_rules
             WHERE project_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    statement
        .query_map([project_id], permission_rule_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn find_permission_rule(
    database: State<'_, AppDatabase>,
    project_id: String,
    tool_key: String,
) -> Result<Option<PermissionRule>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    connection
        .query_row(
            "SELECT id, project_id, tool_key, title, command, decision, created_at
             FROM permission_rules
             WHERE project_id = ?1 AND tool_key = ?2",
            params![project_id, tool_key],
            permission_rule_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn upsert_permission_rule(
    database: State<'_, AppDatabase>,
    project_id: String,
    tool_key: String,
    title: String,
    command: String,
    decision: String,
) -> Result<PermissionRule, String> {
    if !matches!(decision.as_str(), "allow" | "deny") {
        return Err("Permission decision must be allow or deny".to_string());
    }
    if tool_key.trim().is_empty() {
        return Err("Permission rule key cannot be empty".to_string());
    }
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let now = current_timestamp(&connection)?;
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO permission_rules
                (id, project_id, tool_key, title, command, decision, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(project_id, tool_key) DO UPDATE SET
                title = excluded.title,
                command = excluded.command,
                decision = excluded.decision,
                created_at = excluded.created_at",
            params![id, project_id, tool_key, title, command, decision, now],
        )
        .map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT id, project_id, tool_key, title, command, decision, created_at
             FROM permission_rules
             WHERE project_id = ?1 AND tool_key = ?2",
            params![project_id, tool_key],
            permission_rule_from_row,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_permission_rule(
    database: State<'_, AppDatabase>,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    connection
        .execute(
            "DELETE FROM permission_rules WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}
