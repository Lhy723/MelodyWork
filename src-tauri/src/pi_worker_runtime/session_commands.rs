//! Host preflight for commands that operate on persisted Pi sessions.
//!
//! The worker only sees one active workspace, but renderer commands carry
//! product session IDs and may include renderer-supplied paths or migration
//! plans. This module keeps those values tied to the registered workspace and
//! the authoritative SQLite session/binding records before the supervisor
//! forwards a command.

use std::path::PathBuf;

use serde_json::{Map, Value};

use super::{PiWorkerRuntime, protocol};
use crate::{
    database::{
        AppDatabase, begin_pi_session_fork, validate_pi_migration_import,
        validate_pi_session_command, validate_pi_session_import, validate_pi_session_open,
    },
    workspace_access::WorkspaceRegistry,
};

#[allow(async_fn_in_trait)]
pub(super) trait WorkerWorkspace {
    async fn workspace_for_generation(&self, generation: u64) -> Result<PathBuf, String>;
}

impl WorkerWorkspace for PiWorkerRuntime {
    async fn workspace_for_generation(&self, generation: u64) -> Result<PathBuf, String> {
        PiWorkerRuntime::worker_cwd(self, generation).await
    }
}

const SESSION_BOUND_PI_COMMANDS: &[&str] = &[
    "session.close",
    "session.configure",
    "session.fork",
    "turn.submit",
    "turn.steer",
    "turn.follow_up",
    "turn.cancel",
    "interaction.resolve",
    "tool.resolve",
    "task.wait",
    "task.cancel",
    "task.continue",
];

#[derive(Debug)]
enum PreparedSessionCommand {
    Fork {
        source_session_id: String,
        target_session_id: String,
        native_entry_id: String,
        request_id: String,
        authorized_cwd: PathBuf,
    },
    Open {
        product_session_id: String,
        authorized_cwd: PathBuf,
    },
    Import {
        product_session_id: String,
        cwd: String,
        authorized_cwd: PathBuf,
        command: Map<String, Value>,
    },
    Bound {
        session_id: String,
    },
}

fn nested_command<'a>(
    command: &'a Value,
    command_type: &str,
    debug_type: bool,
) -> Result<&'a Map<String, Value>, String> {
    command
        .get("command")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            let label = if debug_type {
                format!("{:?}", Some(command_type))
            } else {
                command_type.to_string()
            };
            format!("{label} command must be an object")
        })
}

fn required_command_string<'a>(
    command: &'a Map<String, Value>,
    command_type: &str,
    field: &str,
) -> Result<&'a str, String> {
    command
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{command_type}.{field} is required"))
}

/// Parse renderer-owned command fields and authorize any renderer-supplied
/// workspace path. The returned plan must still pass
/// authorize_for_worker before database side effects or pipe forwarding.
fn prepare_session_command(
    command: &Value,
    command_type: Option<&str>,
    registry: &WorkspaceRegistry,
) -> Result<Option<PreparedSessionCommand>, String> {
    if let Some(command_type) = command_type {
        protocol::validate_command_session_identity(command, command_type)?;
    }
    let Some(command_type) = command_type else {
        return Ok(None);
    };

    match command_type {
        "session.fork" => {
            let session = nested_command(command, command_type, false)?;
            let source_session_id =
                required_command_string(session, command_type, "sessionId")?.to_string();
            let target_session_id =
                required_command_string(session, command_type, "targetSessionId")?.to_string();
            let cwd = session
                .get("cwd")
                .and_then(Value::as_str)
                .ok_or_else(|| "session.fork.cwd is required".to_string())?;
            let native_entry_id =
                required_command_string(session, command_type, "nativeEntryId")?.to_string();
            let request_id = command
                .get("requestId")
                .and_then(|value| match value {
                    Value::String(value) => Some(value.clone()),
                    Value::Number(value) => Some(value.to_string()),
                    _ => None,
                })
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "session.fork requestId is required".to_string())?;
            let authorized_cwd = registry.authorize(cwd)?;
            Ok(Some(PreparedSessionCommand::Fork {
                source_session_id,
                target_session_id,
                native_entry_id,
                request_id,
                authorized_cwd,
            }))
        }
        "session.open" | "session.import" => {
            let session = nested_command(command, command_type, true)?;
            let product_session_id = match (
                session.get("productSessionId"),
                session.get("sessionId"),
            ) {
                (Some(Value::String(product)), Some(Value::String(session)))
                    if product != session && command_type == "session.open" =>
                {
                    return Err(
                        "session.open productSessionId and sessionId must identify the same product session"
                            .to_string(),
                    );
                }
                (Some(Value::String(product)), _) | (_, Some(Value::String(product)))
                    if !product.trim().is_empty() =>
                {
                    product.clone()
                }
                _ => {
                    return Err(if command_type == "session.import" {
                        "session.import requires sessionId".to_string()
                    } else {
                        "session.open requires productSessionId (or a product sessionId)"
                            .to_string()
                    });
                }
            };
            if command_type == "session.import"
                && session
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .is_some_and(|session_id| session_id != product_session_id)
            {
                return Err("session.import envelope and command sessionId must match".to_string());
            }
            let cwd = session
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("{:?}.cwd is required", Some(command_type)))?;
            let authorized_cwd = registry.authorize(&cwd)?;
            if command_type == "session.open" {
                Ok(Some(PreparedSessionCommand::Open {
                    product_session_id,
                    authorized_cwd,
                }))
            } else {
                Ok(Some(PreparedSessionCommand::Import {
                    product_session_id,
                    cwd,
                    authorized_cwd,
                    command: session.clone(),
                }))
            }
        }
        command_type if SESSION_BOUND_PI_COMMANDS.contains(&command_type) => {
            let session = nested_command(command, command_type, false)?;
            let session_id =
                required_command_string(session, command_type, "sessionId")?.to_string();
            Ok(Some(PreparedSessionCommand::Bound { session_id }))
        }
        _ => Ok(None),
    }
}

fn check_active_workspace(
    authorized_cwd: &std::path::Path,
    worker_cwd: &std::path::Path,
) -> Result<(), String> {
    if authorized_cwd == worker_cwd {
        return Ok(());
    }
    Err(
        "Pi worker is bound to a different workspace; restart it before opening this session"
            .to_string(),
    )
}

fn authorize_for_worker(
    prepared: PreparedSessionCommand,
    worker_cwd: &std::path::Path,
    database: &AppDatabase,
) -> Result<Option<String>, String> {
    match prepared {
        PreparedSessionCommand::Fork {
            source_session_id,
            target_session_id,
            native_entry_id,
            request_id,
            authorized_cwd,
        } => {
            if authorized_cwd != worker_cwd {
                return Err("Pi fork workspace differs from the active worker".to_string());
            }
            let mut connection = database
                .connection
                .lock()
                .map_err(|_| "Database lock poisoned".to_string())?;
            begin_pi_session_fork(
                &mut connection,
                &source_session_id,
                &target_session_id,
                &native_entry_id,
                &request_id,
                worker_cwd,
            )?;
            Ok(Some(source_session_id))
        }
        PreparedSessionCommand::Open {
            product_session_id,
            authorized_cwd,
        } => {
            check_active_workspace(&authorized_cwd, worker_cwd)?;
            let connection = database
                .connection
                .lock()
                .map_err(|_| "Database lock poisoned".to_string())?;
            validate_pi_session_open(&connection, &product_session_id, &authorized_cwd)?;
            Ok(None)
        }
        PreparedSessionCommand::Import {
            product_session_id,
            cwd,
            authorized_cwd,
            command,
        } => {
            check_active_workspace(&authorized_cwd, worker_cwd)?;
            let connection = database
                .connection
                .lock()
                .map_err(|_| "Database lock poisoned".to_string())?;
            let plan = command
                .get("plan")
                .ok_or_else(|| "session.import.plan is required".to_string())?;
            validate_pi_session_import(&connection, &product_session_id, &cwd, plan)?;
            let migration_id = required_command_string(&command, "session.import", "migrationId")?;
            let requested_backup = command
                .get("backup")
                .and_then(Value::as_bool)
                .ok_or_else(|| "session.import.backup is required".to_string())?;
            validate_pi_migration_import(
                &connection,
                migration_id,
                &product_session_id,
                plan,
                requested_backup,
            )?;
            Ok(None)
        }
        PreparedSessionCommand::Bound { session_id } => {
            validate_session_binding(database, &session_id, worker_cwd)?;
            Ok(None)
        }
    }
}

fn validate_session_binding(
    database: &AppDatabase,
    session_id: &str,
    worker_cwd: &std::path::Path,
) -> Result<(), String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    validate_pi_session_command(&connection, session_id, worker_cwd)
}

/// Apply Host workspace and persisted-session checks before a command is
/// allowed to reach the worker. Fork intent is durably recorded before
/// forwarding; session close/cancel side effects remain with the command
/// handler because they coordinate MCP and monitor runtimes.
pub(super) async fn preflight<Workspace: WorkerWorkspace>(
    command: &Value,
    command_type: Option<&str>,
    generation: u64,
    runtime: &Workspace,
    database: &AppDatabase,
    registry: &WorkspaceRegistry,
) -> Result<(), String> {
    let Some(prepared) = prepare_session_command(command, command_type, registry)? else {
        return Ok(());
    };
    let worker_cwd = runtime.workspace_for_generation(generation).await?;
    let fork_source = authorize_for_worker(prepared, &worker_cwd, database)?;
    if let Some(session_id) = fork_source {
        // Preserve the original post-persistence generation check and source
        // binding verification before any fork bytes enter the worker pipe.
        let worker_cwd = runtime.workspace_for_generation(generation).await?;
        validate_session_binding(database, &session_id, &worker_cwd)?;
    }
    Ok(())
}
