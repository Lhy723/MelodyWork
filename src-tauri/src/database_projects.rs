use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::pi_storage::remove_pi_session_artifacts;
use crate::pi_worker_runtime::PiWorkerRuntime;
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
pub async fn delete_project(
    app: AppHandle,
    database: State<'_, AppDatabase>,
    runtime: State<'_, PiWorkerRuntime>,
    id: String,
) -> Result<(), String> {
    if id == INDEPENDENT_PROJECT_ID {
        return Err("独立任务不能删除。".to_string());
    }

    // Native Pi JSONL is outside SQLite, so collect and remove the exact
    // opaque artifacts before deleting rows. If cleanup cannot be completed,
    // keep the database intact and let the caller retry instead of silently
    // leaving an active native history behind.
    let session_workspaces = {
        let connection = database
            .connection
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                [&id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            return Err("项目不存在。".to_string());
        }
        let mut statement = connection
            .prepare(
                "SELECT s.id, s.cwd, b.engine
             FROM sessions AS s
             LEFT JOIN agent_session_bindings AS b ON b.session_id = s.id
             WHERE s.project_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        statement
            .query_map([&id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    for (session_id, cwd, engine) in session_workspaces {
        // An ACP-only session has no native Pi resources and must not
        // interrupt a Pi worker serving another session in the same project.
        if engine.as_deref() == Some("pi") {
            runtime
                .inner()
                .stop_if_workspace(&app, Path::new(&cwd))
                .await?;
        }
        remove_pi_session_artifacts(&cwd, &session_id)?;
    }

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
        .execute(
            "DELETE FROM agent_session_bindings
             WHERE session_id IN (
                 SELECT id FROM sessions WHERE project_id = ?1
             )",
            [id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM agent_event_log
             WHERE session_id IN (
                 SELECT id FROM sessions WHERE project_id = ?1
             )",
            [id],
        )
        .map_err(|error| error.to_string())?;
    // Do not rely solely on the session foreign-key cascade: old databases
    // may have had foreign keys disabled when a project was removed.
    transaction
        .execute(
            "DELETE FROM migration_journal
             WHERE session_id IN (
                 SELECT id FROM sessions WHERE project_id = ?1
             )",
            [id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM pi_session_forks
             WHERE source_session_id IN (
                 SELECT id FROM sessions WHERE project_id = ?1
             ) OR branch_session_id IN (
                 SELECT id FROM sessions WHERE project_id = ?1
             )",
            [id],
        )
        .map_err(|error| error.to_string())?;
    // Host-owned schedules belong to a session in this project; a timer that
    // survived the project would keep firing into a removed conversation.
    transaction
        .execute(
            "DELETE FROM agent_schedule_runs
             WHERE schedule_id IN (
                 SELECT schedule_id FROM agent_schedules
                  WHERE session_id IN (
                      SELECT id FROM sessions WHERE project_id = ?1
                  )
             )",
            [id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM agent_schedules
             WHERE session_id IN (
                 SELECT id FROM sessions WHERE project_id = ?1
             )",
            [id],
        )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::database_agent_schedules::{
        CreateAgentScheduleRequest, ensure_agent_schedule_schema, insert_schedule, read_schedule,
        record_schedule_run,
    };
    use crate::database::database_core::{initialize_schema, migrate_schema};

    #[test]
    fn deleting_a_project_purges_schedules_and_explorer_lineage() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        migrate_schema(&connection).unwrap();
        ensure_agent_schedule_schema(&connection).unwrap();
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, path, last_opened_at, archived)
                    VALUES ('p1', 'Demo', '/tmp/demo', 1, 0);
                 INSERT INTO sessions (id, project_id, title, cwd, timeline_json, created_at, updated_at)
                    VALUES ('s1', 'p1', 'Test', '/tmp/demo', '[]', 1, 1),
                           ('s2', 'p1', 'Branch', '/tmp/demo', '[]', 1, 1);
                 INSERT INTO pi_session_forks
                    (branch_session_id, source_session_id, anchor_native_entry_id,
                     request_id, status, created_at, updated_at)
                    VALUES ('s2', 's1', 'anchor-1', 'request-1', 'pending', 1, 1);",
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

        delete_project_record(&mut connection, "p1").unwrap();

        assert!(read_schedule(&connection, "schedule-1").unwrap().is_none());
        let runs: i64 = connection
            .query_row("SELECT COUNT(*) FROM agent_schedule_runs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            runs, 0,
            "a removed project leaves no schedule journal behind"
        );
        let forks: i64 = connection
            .query_row("SELECT COUNT(*) FROM pi_session_forks", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            forks, 0,
            "a removed project leaves no Explorer lineage behind"
        );
    }
}
