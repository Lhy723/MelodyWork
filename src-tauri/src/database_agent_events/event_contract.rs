//! Validation and projection for worker event envelopes before persistence.
//!
//! This module owns the bounded Pi protocol contract. The parent event-log
//! module owns SQLite transactions, session binding updates, and replay
//! idempotency.

use serde_json::Value;

/// Keep individual events bounded even though the event log itself is
/// append-only. The worker transport has the same 1 MiB frame limit; this
/// guard also protects callers that use the database helper directly.
const MAX_AGENT_EVENT_JSON_BYTES: usize = 1024 * 1024;
const MAX_EVENT_ID_BYTES: usize = 256;
const PI_SESSION_MODES: [&str; 3] = ["default", "plan", "ask"];
const PERMISSION_MODES: [&str; 3] = ["ask", "auto", "always-approve"];
const PI_REASONING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug)]
pub(super) struct ParsedEvent {
    pub(super) session_id: String,
    pub(super) event_id: String,
    pub(super) source_event_id: Option<String>,
    pub(super) worker_epoch: Option<String>,
    pub(super) seq: Option<i64>,
    pub(super) native_session_id: Option<String>,
    pub(super) session_mode_id: Option<String>,
    pub(super) permission_mode: Option<String>,
    pub(super) model_id: Option<String>,
    pub(super) reasoning_effort: Option<String>,
    pub(super) migration_id: Option<String>,
    pub(super) backup_ref: Option<String>,
    pub(super) event_json: String,
    pub(super) event: Value,
}

pub(super) fn required_id(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.len() > MAX_EVENT_ID_BYTES {
        return Err(format!(
            "{field} exceeds the {MAX_EVENT_ID_BYTES}-byte limit"
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

fn migration_id_from_event(event: &Value) -> Option<&str> {
    event
        .get("migrationId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn backup_ref_from_event(event: &Value) -> Option<&str> {
    event
        .get("backupPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

pub(super) fn parse_event(value: &Value) -> Result<ParsedEvent, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Pi event envelope must be an object".to_string())?;
    if object.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Pi event uses an unsupported protocol version".to_string());
    }
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Pi event sessionId must be a non-empty string".to_string())?;
    required_id(session_id, "sessionId")?;
    let event_id = object
        .get("eventId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Pi event eventId must be a non-empty string".to_string())?;
    required_id(event_id, "eventId")?;
    let stream_session_id = object
        .get("streamSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    optional_id(stream_session_id.as_deref(), "streamSessionId")?;
    if object.get("replay").and_then(Value::as_bool).is_none() {
        return Err("Pi event replay must be a boolean".to_string());
    }
    let event = object
        .get("event")
        .filter(|event| event.is_object())
        .cloned()
        .ok_or_else(|| "Pi event inner event must be an object".to_string())?;
    let event_type = event.get("type").and_then(Value::as_str);
    if event_type == Some("session.imported")
        && event
            .get("nativeSessionId")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err("session.imported must include nativeSessionId".to_string());
    }
    let source_event_id = object
        .get("sourceEventId")
        .and_then(Value::as_str)
        .map(str::to_string);
    optional_id(source_event_id.as_deref(), "sourceEventId")?;
    let worker_epoch = object
        .get("workerEpoch")
        .and_then(Value::as_str)
        .map(str::to_string);
    optional_id(worker_epoch.as_deref(), "workerEpoch")?;
    let seq = object
        .get("seq")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| "Pi event seq must be a non-negative integer".to_string())
                .and_then(|seq| {
                    i64::try_from(seq)
                        .map_err(|_| "Pi event seq exceeds the SQLite integer range".to_string())
                })
        })
        .transpose()?;
    let native_session_id = event
        .get("nativeSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    optional_id(native_session_id.as_deref(), "nativeSessionId")?;
    let optional_enum = |field: &str, allowed: &[&str]| -> Result<Option<String>, String> {
        match event.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) if allowed.contains(&value.as_str()) => {
                Ok(Some(value.clone()))
            }
            Some(Value::String(value)) => {
                Err(format!("Pi event {field} has unsupported value {value}"))
            }
            Some(_) => Err(format!("Pi event {field} must be a string when present")),
        }
    };
    let session_mode_id = optional_enum("sessionModeId", &PI_SESSION_MODES)?;
    let permission_mode = optional_enum("permissionMode", &PERMISSION_MODES)?;
    let model_id = match event.get("modelId") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            required_id(value, "modelId")?;
            Some(value.clone())
        }
        Some(_) => return Err("Pi event modelId must be a string when present".to_string()),
    };
    let reasoning_effort = optional_enum("reasoningEffort", &PI_REASONING_LEVELS)?;
    let migration_id = migration_id_from_event(&event).map(str::to_string);
    optional_id(migration_id.as_deref(), "migrationId")?;
    let backup_ref = backup_ref_from_event(&event).map(str::to_string);
    if backup_ref
        .as_deref()
        .is_some_and(|value| value.len() > 4096)
    {
        return Err("backupPath exceeds the 4096-byte limit".to_string());
    }
    let event_json = serde_json::to_string(value).map_err(|error| error.to_string())?;
    if event_json.len() > MAX_AGENT_EVENT_JSON_BYTES {
        return Err(format!(
            "Pi event exceeds the {} MiB limit",
            MAX_AGENT_EVENT_JSON_BYTES / (1024 * 1024)
        ));
    }
    Ok(ParsedEvent {
        session_id: session_id.to_string(),
        event_id: event_id.to_string(),
        source_event_id,
        worker_epoch,
        seq,
        native_session_id,
        session_mode_id,
        permission_mode,
        model_id,
        reasoning_effort,
        migration_id,
        backup_ref,
        event_json,
        event: value.clone(),
    })
}
