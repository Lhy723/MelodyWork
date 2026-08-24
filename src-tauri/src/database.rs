use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::Path,
    sync::Mutex,
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::workspace_access::{WorkspaceRegistry, confirm_action};

const DATABASE_SCHEMA_VERSION: i64 = 4;
const MAX_TIMELINE_JSON_BYTES: usize = 2 * 1024 * 1024;

fn validate_timeline_json(value: &str) -> Result<(), String> {
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

fn validate_timeline_archive_entry(entry: &TimelineArchiveEntry) -> Result<(), String> {
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

fn schema_version(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row("PRAGMA user_version", [], |row| row.get(0))
}

fn session_columns(connection: &Connection) -> rusqlite::Result<HashSet<String>> {
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

fn migrate_schema(connection: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let version = schema_version(connection)?;
    if version > DATABASE_SCHEMA_VERSION {
        return Err(Box::new(UnsupportedDatabaseSchemaVersion {
            found: version,
            supported: DATABASE_SCHEMA_VERSION,
        }));
    }

    // v2 added the ACP replay cursor; v3 added the projection version; v4
    // added the unbounded timeline archive. The column/table checks also
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

    connection.pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)?;
    Ok(())
}

fn initialize_schema(connection: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    connection.execute_batch(
        "
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
    migrate_schema(connection)
}

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsActivityDay {
    day_start_ms: i64,
    tokens: u64,
    tasks: u64,
    input_tokens: u64,
    output_tokens: u64,
    cached_read_tokens: u64,
    reasoning_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct StatisticsCount {
    name: String,
    count: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatistics {
    total_tokens: u64,
    peak_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cached_read_tokens: u64,
    reasoning_tokens: u64,
    model_calls: u64,
    api_duration_ms: u64,
    usage_incomplete_tasks: u64,
    cost_usd_ticks: Option<u64>,
    longest_task_ms: u64,
    current_streak_days: u64,
    longest_streak_days: u64,
    total_tasks: u64,
    quick_mode_tasks: u64,
    activity: Vec<StatisticsActivityDay>,
    reasoning_efforts: Vec<StatisticsCount>,
    plugins: Vec<StatisticsCount>,
    used_skills: u64,
}

fn number_field(value: &serde_json::Value, name: &str) -> Option<u64> {
    value.get(name)?.as_u64()
}

fn timestamp_field(value: &serde_json::Value, name: &str) -> Option<i64> {
    value.get(name)?.as_i64()
}

fn count_rows(values: HashMap<String, u64>, limit: usize) -> Vec<StatisticsCount> {
    let mut rows = values
        .into_iter()
        .map(|(name, count)| StatisticsCount { name, count })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });
    rows.truncate(limit);
    rows
}

fn day_start_ms(timestamp_ms: i64) -> i64 {
    timestamp_ms.div_euclid(86_400_000) * 86_400_000
}

fn normalized_tool_name(entry: &serde_json::Value) -> String {
    let title = entry
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("工具调用")
        .trim();
    let lower = title.to_ascii_lowercase();
    let operation = entry
        .pointer("/activity/operation")
        .and_then(serde_json::Value::as_str);

    if lower.starts_with("list ")
        || lower.starts_with("listing ")
        || lower.starts_with("listed ")
        || lower.starts_with("listdir")
        || title.starts_with("列出")
        || title.starts_with("已列出")
        || title.contains("目录列表")
    {
        return "List".to_string();
    }
    if lower.starts_with("read ")
        || lower.starts_with("reading ")
        || lower.starts_with("read file")
        || title.starts_with("读取")
        || title.starts_with("已读取")
    {
        return "Read".to_string();
    }
    if lower.starts_with("search ")
        || lower.starts_with("searching ")
        || lower.starts_with("searched ")
        || lower.starts_with("grep ")
        || lower.starts_with("find ")
        || title.starts_with("搜索")
        || title.starts_with("已搜索")
        || (title.starts_with("已在") && title.contains("搜索"))
    {
        return "Search".to_string();
    }
    if lower.starts_with("create ")
        || lower.starts_with("created ")
        || lower.starts_with("creating ")
        || title.starts_with("创建")
        || title.starts_with("已创建")
    {
        return "Create".to_string();
    }
    if lower.starts_with("edit ")
        || lower.starts_with("edited ")
        || lower.starts_with("editing ")
        || lower.starts_with("patch ")
        || title.starts_with("编辑")
        || title.starts_with("已编辑")
    {
        return "Edit".to_string();
    }
    if lower.starts_with("delete ")
        || lower.starts_with("deleted ")
        || lower.starts_with("remove ")
        || title.starts_with("删除")
        || title.starts_with("已删除")
    {
        return "Delete".to_string();
    }
    if lower.starts_with("execute ")
        || lower.starts_with("executing ")
        || lower.starts_with("run ")
        || lower.starts_with("running ")
        || title.starts_with("执行")
        || title.starts_with("运行")
    {
        return "Execute".to_string();
    }

    match operation {
        Some("read") => return "Read".to_string(),
        Some("search") => return "Search".to_string(),
        Some("create") => return "Create".to_string(),
        Some("edit") => return "Edit".to_string(),
        Some("delete") => return "Delete".to_string(),
        Some("execute") => return "Execute".to_string(),
        _ => {}
    }

    let stable = title
        .split(['{', '(', '`'])
        .next()
        .unwrap_or(title)
        .trim()
        .trim_end_matches([':', '：', '-', '—'])
        .trim();
    if stable.is_empty() {
        "工具调用".to_string()
    } else if stable.chars().count() > 48 {
        stable
            .split_whitespace()
            .next()
            .unwrap_or("工具调用")
            .to_string()
    } else {
        stable.to_string()
    }
}

#[tauri::command]
pub fn get_usage_statistics(database: State<'_, AppDatabase>) -> Result<UsageStatistics, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare("SELECT timeline_json FROM sessions")
        .map_err(|error| error.to_string())?;
    let timelines = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut total_tokens = 0_u64;
    let mut peak_tokens = 0_u64;
    let mut input_tokens = 0_u64;
    let mut output_tokens = 0_u64;
    let mut cached_read_tokens = 0_u64;
    let mut reasoning_tokens = 0_u64;
    let mut model_calls = 0_u64;
    let mut api_duration_ms = 0_u64;
    let mut usage_incomplete_tasks = 0_u64;
    let mut cost_usd_ticks = None::<u64>;
    let mut longest_task_ms = 0_u64;
    let mut total_tasks = 0_u64;
    let mut quick_mode_tasks = 0_u64;
    let mut activity = BTreeMap::<i64, (u64, u64, u64, u64, u64, u64)>::new();
    let mut reasoning = HashMap::<String, u64>::new();
    let mut plugins = HashMap::<String, u64>::new();
    let mut skills = HashSet::<String>::new();

    for timeline_json in timelines {
        let entries =
            serde_json::from_str::<Vec<serde_json::Value>>(&timeline_json).unwrap_or_default();
        let mut turn_started_at = None::<i64>;
        let mut turn_last_activity_at = None::<i64>;

        for entry in &entries {
            let kind = entry.get("kind").and_then(serde_json::Value::as_str);
            let role = entry.get("role").and_then(serde_json::Value::as_str);
            let started_at = timestamp_field(entry, "startedAt");
            let completed_at = timestamp_field(entry, "completedAt").or(started_at);

            if kind == Some("message") && role == Some("user") {
                if let (Some(start), Some(end)) = (turn_started_at, turn_last_activity_at) {
                    longest_task_ms = longest_task_ms.max(end.saturating_sub(start) as u64);
                }
                turn_started_at = started_at;
                turn_last_activity_at = completed_at;
                total_tasks += 1;
                if let Some(day) = started_at.map(day_start_ms) {
                    activity.entry(day).or_default().1 += 1;
                }
                continue;
            }

            if turn_started_at.is_some() {
                turn_last_activity_at = completed_at.or(turn_last_activity_at);
            }

            if kind == Some("message") && role == Some("assistant") {
                if let Some(usage) = entry.get("tokenUsage") {
                    if let Some(used) = number_field(usage, "usedTokens") {
                        peak_tokens = peak_tokens.max(used);
                    }
                }
                if let Some(usage) = entry.get("billingUsage") {
                    let turn_input = number_field(usage, "inputTokens").unwrap_or(0);
                    let turn_output = number_field(usage, "outputTokens").unwrap_or(0);
                    let turn_cached = number_field(usage, "cachedReadTokens")
                        .unwrap_or(0)
                        .min(turn_input);
                    let turn_reasoning = number_field(usage, "reasoningTokens")
                        .unwrap_or(0)
                        .min(turn_output);
                    let turn_total = turn_input.saturating_add(turn_output);
                    total_tokens = total_tokens.saturating_add(turn_total);
                    input_tokens = input_tokens.saturating_add(turn_input);
                    output_tokens = output_tokens.saturating_add(turn_output);
                    cached_read_tokens = cached_read_tokens.saturating_add(turn_cached);
                    reasoning_tokens = reasoning_tokens.saturating_add(turn_reasoning);
                    model_calls =
                        model_calls.saturating_add(number_field(usage, "modelCalls").unwrap_or(0));
                    api_duration_ms = api_duration_ms
                        .saturating_add(number_field(usage, "apiDurationMs").unwrap_or(0));
                    if usage
                        .get("usageIsIncomplete")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                    {
                        usage_incomplete_tasks += 1;
                    }
                    if let Some(turn_cost) = number_field(usage, "costUsdTicks") {
                        cost_usd_ticks =
                            Some(cost_usd_ticks.unwrap_or(0).saturating_add(turn_cost));
                    }
                    if let Some(day) = completed_at.map(day_start_ms) {
                        let row = activity.entry(day).or_default();
                        row.0 = row.0.saturating_add(turn_total);
                        row.2 = row.2.saturating_add(turn_input);
                        row.3 = row.3.saturating_add(turn_output);
                        row.4 = row.4.saturating_add(turn_cached);
                        row.5 = row.5.saturating_add(turn_reasoning);
                    }
                }
                if let Some(effort) = entry
                    .get("reasoningEffort")
                    .and_then(serde_json::Value::as_str)
                {
                    *reasoning.entry(effort.to_string()).or_default() += 1;
                }
                if entry
                    .get("sessionModeId")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|mode| {
                        let mode = mode.to_ascii_lowercase();
                        mode.contains("quick") || mode.contains("fast")
                    })
                {
                    quick_mode_tasks += 1;
                }
            }

            if kind == Some("tool") {
                let original_title = entry
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("工具调用")
                    .trim();
                let name = normalized_tool_name(entry);
                if !name.is_empty() {
                    *plugins.entry(name).or_default() += 1;
                    let lower = original_title.to_ascii_lowercase();
                    if lower.contains("skill") || original_title.contains("技能") {
                        skills.insert(original_title.to_string());
                    }
                }
            }
        }

        if let (Some(start), Some(end)) = (turn_started_at, turn_last_activity_at) {
            longest_task_ms = longest_task_ms.max(end.saturating_sub(start) as u64);
        }
    }

    let active_days = activity
        .iter()
        .filter_map(|(day, (_, tasks, _, _, _, _))| (*tasks > 0).then_some(*day / 86_400_000))
        .collect::<Vec<_>>();
    let mut longest_streak_days = 0_u64;
    let mut streak = 0_u64;
    let mut previous_day = None::<i64>;
    for day in &active_days {
        streak = if previous_day.is_some_and(|previous| *day == previous + 1) {
            streak + 1
        } else {
            1
        };
        longest_streak_days = longest_streak_days.max(streak);
        previous_day = Some(*day);
    }
    let today = current_timestamp(&connection)? / 86_400;
    let current_streak_days = active_days
        .last()
        .filter(|last| **last == today || **last == today - 1)
        .map(|_| streak)
        .unwrap_or(0);

    Ok(UsageStatistics {
        total_tokens,
        peak_tokens,
        input_tokens,
        output_tokens,
        cached_read_tokens,
        reasoning_tokens,
        model_calls,
        api_duration_ms,
        usage_incomplete_tasks,
        cost_usd_ticks,
        longest_task_ms,
        current_streak_days,
        longest_streak_days,
        total_tasks,
        quick_mode_tasks,
        activity: activity
            .into_iter()
            .map(
                |(
                    day_start_ms,
                    (
                        tokens,
                        tasks,
                        input_tokens,
                        output_tokens,
                        cached_read_tokens,
                        reasoning_tokens,
                    ),
                )| StatisticsActivityDay {
                    day_start_ms,
                    tokens,
                    tasks,
                    input_tokens,
                    output_tokens,
                    cached_read_tokens,
                    reasoning_tokens,
                },
            )
            .collect(),
        reasoning_efforts: count_rows(reasoning, 8),
        plugins: count_rows(plugins, 5),
        used_skills: skills.len() as u64,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionRequest {
    id: String,
    title: Option<String>,
    acp_session_id: Option<String>,
    timeline_json: Option<String>,
    timeline_entries: Option<Vec<TimelineArchiveEntry>>,
    acp_cursor: Option<Option<String>>,
    timeline_version: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineArchiveEntry {
    ordinal: i64,
    entry_json: String,
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
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        initialize_schema(&connection)?;
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
    fn in_memory() -> Self {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("foreign keys");
        initialize_schema(&connection).expect("schema");
        Self {
            connection: Mutex::new(connection),
        }
    }
}

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
            "SELECT id, name, path, last_opened_at
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
    app: AppHandle,
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
    if decision == "allow" {
        confirm_action(
            &app,
            "确认保存永久权限",
            format!(
                "允许 MelodyWork 在此项目中永久放行以下工具吗？\n{}\n{}",
                title.trim(),
                command.trim()
            ),
        )
        .await?;
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

    #[test]
    fn migrates_legacy_session_schema_and_records_version() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    acp_session_id TEXT,
                    timeline_json TEXT NOT NULL DEFAULT '[]',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                PRAGMA user_version = 1;
                ",
            )
            .unwrap();

        migrate_schema(&connection).unwrap();

        let columns = session_columns(&connection).unwrap();
        assert!(columns.contains("acp_cursor"));
        assert!(columns.contains("timeline_version"));
        assert_eq!(
            schema_version(&connection).unwrap(),
            DATABASE_SCHEMA_VERSION
        );

        // A retry after a process interruption must be harmless.
        migrate_schema(&connection).unwrap();
        assert_eq!(
            schema_version(&connection).unwrap(),
            DATABASE_SCHEMA_VERSION
        );
    }

    #[test]
    fn rejects_a_database_created_by_a_newer_build() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION + 1)
            .unwrap();

        let error = migrate_schema(&connection).expect_err("future schema must be rejected");
        assert!(
            error
                .to_string()
                .contains("newer than the supported version")
        );
    }

    #[test]
    fn tool_statistics_merge_titles_with_different_arguments() {
        let cases = [
            (
                serde_json::json!({
                    "title": "Read src/main.rs",
                    "activity": {"operation": "read", "path": "src/main.rs"}
                }),
                "Read",
            ),
            (
                serde_json::json!({
                    "title": "已读取 src/lib.rs",
                    "activity": {"operation": "read", "path": "src/lib.rs"}
                }),
                "Read",
            ),
            (
                serde_json::json!({
                    "title": "List /tmp/project",
                    "activity": {"operation": "read", "path": "/tmp/project"}
                }),
                "List",
            ),
            (
                serde_json::json!({
                    "title": "List src/components",
                    "activity": {"operation": "read", "path": "src/components"}
                }),
                "List",
            ),
            (
                serde_json::json!({
                    "title": "linear__list_issues({\"team\":\"app\"})",
                    "activity": {"operation": "other"}
                }),
                "linear__list_issues",
            ),
        ];

        for (entry, expected) in cases {
            assert_eq!(normalized_tool_name(&entry), expected);
        }
    }
}
