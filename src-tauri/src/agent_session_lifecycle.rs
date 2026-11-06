use std::path::Path;

use rusqlite::OptionalExtension;
use tauri::{AppHandle, State};

use crate::{
    database::{
        AppDatabase, INDEPENDENT_PROJECT_ID, delete_project_record, purge_session_agent_rows,
    },
    pi_storage::remove_pi_session_artifacts,
    pi_worker_runtime::PiWorkerRuntime,
};

/// Delete a product session only after stopping its Pi worker and removing the
/// exact opaque Pi artifacts associated with that session.
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

/// Delete a project after stopping each bound Pi worker and removing each
/// session's app-owned Pi history. ACP-only sessions do not stop a Pi worker.
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
