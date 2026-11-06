//! Host-owned admission checks for persisted Pi session operations.
//!
//! Before a renderer command or worker event uses a product session, these
//! checks bind its identity and engine state to the active workspace. Import
//! plans also receive bounded schema and migration-state validation here.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;

const MAX_BINDING_ID_BYTES: usize = 256;
const MAX_IMPORT_PLAN_BYTES: usize = 4 * 1024 * 1024;
const MAX_IMPORT_RECORDS: usize = 4096;

pub(super) fn required_id(value: &str, field: &str) -> Result<(), String> {
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
