use std::collections::VecDeque;

use serde_json::Value;

use super::protocol::AGENT_PROTOCOL_VERSION;

const MAX_SEEN_EVENT_IDS: usize = 4096;

/// Owns only one worker generation's volatile event-acceptance state.
/// Durable duplicate decisions remain with SQLite in the runtime reader.
#[derive(Default)]
pub(super) struct PiWorkerEventAcceptance {
    worker_epoch: Option<String>,
    last_seq: Option<u64>,
    /// Exact payloads let immediate duplicates bypass sequence checks. Older
    /// events fall through to runtime persistence and SQLite arbitration.
    seen_events: VecDeque<(String, Value)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EventAcceptance {
    New { ready_event: bool },
    Duplicate,
}

impl PiWorkerEventAcceptance {
    pub(super) fn accept(&mut self, value: &Value) -> Result<EventAcceptance, String> {
        let event_id = value
            .get("eventId")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "Pi worker eventId must be a non-empty string".to_string())?;
        if let Some((_, previous)) = self.seen_events.iter().find(|(id, _)| id == event_id) {
            if previous != value {
                return Err(format!(
                    "Pi worker event {event_id} was replayed with a different payload"
                ));
            }
            return Ok(EventAcceptance::Duplicate);
        }

        let ready_event =
            validate_event_metadata(value, &mut self.worker_epoch, &mut self.last_seq)?;
        self.seen_events
            .push_back((event_id.to_string(), value.clone()));
        while self.seen_events.len() > MAX_SEEN_EVENT_IDS {
            self.seen_events.pop_front();
        }
        Ok(EventAcceptance::New { ready_event })
    }
}

fn validate_event_metadata(
    value: &Value,
    worker_epoch: &mut Option<String>,
    last_seq: &mut Option<u64>,
) -> Result<bool, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Pi worker event must be an object".to_string())?;
    if object.get("protocolVersion").and_then(Value::as_u64) != Some(AGENT_PROTOCOL_VERSION) {
        return Err("Pi worker event uses an unsupported protocol version".to_string());
    }
    if object.get("replay").and_then(Value::as_bool).is_none() {
        return Err("Pi worker event.replay must be a boolean".to_string());
    }
    match object.get("workerEpoch") {
        Some(Value::String(value)) if !value.trim().is_empty() => {
            if let Some(expected) = worker_epoch {
                if expected != value {
                    return Err("Pi worker epoch changed while the process was running".to_string());
                }
            } else {
                *worker_epoch = Some(value.clone());
            }
        }
        Some(_) => return Err("Pi worker workerEpoch must be a non-empty string".to_string()),
        None if worker_epoch.is_some() => {
            return Err("Pi worker workerEpoch is missing from a later event".to_string());
        }
        None => {}
    }
    if let Some(value) = object.get("seq") {
        let sequence = value
            .as_u64()
            .ok_or_else(|| "Pi worker event.seq must be a non-negative integer".to_string())?;
        if let Some(previous) = last_seq
            && sequence <= *previous
        {
            return Err("Pi worker event.seq is not strictly increasing".to_string());
        }
        *last_seq = Some(sequence);
    }
    let event_type = object
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("type"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Pi worker event.type is required".to_string())?;
    Ok(event_type == "runtime.ready")
}

pub(super) fn is_sequence_violation(error: &str) -> bool {
    error == "Pi worker event.seq is not strictly increasing"
        || error.starts_with("Pi worker event.seq")
}
