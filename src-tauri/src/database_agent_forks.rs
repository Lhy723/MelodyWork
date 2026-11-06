//! Durable product-level lineage for Pi Explorer branches.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::database_agent_bindings::validate_pi_session_fork;
use super::database_core::{AppDatabase, current_timestamp};
use crate::workspace_access::WorkspaceRegistry;

const MAX_FORK_ID_BYTES: usize = 256;
const MAX_FORK_ERROR_BYTES: usize = 16 * 1024;
const MAX_RELATED_FORKS: usize = 64;
const MAX_EXPLORER_REFERENCE_CODEPOINTS: usize = 12_000;
const MAX_EXPLORER_REFERENCE_MESSAGES: usize = 128;
const MAX_EXPLORER_REFERENCE_TIMELINE_ENTRIES: usize = 4_096;
const MAX_EXPLORER_REFERENCE_TIMELINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionFork {
    pub branch_session_id: String,
    pub source_session_id: String,
    pub anchor_native_entry_id: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionReferenceMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionForkReference {
    pub source_session_id: String,
    pub branch_session_id: String,
    pub anchor_native_entry_id: String,
    pub messages: Vec<PiSessionReferenceMessage>,
    pub truncated: bool,
}

pub(crate) fn ensure_pi_session_fork_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS pi_session_forks (
            branch_session_id TEXT PRIMARY KEY NOT NULL,
            source_session_id TEXT NOT NULL,
            anchor_native_entry_id TEXT NOT NULL,
            request_id TEXT UNIQUE,
            status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed')),
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(branch_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(source_session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS pi_session_forks_source_status
            ON pi_session_forks(source_session_id, status, updated_at DESC);
        ",
    )
}

fn validate_id(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.len() > MAX_FORK_ID_BYTES {
        return Err(format!(
            "{field} exceeds the {MAX_FORK_ID_BYTES}-byte limit"
        ));
    }
    Ok(())
}

fn fork_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PiSessionFork> {
    Ok(PiSessionFork {
        branch_session_id: row.get(0)?,
        source_session_id: row.get(1)?,
        anchor_native_entry_id: row.get(2)?,
        status: row.get(3)?,
        error: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn read_fork(
    connection: &Connection,
    branch_session_id: &str,
) -> Result<Option<PiSessionFork>, String> {
    connection
        .query_row(
            "SELECT branch_session_id, source_session_id, anchor_native_entry_id,
                    status, error, created_at, updated_at
             FROM pi_session_forks WHERE branch_session_id = ?1",
            [branch_session_id],
            fork_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_related_forks(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<PiSessionFork>, String> {
    let parent_source: Option<String> = connection
        .query_row(
            "SELECT source_session_id FROM pi_session_forks WHERE branch_session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let source_session_id = parent_source.as_deref().unwrap_or(session_id);
    let mut statement = connection
        .prepare(
            "SELECT branch_session_id, source_session_id, anchor_native_entry_id,
                    status, error, created_at, updated_at
             FROM pi_session_forks
             WHERE source_session_id = ?1
             ORDER BY updated_at DESC, created_at DESC, branch_session_id ASC
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let forks = statement
        .query_map(
            params![source_session_id, MAX_RELATED_FORKS as i64],
            fork_from_row,
        )
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(forks)
}

fn read_fork_reference(
    connection: &Connection,
    source_session_id: &str,
    branch_session_id: &str,
) -> Result<PiSessionForkReference, String> {
    validate_id(source_session_id, "sourceSessionId")?;
    validate_id(branch_session_id, "branchSessionId")?;
    let fork = read_fork(connection, branch_session_id)?
        .ok_or_else(|| "Explorer session reference does not exist".to_string())?;
    if fork.source_session_id != source_session_id {
        return Err("Explorer session reference belongs to a different source session".to_string());
    }
    if fork.status != "ready" {
        return Err("Explorer session reference is not ready".to_string());
    }

    let (source_project, source_cwd): (String, String) = connection
        .query_row(
            "SELECT project_id, cwd FROM sessions WHERE id = ?1",
            [source_session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let (branch_project, branch_cwd, timeline_json): (String, String, String) = connection
        .query_row(
            "SELECT project_id, cwd, timeline_json FROM sessions WHERE id = ?1",
            [branch_session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    if source_project != branch_project || source_cwd != branch_cwd {
        return Err("Explorer session reference is outside the source workspace".to_string());
    }
    for session_id in [source_session_id, branch_session_id] {
        let engine: Option<String> = connection
            .query_row(
                "SELECT engine FROM agent_session_bindings WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if engine.as_deref() != Some("pi") {
            return Err("Explorer session reference is not bound to Pi".to_string());
        }
    }

    let (archived_count, archived_bytes): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(entry_json)), 0)
             FROM session_timeline_entries WHERE session_id = ?1",
            [branch_session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    if archived_count > MAX_EXPLORER_REFERENCE_TIMELINE_ENTRIES as i64
        || archived_bytes > MAX_EXPLORER_REFERENCE_TIMELINE_BYTES as i64
    {
        return Err("Explorer session timeline exceeds the reference size limit".to_string());
    }
    let mut statement = connection
        .prepare(
            "SELECT ordinal, entry_json FROM session_timeline_entries
             WHERE session_id = ?1 ORDER BY ordinal ASC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let archived = statement
        .query_map(
            params![
                branch_session_id,
                MAX_EXPLORER_REFERENCE_TIMELINE_ENTRIES as i64 + 1
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let timeline = if archived.is_empty() {
        if timeline_json.len() > MAX_EXPLORER_REFERENCE_TIMELINE_BYTES {
            return Err("Explorer session timeline exceeds the reference size limit".to_string());
        }
        let value: Value = serde_json::from_str(&timeline_json)
            .map_err(|_| "Explorer session timeline is not valid JSON".to_string())?;
        value
            .as_array()
            .cloned()
            .ok_or_else(|| "Explorer session timeline is not an array".to_string())?
    } else {
        if archived.len() > MAX_EXPLORER_REFERENCE_TIMELINE_ENTRIES {
            return Err("Explorer session timeline has too many archived entries".to_string());
        }
        let mut bytes = 0usize;
        let mut values = Vec::with_capacity(archived.len());
        for (expected_ordinal, (ordinal, raw_entry)) in archived.into_iter().enumerate() {
            if ordinal != expected_ordinal as i64 {
                return Err("Explorer session timeline archive has a missing ordinal".to_string());
            }
            bytes = bytes.saturating_add(raw_entry.len());
            if bytes > MAX_EXPLORER_REFERENCE_TIMELINE_BYTES {
                return Err(
                    "Explorer session timeline exceeds the reference size limit".to_string()
                );
            }
            let value: Value = serde_json::from_str(&raw_entry)
                .map_err(|_| "Explorer session timeline archive is not valid JSON".to_string())?;
            if !value.is_object() {
                return Err("Explorer session timeline archive entry is not an object".to_string());
            }
            values.push(value);
        }
        values
    };

    let anchor_index = timeline.iter().position(|entry| {
        entry.get("kind").and_then(Value::as_str) == Some("message")
            && entry.get("role").and_then(Value::as_str) == Some("assistant")
            && entry.get("nativeEntryId").and_then(Value::as_str)
                == Some(fork.anchor_native_entry_id.as_str())
    });
    let anchor_index = anchor_index
        .ok_or_else(|| "Explorer session timeline does not contain its fork anchor".to_string())?;

    let mut messages = Vec::<(String, PiSessionReferenceMessage)>::new();
    for (ordinal, entry) in timeline.iter().enumerate().skip(anchor_index + 1) {
        if entry.get("kind").and_then(Value::as_str) != Some("message")
            || entry.get("streaming").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let Some(role) = entry.get("role").and_then(Value::as_str) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let Some(content) = entry.get("content").and_then(Value::as_str) else {
            continue;
        };
        let content = content.trim();
        if content.is_empty() {
            continue;
        }
        let key = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("ordinal:{ordinal}"));
        let message = PiSessionReferenceMessage {
            role: role.to_string(),
            content: content.to_string(),
        };
        if let Some((_, existing)) = messages.iter_mut().find(|(id, _)| *id == key) {
            *existing = message;
        } else {
            messages.push((key, message));
        }
    }

    let mut truncated = messages.len() > MAX_EXPLORER_REFERENCE_MESSAGES;
    if truncated {
        messages.drain(..messages.len() - MAX_EXPLORER_REFERENCE_MESSAGES);
    }
    let mut remaining = MAX_EXPLORER_REFERENCE_CODEPOINTS;
    let mut bounded_messages = Vec::with_capacity(messages.len());
    for (_, mut message) in messages {
        let codepoints = message.content.chars().count();
        if codepoints > remaining {
            message.content = message.content.chars().take(remaining).collect();
            truncated = true;
        }
        remaining = remaining.saturating_sub(message.content.chars().count());
        bounded_messages.push(message);
        if remaining == 0 {
            if codepoints
                > bounded_messages
                    .last()
                    .map_or(0, |item| item.content.chars().count())
            {
                truncated = true;
            }
            break;
        }
    }

    Ok(PiSessionForkReference {
        source_session_id: source_session_id.to_string(),
        branch_session_id: branch_session_id.to_string(),
        anchor_native_entry_id: fork.anchor_native_entry_id,
        messages: bounded_messages,
        truncated,
    })
}

/// Record the exact source and native anchor before the worker can materialize
/// a target file. Retrying is allowed only for the same branch lineage.
pub(crate) fn begin_pi_session_fork(
    connection: &mut Connection,
    source_session_id: &str,
    branch_session_id: &str,
    anchor_native_entry_id: &str,
    request_id: &str,
    worker_cwd: &std::path::Path,
) -> Result<PiSessionFork, String> {
    validate_id(source_session_id, "sessionId")?;
    validate_id(branch_session_id, "targetSessionId")?;
    validate_id(anchor_native_entry_id, "nativeEntryId")?;
    validate_id(request_id, "requestId")?;

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    validate_pi_session_fork(
        &transaction,
        source_session_id,
        branch_session_id,
        worker_cwd,
    )?;

    if let Some(existing) = read_fork(&transaction, branch_session_id)? {
        if existing.source_session_id != source_session_id
            || existing.anchor_native_entry_id != anchor_native_entry_id
        {
            return Err(
                "A Pi Explorer branch cannot be rebound to a different source or anchor"
                    .to_string(),
            );
        }
        if existing.status == "ready" {
            return Err("Pi Explorer branch is already ready".to_string());
        }
        let now = current_timestamp(&transaction)?;
        transaction
            .execute(
                "UPDATE pi_session_forks SET request_id = ?2, status = 'pending',
                    error = NULL, updated_at = ?3 WHERE branch_session_id = ?1",
                params![branch_session_id, request_id, now],
            )
            .map_err(|error| error.to_string())?;
    } else {
        let now = current_timestamp(&transaction)?;
        transaction
            .execute(
                "INSERT INTO pi_session_forks
                    (branch_session_id, source_session_id, anchor_native_entry_id,
                     request_id, status, error, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'pending', NULL, ?5, ?5)",
                params![
                    branch_session_id,
                    source_session_id,
                    anchor_native_entry_id,
                    request_id,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    let record = read_fork(&transaction, branch_session_id)?
        .ok_or_else(|| "Pi Explorer fork record disappeared".to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(record)
}

/// Tie the durable lineage state to the same transaction as the worker event
/// and binding checkpoint, so a branch is never exposed as ready prematurely.
pub(crate) fn apply_fork_event_tx(
    transaction: &Transaction<'_>,
    envelope: &Value,
) -> Result<(), String> {
    let event = envelope.get("event").and_then(Value::as_object);
    let event_type = event
        .and_then(|event| event.get("type"))
        .and_then(Value::as_str);
    let session_id = envelope.get("sessionId").and_then(Value::as_str);
    let request_id = envelope.get("requestId").and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    });
    let now = current_timestamp(transaction)?;

    match event_type {
        Some("session.opened") => {
            if let (Some(session_id), Some(request_id)) = (session_id, request_id.as_deref()) {
                transaction
                    .execute(
                        "UPDATE pi_session_forks SET status = 'ready', error = NULL,
                            updated_at = ?3
                         WHERE branch_session_id = ?1 AND request_id = ?2
                           AND status IN ('pending', 'failed')",
                        params![session_id, request_id, now],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        Some("runtime.error") => {
            if let (Some(session_id), Some(request_id)) = (session_id, request_id.as_deref()) {
                let message = event
                    .and_then(|event| event.get("error"))
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Pi worker rejected the Explorer fork");
                let bounded_error: String = message.chars().take(MAX_FORK_ERROR_BYTES).collect();
                transaction
                    .execute(
                        "UPDATE pi_session_forks SET status = 'failed', error = ?3,
                            updated_at = ?4
                         WHERE source_session_id = ?1 AND request_id = ?2
                           AND status = 'pending'",
                        params![session_id, request_id, bounded_error, now],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
pub fn get_pi_session_fork(
    database: State<'_, AppDatabase>,
    branch_session_id: String,
) -> Result<Option<PiSessionFork>, String> {
    validate_id(&branch_session_id, "branchSessionId")?;
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    read_fork(&connection, &branch_session_id)
}

/// Return sibling Explorer branches for either their source session or one of
/// the branches. The product session list remains the source of session data;
/// this command only exposes the bounded lineage relationship.
#[tauri::command]
pub fn list_pi_session_forks(
    database: State<'_, AppDatabase>,
    session_id: String,
) -> Result<Vec<PiSessionFork>, String> {
    validate_id(&session_id, "sessionId")?;
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    read_related_forks(&connection, &session_id)
}

/// Resolve a same-source, ready Pi branch into bounded post-anchor messages.
/// The request is explicit and product-session scoped; it never reads an
/// arbitrary Pi path or exposes tool output and hidden reasoning.
#[tauri::command]
pub fn read_pi_session_fork_reference(
    database: State<'_, AppDatabase>,
    source_session_id: String,
    branch_session_id: String,
) -> Result<PiSessionForkReference, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    read_fork_reference(&connection, &source_session_id, &branch_session_id)
}

#[tauri::command]
pub fn prepare_pi_session_fork(
    database: State<'_, AppDatabase>,
    registry: State<'_, WorkspaceRegistry>,
    source_session_id: String,
    branch_session_id: String,
    anchor_native_entry_id: String,
    request_id: String,
    cwd: String,
) -> Result<PiSessionFork, String> {
    let authorized_cwd = registry.authorize(&cwd)?;
    let mut connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    begin_pi_session_fork(
        &mut connection,
        &source_session_id,
        &branch_session_id,
        &anchor_native_entry_id,
        &request_id,
        &authorized_cwd,
    )
}
