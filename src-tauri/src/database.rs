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

        delete_project_record(&mut connection, "p1").unwrap();

        for table in [
            "projects",
            "sessions",
            "session_timeline_entries",
            "permission_rules",
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
