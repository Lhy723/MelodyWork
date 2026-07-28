use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Debug)]
pub struct AppDatabase {
    connection: Mutex<Connection>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    id: String,
    name: String,
    path: String,
    last_opened_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    id: String,
    project_id: String,
    title: String,
    cwd: String,
    acp_session_id: Option<String>,
    timeline_json: String,
    acp_cursor: Option<String>,
    timeline_version: i64,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    id: String,
    project_id: String,
    tool_key: String,
    title: String,
    command: String,
    decision: String,
    created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionRequest {
    id: String,
    title: Option<String>,
    acp_session_id: Option<String>,
    timeline_json: Option<String>,
    acp_cursor: Option<Option<String>>,
    timeline_version: Option<i64>,
}

fn current_timestamp(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("SELECT unixepoch()", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn project_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Workspace")
        .to_string()
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRecord> {
    Ok(ProjectRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        last_opened_at: row.get(3)?,
    })
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        cwd: row.get(3)?,
        acp_session_id: row.get(4)?,
        timeline_json: row.get(5)?,
        acp_cursor: row.get(6)?,
        timeline_version: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn permission_rule_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PermissionRule> {
    Ok(PermissionRule {
        id: row.get(0)?,
        project_id: row.get(1)?,
        tool_key: row.get(2)?,
        title: row.get(3)?,
        command: row.get(4)?,
        decision: row.get(5)?,
        created_at: row.get(6)?,
    })
}

impl AppDatabase {
    pub fn open(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let app_data_dir = app.path().app_data_dir()?;
        fs::create_dir_all(&app_data_dir)?;
        let connection = Connection::open(app_data_dir.join("melody-work.sqlite3"))?;
        connection.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                last_opened_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                cwd TEXT NOT NULL,
                acp_session_id TEXT,
                timeline_json TEXT NOT NULL DEFAULT '[]',
                acp_cursor TEXT,
                timeline_version INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS sessions_project_updated
                ON sessions(project_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS permission_rules (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                tool_key TEXT NOT NULL,
                title TEXT NOT NULL,
                command TEXT NOT NULL,
                decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny')),
                created_at INTEGER NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
                UNIQUE(project_id, tool_key)
            );
            CREATE INDEX IF NOT EXISTS permission_rules_project
                ON permission_rules(project_id, created_at DESC);
            ",
        )?;
        let session_columns = connection
            .prepare("PRAGMA table_info(sessions)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !session_columns.iter().any(|column| column == "acp_cursor") {
            connection.execute("ALTER TABLE sessions ADD COLUMN acp_cursor TEXT", [])?;
        }
        if !session_columns
            .iter()
            .any(|column| column == "timeline_version")
        {
            connection.execute(
                "ALTER TABLE sessions ADD COLUMN timeline_version INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "
                PRAGMA foreign_keys = ON;
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL UNIQUE,
                    last_opened_at INTEGER NOT NULL
                );
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    acp_session_id TEXT,
                    timeline_json TEXT NOT NULL DEFAULT '[]',
                    acp_cursor TEXT,
                    timeline_version INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                CREATE TABLE permission_rules (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    tool_key TEXT NOT NULL,
                    title TEXT NOT NULL,
                    command TEXT NOT NULL,
                    decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny')),
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
                    UNIQUE(project_id, tool_key)
                );
                ",
            )
            .expect("schema");
        Self {
            connection: Mutex::new(connection),
        }
    }
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(format!(
            "Workspace directory does not exist: {}",
            path.display()
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("Failed to resolve workspace directory: {error}"))
}

#[tauri::command]
pub fn list_projects(database: State<'_, AppDatabase>) -> Result<Vec<ProjectRecord>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, path, last_opened_at
             FROM projects
             ORDER BY last_opened_at DESC",
        )
        .map_err(|error| error.to_string())?;
    statement
        .query_map([], project_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn upsert_project(
    database: State<'_, AppDatabase>,
    path: String,
) -> Result<ProjectRecord, String> {
    let path = canonical_directory(&path)?;
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
            "INSERT INTO projects (id, name, path, last_opened_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET
                name = excluded.name,
                last_opened_at = excluded.last_opened_at",
            params![id, name, path_string, now],
        )
        .map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT id, name, path, last_opened_at FROM projects WHERE path = ?1",
            [&path_string],
            project_from_row,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_sessions(
    database: State<'_, AppDatabase>,
    project_id: String,
) -> Result<Vec<SessionRecord>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
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
    project_id: String,
    cwd: String,
) -> Result<SessionRecord, String> {
    let cwd = canonical_directory(&cwd)?.to_string_lossy().into_owned();
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
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
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let now = current_timestamp(&connection)?;
    connection
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
pub fn upsert_permission_rule(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_and_session_records_round_trip() {
        let database = AppDatabase::in_memory();
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO projects VALUES ('p1', 'Demo', '/tmp/demo', 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sessions VALUES
                 ('s1', 'p1', 'Test session', '/tmp/demo', NULL, '[]', NULL, 0, 1, 1)",
                [],
            )
            .unwrap();
        let title: String = connection
            .query_row("SELECT title FROM sessions WHERE id = 's1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Test session");
        assert_eq!(
            connection
                .execute("DELETE FROM sessions WHERE id = 's1'", [])
                .unwrap(),
            1
        );
        let session_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(session_count, 0);

        connection
            .execute(
                "INSERT INTO permission_rules VALUES
                 ('r1', 'p1', 'Shell\npnpm check', 'Shell', 'pnpm check', 'allow', 1)",
                [],
            )
            .unwrap();
        let decision: String = connection
            .query_row(
                "SELECT decision FROM permission_rules WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(decision, "allow");
    }
}
