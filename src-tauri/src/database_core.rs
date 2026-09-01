use std::{collections::HashSet, fs, path::Path, sync::Mutex, time::Duration};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub(crate) const DATABASE_SCHEMA_VERSION: i64 = 5;
pub(crate) const MAX_TIMELINE_JSON_BYTES: usize = 2 * 1024 * 1024;
pub const INDEPENDENT_PROJECT_ID: &str = "__melody_independent__";
pub(crate) const INDEPENDENT_PROJECT_DIRECTORY: &str = "independent-chat";

pub(crate) fn validate_timeline_json(value: &str) -> Result<(), String> {
    if value.len() > MAX_TIMELINE_JSON_BYTES {
        return Err(format!(
            "Timeline snapshot exceeds the {} MiB limit",
            MAX_TIMELINE_JSON_BYTES / (1024 * 1024)
        ));
    }
    let parsed = serde_json::from_str::<serde_json::Value>(value)
        .map_err(|_| "Timeline snapshot is not valid JSON".to_string())?;
    if !parsed.is_array() {
        return Err("Timeline snapshot must be a JSON array".to_string());
    }
    Ok(())
}

pub(crate) fn validate_timeline_archive_entry(entry: &TimelineArchiveEntry) -> Result<(), String> {
    if entry.ordinal < 0 {
        return Err("Timeline archive ordinal must be non-negative".to_string());
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&entry.entry_json)
        .map_err(|_| "Timeline archive entry is not valid JSON".to_string())?;
    if !parsed.is_object() {
        return Err("Timeline archive entry must be a JSON object".to_string());
    }
    Ok(())
}

#[derive(Debug)]
struct UnsupportedDatabaseSchemaVersion {
    found: i64,
    supported: i64,
}

impl std::fmt::Display for UnsupportedDatabaseSchemaVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Database schema version {} is newer than the supported version {}",
            self.found, self.supported
        )
    }
}

impl std::error::Error for UnsupportedDatabaseSchemaVersion {}

pub(crate) fn schema_version(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row("PRAGMA user_version", [], |row| row.get(0))
}

pub(crate) fn session_columns(connection: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut statement = connection.prepare("PRAGMA table_info(sessions)")?;
    statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect()
}

fn ensure_session_column(
    connection: &Connection,
    columns: &mut HashSet<String>,
    name: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    if columns.insert(name.to_string()) {
        connection.execute(
            &format!("ALTER TABLE sessions ADD COLUMN {name} {definition}"),
            [],
        )?;
    }
    Ok(())
}

pub(crate) fn project_columns(connection: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut statement = connection.prepare("PRAGMA table_info(projects)")?;
    statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect()
}

fn ensure_project_column(
    connection: &Connection,
    columns: &mut HashSet<String>,
    name: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    if columns.insert(name.to_string()) {
        connection.execute(
            &format!("ALTER TABLE projects ADD COLUMN {name} {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn ensure_timeline_archive_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS session_timeline_entries (
            session_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            entry_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(session_id, ordinal),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS session_timeline_entries_order
            ON session_timeline_entries(session_id, ordinal);
        ",
    )
}

fn backfill_timeline_archive(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("SELECT id, timeline_json, updated_at FROM sessions")?;
    let sessions = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    for (session_id, timeline_json, updated_at) in sessions {
        let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(&timeline_json) else {
            continue;
        };
        for (ordinal, entry) in entries.into_iter().enumerate() {
            let entry_json =
                serde_json::to_string(&entry).map_err(|_| rusqlite::Error::InvalidQuery)?;
            connection.execute(
                "INSERT OR IGNORE INTO session_timeline_entries
                    (session_id, ordinal, entry_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![session_id, ordinal as i64, entry_json, updated_at],
            )?;
        }
    }
    Ok(())
}

pub(crate) fn migrate_schema(connection: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let version = schema_version(connection)?;
    if version > DATABASE_SCHEMA_VERSION {
        return Err(Box::new(UnsupportedDatabaseSchemaVersion {
            found: version,
            supported: DATABASE_SCHEMA_VERSION,
        }));
    }

    // v2 added the ACP replay cursor; v3 added the projection version; v4
    // added the unbounded timeline archive; v5 added project archiving. The column/table checks also
    // repair an interrupted/partially migrated database whose user_version
    // was not advanced before the process exited.
    let mut columns = session_columns(connection)?;
    if version < 2 || !columns.contains("acp_cursor") {
        ensure_session_column(connection, &mut columns, "acp_cursor", "TEXT")?;
    }
    if version < 3 || !columns.contains("timeline_version") {
        ensure_session_column(
            connection,
            &mut columns,
            "timeline_version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    ensure_timeline_archive_schema(connection)?;
    if version < 4 {
        backfill_timeline_archive(connection)?;
    }
    let mut project_columns = project_columns(connection)?;
    if !project_columns.is_empty() && (version < 5 || !project_columns.contains("archived")) {
        ensure_project_column(
            connection,
            &mut project_columns,
            "archived",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
    }

    connection.pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)?;
    Ok(())
}

pub(crate) fn initialize_schema(connection: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            last_opened_at INTEGER NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0
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
    migrate_schema(connection)
}

#[derive(Debug)]
pub struct AppDatabase {
    pub(crate) connection: Mutex<Connection>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) last_opened_at: i64,
    pub(crate) archived: bool,
    pub(crate) is_independent: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) title: String,
    pub(crate) cwd: String,
    pub(crate) acp_session_id: Option<String>,
    pub(crate) timeline_json: String,
    pub(crate) acp_cursor: Option<String>,
    pub(crate) timeline_version: i64,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) tool_key: String,
    pub(crate) title: String,
    pub(crate) command: String,
    pub(crate) decision: String,
    pub(crate) created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionRequest {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
    pub(crate) acp_session_id: Option<String>,
    pub(crate) timeline_json: Option<String>,
    pub(crate) timeline_entries: Option<Vec<TimelineArchiveEntry>>,
    pub(crate) acp_cursor: Option<Option<String>>,
    pub(crate) timeline_version: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineArchiveEntry {
    pub(crate) ordinal: i64,
    pub(crate) entry_json: String,
}

pub(crate) fn current_timestamp(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("SELECT unixepoch()", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

pub(crate) fn project_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Workspace")
        .to_string()
}

pub(crate) fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRecord> {
    let id: String = row.get(0)?;
    Ok(ProjectRecord {
        is_independent: id == INDEPENDENT_PROJECT_ID,
        id,
        name: row.get(1)?,
        path: row.get(2)?,
        last_opened_at: row.get(3)?,
        archived: row.get(4)?,
    })
}

pub(crate) fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
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

pub(crate) fn permission_rule_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<PermissionRule> {
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
        let independent_directory = app_data_dir.join(INDEPENDENT_PROJECT_DIRECTORY);
        fs::create_dir_all(&independent_directory)?;
        let independent_path = independent_directory.canonicalize()?;
        let connection = Connection::open(app_data_dir.join("melody-work.sqlite3"))?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        initialize_schema(&connection)?;
        let independent_path = independent_path.to_string_lossy().into_owned();
        connection.execute(
            "INSERT OR IGNORE INTO projects (id, name, path, last_opened_at)
             VALUES (?1, ?2, ?3, 0)",
            params![INDEPENDENT_PROJECT_ID, "任务", independent_path],
        )?;
        connection.execute(
            "UPDATE projects SET name = ?1, path = ?2, archived = 0 WHERE id = ?3",
            params!["任务", independent_path, INDEPENDENT_PROJECT_ID],
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Enforce a stored allow rule in Rust, keyed by the ACP session's
    /// project and the exact normalized tool title/command pair.
    pub fn has_allow_permission_for_acp_session(
        &self,
        acp_session_id: &str,
        title: &str,
        command: &str,
    ) -> Result<bool, String> {
        let tool_key = format!("{}\n{}", title.trim(), command.trim());
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        let allowed = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM permission_rules AS rules
                    JOIN sessions ON sessions.project_id = rules.project_id
                    WHERE sessions.acp_session_id = ?1
                      AND rules.tool_key = ?2
                      AND rules.decision = 'allow'
                )",
                params![acp_session_id, tool_key],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(allowed != 0)
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .busy_timeout(Duration::from_secs(5))
            .expect("busy timeout");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("foreign keys");
        initialize_schema(&connection).expect("schema");
        Self {
            connection: Mutex::new(connection),
        }
    }
}
