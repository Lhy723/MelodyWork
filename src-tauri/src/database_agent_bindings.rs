use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::database_core::{AppDatabase, current_timestamp};

#[path = "database_agent_bindings/preflight.rs"]
mod preflight;

use self::preflight::required_id;
pub(crate) use self::preflight::{
    validate_pi_session_command, validate_pi_session_fork, validate_pi_session_import,
    validate_pi_session_open, validate_pi_session_workspace,
};

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
