#[path = "database_agent_bindings.rs"]
mod database_agent_bindings;
#[path = "database_agent_events.rs"]
mod database_agent_events;
#[path = "database_agent_forks.rs"]
mod database_agent_forks;
#[path = "database_agent_migrations.rs"]
mod database_agent_migrations;
#[path = "database_agent_recovery.rs"]
mod database_agent_recovery;
#[path = "database_agent_schedules.rs"]
mod database_agent_schedules;
#[path = "database_core.rs"]
mod database_core;
#[path = "database_permissions.rs"]
mod database_permissions;
#[path = "database_projects.rs"]
mod database_projects;
#[path = "database_sessions.rs"]
mod database_sessions;
#[path = "database_statistics.rs"]
mod database_statistics;

pub use database_agent_bindings::*;
pub use database_agent_events::*;
pub use database_agent_forks::*;
pub use database_agent_migrations::*;
pub use database_agent_recovery::*;
pub use database_agent_schedules::*;
pub use database_core::*;
pub use database_permissions::*;
pub use database_projects::*;
pub use database_sessions::*;
pub use database_statistics::*;

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::database_core::*;
    use super::database_projects::*;
    use super::database_statistics::*;
    use super::*;

    #[test]
    fn project_and_session_records_round_trip() {
        let database = AppDatabase::in_memory();
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO projects VALUES ('p1', 'Demo', '/tmp/demo', 1, 0)",
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
    fn deleting_a_project_removes_its_local_records() {
        let database = AppDatabase::in_memory();
        let mut connection = database.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO projects VALUES ('p1', 'Demo', '/tmp/demo', 1, 0)",
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
        connection
            .execute(
                "INSERT INTO session_timeline_entries
                 (session_id, ordinal, entry_json, updated_at)
                 VALUES ('s1', 0, '{}', 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO permission_rules VALUES
                 ('r1', 'p1', 'Shell\npnpm check', 'Shell', 'pnpm check', 'allow', 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_session_bindings
                 (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                 VALUES ('s1', 'pi', 'native-1', 'epoch-1', 4, 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO migration_journal
                 (migration_id, session_id, source_engine, target_engine, source_digest,
                  converter_version, stage, validation_report, plan_json, backup_requested,
                  created_at, updated_at)
                 VALUES ('migration-1', 's1', 'melody-acp', 'pi', 'digest-1', 'pi-import-v1',
                         'failed', '{}', '{}', 1, 1, 1)",
                [],
            )
            .unwrap();

        delete_project_record(&mut connection, "p1").unwrap();

        for table in [
            "projects",
            "sessions",
            "session_timeline_entries",
            "permission_rules",
            "agent_session_bindings",
            "agent_event_log",
            "migration_journal",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} should be empty");
        }
    }

    #[test]
    fn migrates_legacy_session_schema_and_records_version() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "
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
        let project_columns = project_columns(&connection).unwrap();
        assert!(project_columns.contains("archived"));
        let binding_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'agent_session_bindings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(binding_count, 1);
        let event_log_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'agent_event_log'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_log_count, 1);
        let migration_journal_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'migration_journal'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_journal_count, 1);
        let binding_columns: std::collections::HashSet<String> = connection
            .prepare("PRAGMA table_info(agent_session_bindings)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(binding_columns.contains("session_mode_id"));
        assert!(binding_columns.contains("permission_mode"));
        assert!(binding_columns.contains("model_id"));
        assert!(binding_columns.contains("reasoning_effort"));
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
    fn upgrades_a_partially_created_binding_table_without_losing_its_cursor() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL UNIQUE,
                    last_opened_at INTEGER NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0
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
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE agent_session_bindings (
                    session_id TEXT PRIMARY KEY,
                    engine TEXT NOT NULL,
                    native_session_id TEXT,
                    worker_epoch TEXT,
                    last_seq INTEGER,
                    updated_at INTEGER NOT NULL
                );
                INSERT INTO projects VALUES ('p1', 'Demo', '/tmp/demo', 1, 0);
                INSERT INTO sessions VALUES
                    ('s1', 'p1', 'Test', '/tmp/demo', NULL, '[]', NULL, 0, 1, 1);
                INSERT INTO agent_session_bindings
                    (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                    VALUES ('s1', 'pi', 'native-1', 'epoch-1', 7, 9);
                PRAGMA user_version = 8;
                ",
            )
            .unwrap();

        migrate_schema(&connection).unwrap();

        let binding: (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
        ) = connection
            .query_row(
                "SELECT engine, native_session_id, worker_epoch, session_mode_id, last_seq
                 FROM agent_session_bindings WHERE session_id = 's1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(binding.0, "pi");
        assert_eq!(binding.1.as_deref(), Some("native-1"));
        assert_eq!(binding.2.as_deref(), Some("epoch-1"));
        assert_eq!(binding.3, None);
        assert_eq!(binding.4, Some(7));

        let columns: std::collections::HashSet<String> = connection
            .prepare("PRAGMA table_info(agent_session_bindings)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for column in [
            "session_mode_id",
            "permission_mode",
            "model_id",
            "reasoning_effort",
        ] {
            assert!(columns.contains(column), "missing {column}");
        }
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
    fn upgrades_a_v10_database_with_the_schedule_tables() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL UNIQUE,
                    last_opened_at INTEGER NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0
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
                    updated_at INTEGER NOT NULL
                );
                INSERT INTO projects VALUES ('p1', 'Demo', '/tmp/demo', 1, 0);
                INSERT INTO sessions VALUES
                    ('s1', 'p1', 'Test', '/tmp/demo', NULL, '[]', NULL, 0, 1, 1);
                PRAGMA user_version = 10;
                ",
            )
            .unwrap();

        migrate_schema(&connection).unwrap();

        // The upgrade adds both schedule tables and advances the version.
        for table in ["agent_schedules", "agent_schedule_runs"] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "{table} must exist after the upgrade");
        }
        assert_eq!(
            schema_version(&connection).unwrap(),
            DATABASE_SCHEMA_VERSION
        );

        // Existing session data survives, and the new table is usable.
        let sessions: i64 = connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sessions, 1);
        let request = crate::database::database_agent_schedules::CreateAgentScheduleRequest {
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
        };
        crate::database::database_agent_schedules::insert_schedule(&connection, &request)
            .expect("the migrated database accepts a schedule");
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
