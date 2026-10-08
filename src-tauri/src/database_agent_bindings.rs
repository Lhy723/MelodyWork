use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use tauri::State;

use super::database_core::{AppDatabase, current_timestamp};

const MAX_BINDING_ID_BYTES: usize = 256;
const MAX_IMPORT_PLAN_BYTES: usize = 4 * 1024 * 1024;
const MAX_IMPORT_RECORDS: usize = 4096;
const PI_SESSION_MODES: [&str; 3] = ["default", "plan", "ask"];
const PERMISSION_MODES: [&str; 3] = ["ask", "auto", "always-approve"];
const PI_REASONING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionBinding {
    pub(crate) session_id: String,
    pub(crate) engine: String,
    pub(crate) native_session_id: Option<String>,
    pub(crate) worker_epoch: Option<String>,
    pub(crate) last_seq: Option<i64>,
    pub(crate) session_mode_id: Option<String>,
    pub(crate) permission_mode: Option<String>,
    pub(crate) model_id: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAgentSessionBindingRequest {
    pub(crate) session_id: String,
    pub(crate) engine: String,
    pub(crate) native_session_id: Option<String>,
    pub(crate) worker_epoch: Option<String>,
    pub(crate) last_seq: Option<i64>,
    pub(crate) session_mode_id: Option<String>,
    pub(crate) permission_mode: Option<String>,
    pub(crate) model_id: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
}

fn required_id(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.len() > MAX_BINDING_ID_BYTES {
        return Err(format!(
            "{field} exceeds the {MAX_BINDING_ID_BYTES}-byte limit"
        ));
    }
    Ok(())
}

fn optional_id(value: Option<&str>, field: &str) -> Result<(), String> {
    if let Some(value) = value {
        required_id(value, field)?;
    }
    Ok(())
}

fn validate_request(request: &UpsertAgentSessionBindingRequest) -> Result<(), String> {
    required_id(&request.session_id, "sessionId")?;
    if request.engine != "melody-acp" && request.engine != "pi" {
        return Err("engine must be either melody-acp or pi".to_string());
    }
    optional_id(request.native_session_id.as_deref(), "nativeSessionId")?;
    optional_id(request.worker_epoch.as_deref(), "workerEpoch")?;
    if request.last_seq.is_some_and(|sequence| sequence < 0) {
        return Err("lastSeq must be a non-negative integer".to_string());
    }
    if let Some(mode) = request.session_mode_id.as_deref()
        && !PI_SESSION_MODES.contains(&mode)
    {
        return Err(format!(
            "sessionModeId must be one of {}",
            PI_SESSION_MODES.join(", ")
        ));
    }
    if let Some(mode) = request.permission_mode.as_deref()
        && !PERMISSION_MODES.contains(&mode)
    {
        return Err(format!(
            "permissionMode must be one of {}",
            PERMISSION_MODES.join(", ")
        ));
    }
    optional_id(request.model_id.as_deref(), "modelId")?;
    if let Some(level) = request.reasoning_effort.as_deref()
        && !PI_REASONING_LEVELS.contains(&level)
    {
        return Err(format!(
            "reasoningEffort must be one of {}",
            PI_REASONING_LEVELS.join(", ")
        ));
    }
    Ok(())
}

/// Check whether a Pi worker may open a product session without changing its
/// engine binding. Opening a native session is not itself a migration: an ACP
/// session must remain owned by ACP until an explicit, journaled conversion
/// switches the binding. Keep this check beside the binding schema so every
/// host entry point can share the same invariant.
pub(crate) fn validate_pi_session_open(
    connection: &Connection,
    session_id: &str,
    worker_cwd: &Path,
) -> Result<(), String> {
    required_id(session_id, "sessionId")?;
    validate_pi_session_workspace(connection, session_id, worker_cwd)?;
    let session_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !session_exists {
        return Err(format!(
            "Cannot open Pi session for unknown session {session_id}"
        ));
    }
    let existing_engine = connection
        .query_row(
            "SELECT engine FROM agent_session_bindings WHERE session_id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(engine) = existing_engine
        && engine != "pi"
    {
        return Err(format!(
            "Agent session {session_id} is already bound to {engine}; an explicit migration is required before opening Pi"
        ));
    }
    let fork_status = connection
        .query_row(
            "SELECT status FROM pi_session_forks WHERE branch_session_id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if fork_status
        .as_deref()
        .is_some_and(|status| status != "ready")
    {
        return Err(
            "Pi Explorer branch is not ready; return to the source session and resume the fork"
                .to_string(),
        );
    }
    Ok(())
}

/// Validate the explicit ACP → Pi hand-off before bytes reach the worker.
/// This is deliberately stricter than the renderer-side planner: the Host is
/// the authority for session ownership and workspace identity, while the
/// worker only materializes a plan that has passed these checks.
pub(crate) fn validate_pi_session_import(
    connection: &Connection,
    session_id: &str,
    cwd: &str,
    plan: &Value,
) -> Result<(), String> {
    required_id(session_id, "sessionId")?;
    if cwd.trim().is_empty() || cwd.len() > 4096 {
        return Err("session.import.cwd must be a bounded non-empty path".to_string());
    }
    let stored_cwd = connection
        .query_row(
            "SELECT cwd FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Cannot import unknown session {session_id}"))?;
    if stored_cwd != cwd {
        return Err(
            "session.import.cwd must exactly match the product session workspace".to_string(),
        );
    }
    let object = plan
        .as_object()
        .ok_or_else(|| "session.import.plan must be an object".to_string())?;
    if serde_json::to_vec(plan)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_IMPORT_PLAN_BYTES
    {
        return Err(format!(
            "session.import.plan exceeds the {} MiB limit",
            MAX_IMPORT_PLAN_BYTES / (1024 * 1024)
        ));
    }
    let string_field = |field: &str| {
        object
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("session.import.plan.{field} must be a non-empty string"))
    };
    if string_field("sourceSessionId")? != session_id {
        return Err("session.import.plan.sourceSessionId must match sessionId".to_string());
    }
    if string_field("sourceEngine")? != "melody-acp"
        || string_field("targetEngine")? != "pi"
        || string_field("targetFormat")? != "pi-coding-agent-v3"
    {
        return Err(
            "session.import.plan must describe a melody-acp to pi-coding-agent-v3 migration"
                .to_string(),
        );
    }
    if object.get("readiness").and_then(Value::as_str) == Some("blocked") {
        return Err("session.import.plan is blocked by unresolved migration issues".to_string());
    }
    let records = object
        .get("records")
        .and_then(Value::as_array)
        .ok_or_else(|| "session.import.plan.records must be an array".to_string())?;
    if records.len() > MAX_IMPORT_RECORDS {
        return Err(format!(
            "session.import.plan.records exceeds the {MAX_IMPORT_RECORDS}-entry limit"
        ));
    }
    let existing_engine = connection
        .query_row(
            "SELECT engine FROM agent_session_bindings WHERE session_id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing_engine.as_deref() == Some("pi") {
        return Err("Agent session is already bound to Pi".to_string());
    }
    Ok(())
}

/// Validate a command that operates on an already-open Pi session.
///
/// The renderer carries only a product session id on these commands; the
/// worker itself is intentionally scoped to one canonical workspace.  Check
/// both facts at the Host boundary so a stale renderer (or a malformed
/// invoke payload) cannot send a turn, approval, or task command for another
/// project into the active worker.  `session.open` and `session.import` have
/// their own stricter hand-off checks and therefore do not use this helper.
pub(crate) fn validate_pi_session_command(
    connection: &Connection,
    session_id: &str,
    worker_cwd: &Path,
) -> Result<(), String> {
    required_id(session_id, "sessionId")?;
    validate_pi_session_workspace(connection, session_id, worker_cwd)?;
    let engine = connection
        .query_row(
            "SELECT engine FROM agent_session_bindings WHERE session_id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if engine.as_deref() != Some("pi") {
        return Err(format!(
            "Agent session {session_id} is not bound to Pi; refusing to send a Pi command"
        ));
    }
    Ok(())
}

/// A native fork is authorized only between two product sessions owned by the
/// same project/workspace, with the source already bound to Pi and a fresh
/// unbound destination. The worker separately verifies the native tree anchor.
pub(crate) fn validate_pi_session_fork(
    connection: &Connection,
    source_session_id: &str,
    target_session_id: &str,
    worker_cwd: &Path,
) -> Result<(), String> {
    required_id(source_session_id, "sessionId")?;
    required_id(target_session_id, "targetSessionId")?;
    if source_session_id == target_session_id {
        return Err("A Pi session cannot be forked into itself".to_string());
    }
    let source = connection
        .query_row(
            "SELECT project_id, cwd FROM sessions WHERE id = ?1",
            [source_session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Cannot fork unknown source session {source_session_id}"))?;
    let target = connection
        .query_row(
            "SELECT project_id, cwd FROM sessions WHERE id = ?1",
            [target_session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Cannot fork into unknown target session {target_session_id}"))?;
    if source.0 != target.0 || source.1 != target.1 || Path::new(&source.1) != worker_cwd {
        return Err(
            "Pi fork source and target must share the active project workspace".to_string(),
        );
    }
    let source_engine = connection
        .query_row(
            "SELECT engine FROM agent_session_bindings WHERE session_id = ?1",
            [source_session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if source_engine.as_deref() != Some("pi") {
        return Err("Pi fork source is not bound to the Pi runtime".to_string());
    }
    let target_is_bound = connection
        .query_row(
            "SELECT 1 FROM agent_session_bindings WHERE session_id = ?1",
            [target_session_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if target_is_bound {
        return Err("Pi fork target must be a fresh, unbound product session".to_string());
    }
    Ok(())
}

/// Validate only the workspace ownership of a product session.
///
/// This is also used for worker output: `session.opened` and
/// `session.imported` legitimately create or switch the Pi binding as part of
/// event persistence, so checking the engine binding before appending those
/// events would reject the very event that establishes ownership.
pub(crate) fn validate_pi_session_workspace(
    connection: &Connection,
    session_id: &str,
    worker_cwd: &Path,
) -> Result<(), String> {
    required_id(session_id, "sessionId")?;
    let stored_cwd = connection
        .query_row(
            "SELECT cwd FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Cannot operate on unknown session {session_id}"))?;
    if Path::new(&stored_cwd) != worker_cwd {
        return Err(
            "Pi session belongs to a different workspace; restart the worker before using it"
                .to_string(),
        );
    }
    Ok(())
}

fn binding_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSessionBinding> {
    Ok(AgentSessionBinding {
        session_id: row.get(0)?,
        engine: row.get(1)?,
        native_session_id: row.get(2)?,
        worker_epoch: row.get(3)?,
        last_seq: row.get(4)?,
        session_mode_id: row.get(5)?,
        permission_mode: row.get(6)?,
        model_id: row.get(7)?,
        reasoning_effort: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn get_binding(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<AgentSessionBinding>, String> {
    required_id(session_id, "sessionId")?;
    connection
        .query_row(
            "SELECT session_id, engine, native_session_id, worker_epoch, last_seq,
                    session_mode_id, permission_mode, model_id, reasoning_effort, updated_at
             FROM agent_session_bindings
             WHERE session_id = ?1",
            [session_id],
            binding_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn upsert_binding(
    connection: &Connection,
    request: &UpsertAgentSessionBindingRequest,
) -> Result<AgentSessionBinding, String> {
    validate_request(request)?;
    let session_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            [&request.session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !session_exists {
        return Err(format!(
            "Cannot create an agent binding for unknown session {}",
            request.session_id
        ));
    }
    if let Some(existing_engine) = connection
        .query_row(
            "SELECT engine FROM agent_session_bindings WHERE session_id = ?1",
            [&request.session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        && existing_engine != request.engine
    {
        return Err(format!(
            "Agent session {} is already bound to {}; an explicit migration is required before switching to {}",
            request.session_id, existing_engine, request.engine
        ));
    }
    let updated_at = current_timestamp(connection)?;
    connection
        .execute(
            "INSERT INTO agent_session_bindings
                (session_id, engine, native_session_id, worker_epoch, last_seq,
                 session_mode_id, permission_mode, model_id, reasoning_effort, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(session_id) DO UPDATE SET
                engine = excluded.engine,
                native_session_id = excluded.native_session_id,
                worker_epoch = excluded.worker_epoch,
                last_seq = excluded.last_seq,
                session_mode_id = COALESCE(excluded.session_mode_id, session_mode_id),
                permission_mode = COALESCE(excluded.permission_mode, permission_mode),
                model_id = COALESCE(excluded.model_id, model_id),
                reasoning_effort = COALESCE(excluded.reasoning_effort, reasoning_effort),
                updated_at = excluded.updated_at",
            params![
                request.session_id,
                request.engine,
                request.native_session_id,
                request.worker_epoch,
                request.last_seq,
                request.session_mode_id,
                request.permission_mode,
                request.model_id,
                request.reasoning_effort,
                updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    get_binding(connection, &request.session_id)?
        .ok_or_else(|| "Agent session binding was not available after it was saved".to_string())
}

#[tauri::command]
pub fn get_agent_session_binding(
    database: State<'_, AppDatabase>,
    session_id: String,
) -> Result<Option<AgentSessionBinding>, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    get_binding(&connection, &session_id)
}

#[tauri::command]
pub fn upsert_agent_session_binding(
    database: State<'_, AppDatabase>,
    request: UpsertAgentSessionBindingRequest,
) -> Result<AgentSessionBinding, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    upsert_binding(&connection, &request)
}

#[tauri::command]
pub fn delete_agent_session_binding(
    database: State<'_, AppDatabase>,
    session_id: String,
) -> Result<(), String> {
    required_id(&session_id, "sessionId")?;
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    connection
        .execute(
            "DELETE FROM agent_session_bindings WHERE session_id = ?1",
            [&session_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database_with_session() -> AppDatabase {
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
                 ('s1', 'p1', 'Test', '/tmp/demo', NULL, '[]', NULL, 0, 1, 1)",
                [],
            )
            .unwrap();
        drop(connection);
        database
    }

    #[test]
    fn binding_round_trip_updates_the_worker_cursor() {
        let database = database_with_session();
        let connection = database.connection.lock().unwrap();
        let first = upsert_binding(
            &connection,
            &UpsertAgentSessionBindingRequest {
                session_id: "s1".to_string(),
                engine: "pi".to_string(),
                native_session_id: Some("native-1".to_string()),
                worker_epoch: Some("epoch-1".to_string()),
                last_seq: Some(3),
                session_mode_id: Some("plan".to_string()),
                permission_mode: Some("auto".to_string()),
                model_id: Some("demo/model-1".to_string()),
                reasoning_effort: Some("high".to_string()),
            },
        )
        .unwrap();
        assert_eq!(first.engine, "pi");
        assert_eq!(first.last_seq, Some(3));
        assert_eq!(first.session_mode_id.as_deref(), Some("plan"));
        assert_eq!(first.permission_mode.as_deref(), Some("auto"));
        assert_eq!(first.model_id.as_deref(), Some("demo/model-1"));
        assert_eq!(first.reasoning_effort.as_deref(), Some("high"));

        let second = upsert_binding(
            &connection,
            &UpsertAgentSessionBindingRequest {
                session_id: "s1".to_string(),
                engine: "pi".to_string(),
                native_session_id: Some("native-2".to_string()),
                worker_epoch: Some("epoch-2".to_string()),
                last_seq: Some(8),
                session_mode_id: Some("ask".to_string()),
                permission_mode: Some("always-approve".to_string()),
                model_id: Some("demo/model-2".to_string()),
                reasoning_effort: Some("low".to_string()),
            },
        )
        .unwrap();
        assert_eq!(second.native_session_id.as_deref(), Some("native-2"));
        assert_eq!(second.worker_epoch.as_deref(), Some("epoch-2"));
        assert_eq!(second.last_seq, Some(8));
        assert_eq!(second.session_mode_id.as_deref(), Some("ask"));
        assert_eq!(second.permission_mode.as_deref(), Some("always-approve"));
        assert_eq!(second.model_id.as_deref(), Some("demo/model-2"));
        assert_eq!(second.reasoning_effort.as_deref(), Some("low"));
    }

    #[test]
    fn binding_validation_rejects_invalid_engine_and_cursor() {
        let invalid_engine = UpsertAgentSessionBindingRequest {
            session_id: "s1".to_string(),
            engine: "unknown".to_string(),
            native_session_id: None,
            worker_epoch: None,
            last_seq: None,
            session_mode_id: None,
            permission_mode: None,
            model_id: None,
            reasoning_effort: None,
        };
        assert!(validate_request(&invalid_engine).is_err());

        let invalid_cursor = UpsertAgentSessionBindingRequest {
            session_id: "s1".to_string(),
            engine: "pi".to_string(),
            native_session_id: None,
            worker_epoch: None,
            last_seq: Some(-1),
            session_mode_id: None,
            permission_mode: None,
            model_id: None,
            reasoning_effort: None,
        };
        assert!(validate_request(&invalid_cursor).is_err());

        let invalid_mode = UpsertAgentSessionBindingRequest {
            session_id: "s1".to_string(),
            engine: "pi".to_string(),
            native_session_id: None,
            worker_epoch: None,
            last_seq: None,
            session_mode_id: Some("unsafe".to_string()),
            permission_mode: None,
            model_id: None,
            reasoning_effort: None,
        };
        assert!(validate_request(&invalid_mode).is_err());

        let invalid_permission = UpsertAgentSessionBindingRequest {
            session_id: "s1".to_string(),
            engine: "pi".to_string(),
            native_session_id: None,
            worker_epoch: None,
            last_seq: None,
            session_mode_id: None,
            permission_mode: Some("approve-everything".to_string()),
            model_id: None,
            reasoning_effort: None,
        };
        assert!(validate_request(&invalid_permission).is_err());

        let invalid_reasoning = UpsertAgentSessionBindingRequest {
            session_id: "s1".to_string(),
            engine: "pi".to_string(),
            native_session_id: None,
            worker_epoch: None,
            last_seq: None,
            session_mode_id: None,
            permission_mode: None,
            model_id: None,
            reasoning_effort: Some("ultra".to_string()),
        };
        assert!(validate_request(&invalid_reasoning).is_err());
    }

    #[test]
    fn binding_requires_a_real_session_and_does_not_switch_engines_implicitly() {
        let database = database_with_session();
        let connection = database.connection.lock().unwrap();
        let missing = upsert_binding(
            &connection,
            &UpsertAgentSessionBindingRequest {
                session_id: "missing".to_string(),
                engine: "pi".to_string(),
                native_session_id: None,
                worker_epoch: None,
                last_seq: None,
                session_mode_id: None,
                permission_mode: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .unwrap_err();
        assert!(missing.contains("unknown session"));

        upsert_binding(
            &connection,
            &UpsertAgentSessionBindingRequest {
                session_id: "s1".to_string(),
                engine: "melody-acp".to_string(),
                native_session_id: Some("acp-1".to_string()),
                worker_epoch: None,
                last_seq: None,
                session_mode_id: None,
                permission_mode: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .unwrap();
        let switched = upsert_binding(
            &connection,
            &UpsertAgentSessionBindingRequest {
                session_id: "s1".to_string(),
                engine: "pi".to_string(),
                native_session_id: Some("native-1".to_string()),
                worker_epoch: Some("epoch-1".to_string()),
                last_seq: Some(0),
                session_mode_id: None,
                permission_mode: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .unwrap_err();
        assert!(switched.contains("explicit migration"));
    }

    #[test]
    fn pi_open_preflight_rejects_unknown_and_legacy_sessions() {
        let database = database_with_session();
        let connection = database.connection.lock().unwrap();
        assert!(validate_pi_session_open(&connection, "missing", Path::new("/tmp/demo")).is_err());
        connection
            .execute(
                "INSERT INTO agent_session_bindings
                 (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                 VALUES ('s1', 'melody-acp', NULL, NULL, NULL, 1)",
                [],
            )
            .unwrap();
        let error =
            validate_pi_session_open(&connection, "s1", Path::new("/tmp/demo")).unwrap_err();
        assert!(error.contains("explicit migration"));
    }

    #[test]
    fn pi_open_preflight_allows_unbound_and_pi_sessions() {
        let database = database_with_session();
        let connection = database.connection.lock().unwrap();
        validate_pi_session_open(&connection, "s1", Path::new("/tmp/demo")).unwrap();
        assert!(
            validate_pi_session_open(&connection, "s1", Path::new("/tmp/other"))
                .unwrap_err()
                .contains("different workspace")
        );
        connection
            .execute(
                "INSERT INTO agent_session_bindings
                 (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                 VALUES ('s1', 'pi', NULL, NULL, NULL, 1)",
                [],
            )
            .unwrap();
        validate_pi_session_open(&connection, "s1", Path::new("/tmp/demo")).unwrap();
        assert!(
            validate_pi_session_open(&connection, "s1", Path::new("/tmp/other"))
                .unwrap_err()
                .contains("different workspace")
        );
    }

    #[test]
    fn pi_import_preflight_requires_a_safe_plan_and_can_take_over_legacy() {
        let database = database_with_session();
        let connection = database.connection.lock().unwrap();
        connection
            .execute(
                "INSERT INTO agent_session_bindings
                 (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                 VALUES ('s1', 'melody-acp', 'acp-1', NULL, NULL, 1)",
                [],
            )
            .unwrap();
        let plan = serde_json::json!({
            "planVersion": 1,
            "sourceSessionId": "s1",
            "sourceEngine": "melody-acp",
            "targetEngine": "pi",
            "targetFormat": "pi-coding-agent-v3",
            "readiness": "display-only",
            "records": []
        });
        validate_pi_session_import(&connection, "s1", "/tmp/demo", &plan).unwrap();
        assert!(validate_pi_session_import(&connection, "s1", "/tmp/other", &plan).is_err());
        let blocked = serde_json::json!({
            "planVersion": 1,
            "sourceSessionId": "s1",
            "sourceEngine": "melody-acp",
            "targetEngine": "pi",
            "targetFormat": "pi-coding-agent-v3",
            "readiness": "blocked",
            "records": []
        });
        assert!(validate_pi_session_import(&connection, "s1", "/tmp/demo", &blocked).is_err());
    }

    #[test]
    fn pi_command_preflight_requires_a_pi_binding_in_the_worker_workspace() {
        let database = database_with_session();
        let connection = database.connection.lock().unwrap();
        assert!(
            validate_pi_session_command(&connection, "missing", Path::new("/tmp/demo")).is_err()
        );

        connection
            .execute(
                "INSERT INTO agent_session_bindings
                 (session_id, engine, native_session_id, worker_epoch, last_seq, updated_at)
                 VALUES ('s1', 'melody-acp', NULL, NULL, NULL, 1)",
                [],
            )
            .unwrap();
        assert!(
            validate_pi_session_command(&connection, "s1", Path::new("/tmp/demo"))
                .unwrap_err()
                .contains("not bound to Pi")
        );

        connection
            .execute(
                "UPDATE agent_session_bindings SET engine = 'pi' WHERE session_id = 's1'",
                [],
            )
            .unwrap();
        assert!(
            validate_pi_session_command(&connection, "s1", Path::new("/tmp/other"))
                .unwrap_err()
                .contains("different workspace")
        );
        validate_pi_session_command(&connection, "s1", Path::new("/tmp/demo")).unwrap();
    }
}
