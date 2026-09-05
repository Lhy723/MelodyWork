use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use tauri::State;
use uuid::Uuid;

use crate::workspace_access::WorkspaceRegistry;

use super::database_core::{
    AppDatabase, INDEPENDENT_PROJECT_ID, ProjectRecord, current_timestamp, project_from_row,
    project_name,
};

#[tauri::command]
pub fn list_projects(
    database: State<'_, AppDatabase>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<Vec<ProjectRecord>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, path, last_opened_at, archived
             FROM projects
             ORDER BY last_opened_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let projects = statement
        .query_map([], project_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    // A project saved by an older build may point at a deleted directory or
    // at the filesystem root. Do not let one stale record prevent the user
    // from opening the native picker and recovering the workspace list.
    Ok(projects
        .into_iter()
        .filter(|project| registry.register(Path::new(&project.path)).is_ok())
        .collect())
}

#[tauri::command]
pub fn upsert_project(
    database: State<'_, AppDatabase>,
    registry: State<'_, WorkspaceRegistry>,
    path: String,
) -> Result<ProjectRecord, String> {
    let path = registry.authorize(&path)?;
    let path_string = path.to_string_lossy().into_owned();
    let name = project_name(&path);
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let now = current_timestamp(&connection)?;
    let existing_id: Option<String> = connection
        .query_row(
            "SELECT id FROM projects WHERE path = ?1",
            [&path_string],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    connection
        .execute(
            "INSERT INTO projects (id, name, path, last_opened_at, archived)
             VALUES (?1, ?2, ?3, ?4, 0)
             ON CONFLICT(path) DO UPDATE SET
                name = excluded.name,
                last_opened_at = excluded.last_opened_at,
                archived = 0",
            params![id, name, path_string, now],
        )
        .map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT id, name, path, last_opened_at, archived FROM projects WHERE path = ?1",
            [&path_string],
            project_from_row,
        )
        .map_err(|error| error.to_string())
}

fn set_project_archived(
    database: &AppDatabase,
    id: &str,
    archived: bool,
) -> Result<ProjectRecord, String> {
    if id == INDEPENDENT_PROJECT_ID {
        return Err("独立任务不能归档或恢复。".to_string());
    }
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let archived_value = if archived { 1 } else { 0 };
    let changed = connection
        .execute(
            "UPDATE projects SET archived = ?1 WHERE id = ?2",
            params![archived_value, id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("项目不存在。".to_string());
    }
    connection
        .query_row(
            "SELECT id, name, path, last_opened_at, archived
             FROM projects
             WHERE id = ?1",
            [id],
            project_from_row,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn archive_project(
    database: State<'_, AppDatabase>,
    id: String,
) -> Result<ProjectRecord, String> {
    set_project_archived(&database, &id, true)
}

#[tauri::command]
pub fn restore_project(
    database: State<'_, AppDatabase>,
    id: String,
) -> Result<ProjectRecord, String> {
    set_project_archived(&database, &id, false)
}

#[tauri::command]
pub fn delete_project(database: State<'_, AppDatabase>, id: String) -> Result<(), String> {
    let mut connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    delete_project_record(&mut connection, &id)
}

pub(crate) fn delete_project_record(connection: &mut Connection, id: &str) -> Result<(), String> {
    if id == INDEPENDENT_PROJECT_ID {
        return Err("独立任务不能删除。".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    // Delete children explicitly so projects created by older schemas are
    // removable even when their foreign-key cascade was not preserved.
    transaction
        .execute(
            "DELETE FROM session_timeline_entries
             WHERE session_id IN (
                 SELECT id FROM sessions WHERE project_id = ?1
             )",
            [id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM permission_rules WHERE project_id = ?1", [id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM sessions WHERE project_id = ?1", [id])
        .map_err(|error| error.to_string())?;
    let deleted = transaction
        .execute("DELETE FROM projects WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("项目不存在。".to_string());
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}
