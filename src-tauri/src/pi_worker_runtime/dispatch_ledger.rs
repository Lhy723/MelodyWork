//! Correlates Host-initiated turn acknowledgements and worker session revisions.
//! Process I/O and schedule-journal decisions remain with their existing owners.

use std::{collections::HashMap, sync::Mutex};

use serde_json::Value;
use tokio::sync::oneshot;

const MAX_PENDING_DISPATCHES: usize = 32;
/// How long a Host-initiated turn may take to be acknowledged.
pub(super) const DISPATCH_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Result of asking the worker to start a Host-initiated turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TurnDispatchOutcome {
    /// The worker emitted `run.accepted` for this prompt.
    Accepted,
    /// The worker refused the command with a structured error.
    Rejected { code: String, message: String },
    /// No acknowledgement arrived before the deadline; the turn may or may not
    /// have started, so the caller must not report success.
    Unacknowledged,
}

#[derive(Default)]
pub(super) struct DispatchLedger {
    pending: Mutex<HashMap<String, PendingDispatch>>,
    session_revisions: Mutex<HashMap<String, i64>>,
}

struct PendingDispatch {
    request_id: String,
    completion: oneshot::Sender<TurnDispatchOutcome>,
}

impl DispatchLedger {
    pub(super) fn begin(
        &self,
        prompt_id: &str,
        request_id: &str,
    ) -> Result<oneshot::Receiver<TurnDispatchOutcome>, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Pi dispatch state is unavailable".to_string())?;
        if pending.len() >= MAX_PENDING_DISPATCHES {
            return Err(format!(
                "too many Host-initiated turns are awaiting acknowledgement (limit {MAX_PENDING_DISPATCHES})"
            ));
        }
        let (completion, receiver) = oneshot::channel();
        pending.insert(
            prompt_id.to_string(),
            PendingDispatch {
                request_id: request_id.to_string(),
                completion,
            },
        );
        Ok(receiver)
    }

    pub(super) fn observe_event(&self, value: &Value) {
        let Some(event) = value.get("event").and_then(Value::as_object) else {
            return;
        };
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type == "runtime.error" {
            let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let error = event.get("error");
            let outcome = TurnDispatchOutcome::Rejected {
                code: error
                    .and_then(|error| error.get("code"))
                    .and_then(Value::as_str)
                    .unwrap_or("pi.worker_error")
                    .to_string(),
                message: error
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Pi worker rejected the command")
                    .to_string(),
            };
            self.complete_by_request(request_id, outcome);
            return;
        }
        if matches!(
            event_type,
            "session.opened" | "session.configured" | "session.imported"
        ) && let (Some(session_id), Some(revision)) = (
            value.get("sessionId").and_then(Value::as_str),
            event.get("revision").and_then(Value::as_i64),
        ) {
            if let Ok(mut revisions) = self.session_revisions.lock() {
                revisions.insert(session_id.to_string(), revision);
            }
        }
        if event_type != "run.accepted" {
            return;
        }
        let Some(prompt_id) = event.get("promptId").and_then(Value::as_str) else {
            return;
        };
        if let Ok(mut pending) = self.pending.lock()
            && let Some(dispatch) = pending.remove(prompt_id)
        {
            let _ = dispatch.completion.send(TurnDispatchOutcome::Accepted);
        }
    }

    fn complete_by_request(&self, request_id: &str, outcome: TurnDispatchOutcome) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        let prompt_id = pending
            .iter()
            .find(|(_, dispatch)| dispatch.request_id == request_id)
            .map(|(prompt_id, _)| prompt_id.clone());
        if let Some(prompt_id) = prompt_id
            && let Some(dispatch) = pending.remove(&prompt_id)
        {
            let _ = dispatch.completion.send(outcome);
        }
    }

    pub(super) fn clear_generation(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, dispatch) in pending.drain() {
                let _ = dispatch
                    .completion
                    .send(TurnDispatchOutcome::Unacknowledged);
            }
        }
        if let Ok(mut revisions) = self.session_revisions.lock() {
            revisions.clear();
        }
    }

    pub(super) fn clear_prompt(&self, prompt_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(prompt_id);
        }
    }

    pub(super) fn session_config_revision(&self, session_id: &str) -> i64 {
        self.session_revisions
            .lock()
            .ok()
            .and_then(|revisions| revisions.get(session_id).copied())
            .unwrap_or(0)
    }
}
