//! Bounded newline-delimited JSON protocol framing and command validation.
//!
//! The worker supervisor owns process lifetime and dispatch state; this
//! module owns the Host/worker wire envelope and frame-boundary contract.

use std::io;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub(super) const AGENT_PROTOCOL_VERSION: u64 = 1;
pub(super) const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Ensure the optional envelope affinity and command product session agree.
/// The renderer supplies the envelope while the worker routes the nested
/// command; conflicting identities would make the Host boundary ambiguous.
pub(super) fn validate_command_session_identity(
    value: &Value,
    command_type: &str,
) -> Result<(), String> {
    let Some(envelope) = value.get("sessionId") else {
        return Ok(());
    };
    let envelope_id = match envelope {
        Value::String(id) if !id.trim().is_empty() => id,
        Value::Null => return Ok(()),
        Value::String(_) => {
            return Err("Pi command envelope.sessionId must not be empty".to_string());
        }
        _ => {
            return Err("Pi command envelope.sessionId must be a string".to_string());
        }
    };
    let Some(command_object) = value.get("command").and_then(Value::as_object) else {
        return Err(format!("{command_type} command must be an object"));
    };
    let Some(nested) = command_object.get("sessionId") else {
        return Ok(());
    };
    let nested_id = match nested {
        Value::String(id) if !id.trim().is_empty() => id,
        Value::Null => return Ok(()),
        Value::String(_) => {
            return Err(format!("{command_type}.sessionId must not be empty"));
        }
        _ => return Err(format!("{command_type}.sessionId must be a string")),
    };
    if envelope_id != nested_id {
        return Err(format!(
            "Pi command envelope.sessionId and {command_type}.sessionId must match"
        ));
    }
    Ok(())
}

pub(super) fn encode_command(value: &Value) -> Result<Vec<u8>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Pi command envelope must be an object".to_string())?;
    if object.get("protocolVersion").and_then(Value::as_u64) != Some(AGENT_PROTOCOL_VERSION) {
        return Err("Unsupported Pi agent protocol version".to_string());
    }
    let request_id = object
        .get("requestId")
        .ok_or_else(|| "Pi command envelope.requestId is required".to_string())?;
    let valid_request_id = match request_id {
        Value::String(value) => !value.trim().is_empty(),
        Value::Number(value) => value
            .as_i64()
            .map(|number| number.unsigned_abs() <= 9_007_199_254_740_991)
            .or_else(|| value.as_u64().map(|number| number <= 9_007_199_254_740_991))
            .unwrap_or(false),
        _ => false,
    };
    if !valid_request_id {
        return Err("Pi command envelope.requestId must be a stable ID".to_string());
    }
    let command_type = object
        .get("command")
        .and_then(Value::as_object)
        .and_then(|command| command.get("type"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Pi command envelope.command.type is required".to_string())?;
    let _ = command_type;
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "Pi command frame exceeds the {} byte limit",
            MAX_FRAME_BYTES
        ));
    }
    Ok(bytes)
}

pub(super) async fn read_frame<R>(reader: &mut R) -> io::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut frame = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            if frame.is_empty() {
                return Ok(None);
            }
            trim_carriage_return(&mut frame);
            return Ok(Some(frame));
        }
        if let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            if frame.len().saturating_add(newline) > MAX_FRAME_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Pi worker frame exceeds the byte limit",
                ));
            }
            frame.extend_from_slice(&buffer[..newline]);
            reader.consume(newline + 1);
            trim_carriage_return(&mut frame);
            return Ok(Some(frame));
        }
        if frame.len().saturating_add(buffer.len()) > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Pi worker frame exceeds the byte limit",
            ));
        }
        frame.extend_from_slice(buffer);
        let consumed = buffer.len();
        reader.consume(consumed);
    }
}

fn trim_carriage_return(frame: &mut Vec<u8>) {
    if frame.last() == Some(&b'\r') {
        frame.pop();
    }
}
