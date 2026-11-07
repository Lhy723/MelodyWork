//! Renderer-facing access to Host-owned background terminal tasks.
//!
//! The registry itself lives in `pi_tool_gateway::terminal_tasks` and stays
//! private to the gateway. These commands only expose the tasks that belong to
//! one product session, resolving the workspace from SQLite instead of trusting
//! a renderer-supplied path.

use std::path::PathBuf;

use rusqlite::OptionalExtension;
use serde_json::Value;
use tauri::State;

use crate::database::AppDatabase;

/// Resolve the owning workspace of a product session.
///
/// The renderer may pass any session id; this lookup is what makes the id
/// meaningful. It returns under the same "unknown session" wording the Pi
/// command preflight uses.
fn session_workspace(database: &AppDatabase, session_id: &str) -> Result<PathBuf, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("sessionId must not be empty".to_string());
    }
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let cwd = connection
        .query_row(
            "SELECT cwd FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Cannot operate on unknown session {session_id}"))?;
    Ok(PathBuf::from(cwd))
}

/// List the background terminal tasks owned by one product session.
///
/// Entries carry `task_id`, `command`, and `status` only. Captured output stays
/// with the model-facing `get_command_or_subagent_output` tool: polling the full
/// bounded output of up to 64 tasks from the panel would dwarf the payload.
#[tauri::command]
pub async fn list_background_terminal_tasks(
    database: State<'_, AppDatabase>,
    session_id: String,
) -> Result<Vec<Value>, String> {
    let root = session_workspace(&database, &session_id)?;
    Ok(crate::pi_tool_gateway::list_background_terminal_tasks(
        &root,
        session_id.trim(),
    ))
}

/// Cancel one background terminal task owned by this session.
///
/// A task that already finished returns its terminal snapshot rather than an
/// error, so the panel can render "already ended" instead of a failure. The
/// bounded wait for the process to exit runs off the async runtime so a slow
/// child cannot stall the webview.
#[tauri::command]
pub async fn cancel_background_terminal_task(
    database: State<'_, AppDatabase>,
    session_id: String,
    task_id: String,
) -> Result<Value, String> {
    let root = session_workspace(&database, &session_id)?;
    let owner = session_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        crate::pi_tool_gateway::cancel_background_terminal_task(&root, &owner, &task_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use rusqlite::Connection;

    fn database_with_session(id: &str, cwd: &str) -> AppDatabase {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)")
            .expect("sessions table");
        connection
            .execute("INSERT INTO sessions (id, cwd) VALUES (?1, ?2)", (id, cwd))
            .expect("session row");
        AppDatabase {
            connection: Mutex::new(connection),
        }
    }

    #[test]
    fn resolves_the_workspace_stored_for_the_session() {
        let database = database_with_session("session-a", "/tmp/workspace-a");
        assert_eq!(
            session_workspace(&database, "session-a").expect("known session"),
            PathBuf::from("/tmp/workspace-a")
        );
    }

    #[test]
    fn rejects_unknown_and_blank_sessions() {
        let database = database_with_session("session-a", "/tmp/workspace-a");
        let unknown = session_workspace(&database, "session-b")
            .expect_err("an unknown session must not resolve a workspace");
        assert!(unknown.contains("unknown session session-b"));
        assert!(session_workspace(&database, "  ").is_err());
    }

    /// The panel's cancel goes through session resolution first, so this is the
    /// exact text a second session gets when it names the first session's task.
    #[test]
    fn a_second_session_cannot_cancel_the_first_sessions_task() {
        let owner_root = std::env::temp_dir().join(format!(
            "melody-bridge-own-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let intruder_root = std::env::temp_dir().join(format!(
            "melody-bridge-other-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&owner_root).expect("owner workspace");
        std::fs::create_dir_all(&intruder_root).expect("intruder workspace");

        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)")
            .expect("sessions table");
        connection
            .execute(
                "INSERT INTO sessions (id, cwd) VALUES (?1, ?2), (?3, ?4)",
                (
                    "session-owner",
                    owner_root.to_string_lossy().as_ref(),
                    "session-intruder",
                    intruder_root.to_string_lossy().as_ref(),
                ),
            )
            .expect("session rows");
        let database = AppDatabase {
            connection: Mutex::new(connection),
        };

        // Start through the same gateway a worker request takes, so the test
        // covers the model-facing start path too.
        let start = crate::pi_tool_gateway::resolve_request_with_permission(
            &owner_root,
            &serde_json::json!({
                "sessionId": "session-owner",
                "event": {
                    "type": "tool.requested",
                    "toolCallId": "call-start",
                    "toolName": "run_terminal_command",
                    "activity": {
                        "approved": true,
                        "arguments": { "command": "sleep 30", "background": true }
                    }
                }
            }),
            Some(true),
        );
        assert_eq!(start["resolution"]["status"].as_str(), Some("completed"));
        let started: Value = serde_json::from_str(
            start["resolution"]["output"]
                .as_str()
                .expect("start output is a JSON string"),
        )
        .expect("start output is JSON");
        let task_id = started["task_id"]
            .as_str()
            .expect("start result carries a task id")
            .to_string();

        // The panel resolves the caller's workspace from SQLite and then checks
        // ownership, so this is the exact sequence a second session triggers.
        let intruder_root = session_workspace(&database, "session-intruder")
            .expect("the intruder session resolves its own workspace");
        let error = crate::pi_tool_gateway::cancel_background_terminal_task(
            &intruder_root,
            "session-intruder",
            &task_id,
        )
        .expect_err("a second session must not stop this task");
        assert_eq!(
            error,
            "Background task does not belong to this session workspace"
        );

        let owner_root = session_workspace(&database, "session-owner").expect("owner workspace");
        let cancelled = crate::pi_tool_gateway::cancel_background_terminal_task(
            &owner_root,
            "session-owner",
            &task_id,
        )
        .expect("the owner may stop it");
        assert_eq!(cancelled["status"].as_str(), Some("cancelled"));

        std::fs::remove_dir_all(&owner_root).ok();
        std::fs::remove_dir_all(&intruder_root).ok();
    }
}
