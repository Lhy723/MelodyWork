use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use serde_json::Value;

const MAX_ACP_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_PENDING_SERVER_REQUESTS: usize = 256;
const PENDING_SERVER_REQUEST_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClientRequestAction {
    None,
    OpenSession {
        cwd: String,
        elevated_mode: Option<String>,
    },
    ChangePermissionMode {
        mode: String,
        requires_confirmation: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum OutgoingMessage {
    Request(ClientRequestAction),
    Response { id: Value },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ServerResponseAction {
    None,
    ConfirmPermission,
}

#[derive(Clone, Debug)]
pub(crate) struct PendingServerRequest {
    method: String,
    session_id: Option<String>,
    title: String,
    command: String,
    allow_option_ids: HashSet<String>,
    reject_option_ids: HashSet<String>,
    created_at: Instant,
}

impl PendingServerRequest {
    pub(crate) fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub(crate) fn title(&self) -> &str {
        &self.title
    }

    pub(crate) fn command(&self) -> &str {
        &self.command
    }
}

#[derive(Default)]
pub(crate) struct PendingServerRequests {
    requests: HashMap<String, PendingServerRequest>,
}

impl PendingServerRequests {
    pub(crate) fn remember(&mut self, message: &Value) {
        self.remember_at(message, Instant::now());
    }

    fn remember_at(&mut self, message: &Value, now: Instant) {
        let Some(id) = message.get("id") else {
            return;
        };
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        let Ok(key) = serde_json::to_string(id) else {
            return;
        };
        let params = message.get("params").and_then(Value::as_object);
        let tool = params
            .and_then(|params| params.get("toolCall").or_else(|| params.get("tool_call")))
            .and_then(Value::as_object);
        let title = tool
            .and_then(|tool| tool.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("工具调用")
            .trim()
            .to_string();
        let command = tool
            .and_then(|tool| tool.get("command"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let mut allow_option_ids = HashSet::new();
        let mut reject_option_ids = HashSet::new();
        if method == "session/request_permission"
            && let Some(options) = params
                .and_then(|params| params.get("options"))
                .and_then(Value::as_array)
        {
            for option in options {
                let Some(option) = option.as_object() else {
                    continue;
                };
                let Some(option_id) = option
                    .get("optionId")
                    .or_else(|| option.get("option_id"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                let kind = option
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if kind.starts_with("allow") {
                    allow_option_ids.insert(option_id.to_string());
                } else if kind.starts_with("reject") {
                    reject_option_ids.insert(option_id.to_string());
                }
            }
        }
        let session_id = session_id(params).map(str::to_string);

        self.requests.retain(|_, request| {
            now.saturating_duration_since(request.created_at) < PENDING_SERVER_REQUEST_TTL
        });
        if self.requests.len() >= MAX_PENDING_SERVER_REQUESTS
            && let Some(oldest) = self
                .requests
                .iter()
                .min_by_key(|(_, request)| request.created_at)
                .map(|(key, _)| key.clone())
        {
            self.requests.remove(&oldest);
        }
        self.requests.insert(
            key,
            PendingServerRequest {
                method: method.to_string(),
                session_id,
                title,
                command,
                allow_option_ids,
                reject_option_ids,
                created_at: now,
            },
        );
    }

    pub(crate) fn take(&mut self, id: &Value) -> Option<PendingServerRequest> {
        let key = serde_json::to_string(id).ok()?;
        self.requests.remove(&key)
    }

    pub(crate) fn restore(&mut self, id: &Value, request: PendingServerRequest) {
        if let Ok(key) = serde_json::to_string(id) {
            self.requests.insert(key, request);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.requests.clear();
    }
}

pub(crate) fn inspect_outgoing_message(message: &Value) -> Result<OutgoingMessage, String> {
    let encoded = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_ACP_MESSAGE_BYTES {
        return Err("ACP message exceeds the 1 MB safety limit".to_string());
    }
    let object = message
        .as_object()
        .ok_or_else(|| "ACP message must be a JSON object".to_string())?;
    if object.contains_key("raw") {
        return Err("Raw ACP messages are not accepted".to_string());
    }
    if let Some(version) = object.get("jsonrpc")
        && version.as_str() != Some("2.0")
    {
        return Err("Only JSON-RPC 2.0 ACP messages are accepted".to_string());
    }

    if let Some(method) = object.get("method").and_then(Value::as_str) {
        return inspect_client_request(method, object.get("params").and_then(Value::as_object))
            .map(OutgoingMessage::Request);
    }

    let id = object
        .get("id")
        .cloned()
        .ok_or_else(|| "ACP responses must include id".to_string())?;
    if !object.contains_key("result") && !object.contains_key("error") {
        return Err("ACP message must contain method, result, or error".to_string());
    }
    if object.contains_key("result") && object.contains_key("error") {
        return Err("ACP response cannot contain both result and error".to_string());
    }
    Ok(OutgoingMessage::Response { id })
}

fn inspect_client_request(
    method: &str,
    params: Option<&serde_json::Map<String, Value>>,
) -> Result<ClientRequestAction, String> {
    if !matches!(
        method,
        "initialize"
            | "authenticate"
            | "session/new"
            | "session/load"
            | "session/prompt"
            | "session/cancel"
            | "session/set_model"
            | "session/set_mode"
            | "x.ai/queue/interject"
            | "x.ai/yolo_mode_changed"
    ) {
        return Err(format!("ACP method is not allowed: {method}"));
    }

    match method {
        "session/new" | "session/load" => {
            let cwd = params
                .and_then(|params| params.get("cwd"))
                .and_then(Value::as_str)
                .ok_or_else(|| "ACP session requests must include cwd".to_string())?;
            if let Some(servers) = params.and_then(|params| {
                params
                    .get("mcpServers")
                    .or_else(|| params.get("mcp_servers"))
            }) && !servers.as_array().is_some_and(Vec::is_empty)
            {
                return Err(
                    "ACP MCP server injection is disabled; configure servers in Melody instead"
                        .to_string(),
                );
            }
            let meta = params
                .and_then(|params| params.get("_meta"))
                .and_then(Value::as_object);
            let elevated_mode = if value_bool(meta, &["yoloMode", "yolo_mode"]) {
                Some("always-approve".to_string())
            } else if value_bool(meta, &["autoMode", "auto_mode"]) {
                Some("auto".to_string())
            } else {
                None
            };
            Ok(ClientRequestAction::OpenSession {
                cwd: cwd.to_string(),
                elevated_mode,
            })
        }
        "session/prompt" | "session/cancel" | "session/set_model" | "session/set_mode" => {
            if session_id(params).is_none() {
                return Err(format!("ACP {method} requests must include sessionId"));
            }
            Ok(ClientRequestAction::None)
        }
        "x.ai/queue/interject" => {
            if session_id(params).is_none() {
                return Err("ACP interject requests must include sessionId".to_string());
            }
            Ok(ClientRequestAction::None)
        }
        "x.ai/yolo_mode_changed" => {
            let mode = params
                .and_then(|params| {
                    params
                        .get("permission_mode")
                        .or_else(|| params.get("permissionMode"))
                })
                .and_then(Value::as_str)
                .ok_or_else(|| "Permission mode is missing".to_string())?;
            if !matches!(mode, "ask" | "auto" | "always-approve") {
                return Err("Permission mode is invalid".to_string());
            }
            Ok(ClientRequestAction::ChangePermissionMode {
                mode: mode.to_string(),
                requires_confirmation: mode != "ask",
            })
        }
        _ => Ok(ClientRequestAction::None),
    }
}

pub(crate) fn inspect_server_response(
    message: &Value,
    pending: &PendingServerRequest,
) -> Result<ServerResponseAction, String> {
    let object = message
        .as_object()
        .ok_or_else(|| "ACP message must be a JSON object".to_string())?;
    match pending.method.as_str() {
        "session/request_permission" => {
            if object.contains_key("error") {
                return Ok(ServerResponseAction::None);
            }
            let result = object
                .get("result")
                .and_then(Value::as_object)
                .ok_or_else(|| "Permission response result is invalid".to_string())?;
            let outcome = result
                .get("outcome")
                .and_then(Value::as_object)
                .ok_or_else(|| "Permission response outcome is invalid".to_string())?;
            if outcome.get("outcome").and_then(Value::as_str) != Some("selected") {
                return Err("Permission response must select an option".to_string());
            }
            let option_id = outcome
                .get("optionId")
                .or_else(|| outcome.get("option_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| "Permission response optionId is missing".to_string())?;
            if pending.reject_option_ids.contains(option_id) {
                return Ok(ServerResponseAction::None);
            }
            if !pending.allow_option_ids.contains(option_id) {
                return Err("Permission response selected an unknown option".to_string());
            }
            Ok(ServerResponseAction::ConfirmPermission)
        }
        "x.ai/exit_plan_mode" => {
            if object.contains_key("error") {
                return Ok(ServerResponseAction::None);
            }
            let outcome = object
                .get("result")
                .and_then(|result| result.get("outcome"))
                .and_then(Value::as_str)
                .ok_or_else(|| "Plan response outcome is missing".to_string())?;
            if matches!(
                outcome,
                "approved" | "cancelled" | "abandoned" | "changes-requested"
            ) {
                Ok(ServerResponseAction::None)
            } else {
                Err("Plan response outcome is invalid".to_string())
            }
        }
        "x.ai/ask_user_question" | "_x.ai/ask_user_question" => inspect_question_response(object),
        method => Err(format!(
            "Responses to ACP method {method} are not supported"
        )),
    }
}

fn value_bool(object: Option<&serde_json::Map<String, Value>>, names: &[&str]) -> bool {
    names.iter().any(|name| {
        object
            .and_then(|object| object.get(*name))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    })
}

fn session_id(params: Option<&serde_json::Map<String, Value>>) -> Option<&str> {
    let params = params?;
    params
        .get("sessionId")
        .or_else(|| params.get("session_id"))
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get("params")
                .and_then(Value::as_object)
                .and_then(|nested| nested.get("sessionId").or_else(|| nested.get("session_id")))
                .and_then(Value::as_str)
        })
}

fn inspect_question_response(
    object: &serde_json::Map<String, Value>,
) -> Result<ServerResponseAction, String> {
    if object.contains_key("error") {
        return Ok(ServerResponseAction::None);
    }
    let result = object
        .get("result")
        .and_then(Value::as_object)
        .ok_or_else(|| "Question response result is invalid".to_string())?;
    let outcome = result
        .get("outcome")
        .and_then(Value::as_str)
        .ok_or_else(|| "Question response outcome is missing".to_string())?;
    match outcome {
        "accepted" => {
            let answers = result
                .get("answers")
                .and_then(Value::as_object)
                .ok_or_else(|| "Question response answers are missing".to_string())?;
            for answer in answers.values() {
                let valid = answer.as_str().is_some()
                    || answer
                        .as_array()
                        .is_some_and(|values| values.iter().all(Value::is_string));
                if !valid {
                    return Err("Question response answers must be strings".to_string());
                }
            }
            if let Some(annotations) = result.get("annotations") {
                let Some(annotations) = annotations.as_object() else {
                    return Err("Question response annotations are invalid".to_string());
                };
                for annotation in annotations.values() {
                    let Some(annotation) = annotation.as_object() else {
                        return Err("Question response annotation is invalid".to_string());
                    };
                    for key in ["preview", "notes"] {
                        if let Some(value) = annotation.get(key)
                            && !value.is_string()
                        {
                            return Err("Question response annotation text is invalid".to_string());
                        }
                    }
                }
            }
            Ok(ServerResponseAction::None)
        }
        "chat_about_this" | "skip_interview" => {
            if let Some(partial_answers) = result
                .get("partial_answers")
                .or_else(|| result.get("partialAnswers"))
                && !partial_answers
                    .as_object()
                    .is_some_and(|answers| answers.values().all(Value::is_string))
            {
                return Err("Question response partial answers are invalid".to_string());
            }
            Ok(ServerResponseAction::None)
        }
        "cancelled" => Ok(ServerResponseAction::None),
        _ => Err("Question response outcome is invalid".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn permission_request(id: usize) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "toolCall": { "title": "Run tests", "command": "pnpm test" },
                "options": [
                    { "optionId": "allow-once", "kind": "allow_once" },
                    { "optionId": "reject-once", "kind": "reject_once" }
                ]
            }
        })
    }

    fn question_request(id: usize, method: &str) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": {
                "sessionId": "session-1",
                "toolCallId": "question-1",
                "questions": [{
                    "question": "Which database?",
                    "options": [{ "label": "SQLite", "description": "Local" }]
                }],
                "mode": "default"
            }
        })
    }

    #[test]
    fn validates_session_bound_requests_and_blocks_mcp_injection() {
        assert!(
            inspect_outgoing_message(&json!({
                "method": "session/cancel",
                "params": { "sessionId": "session-1" }
            }))
            .is_ok()
        );
        assert!(inspect_outgoing_message(&json!({ "method": "session/cancel" })).is_err());
        assert!(
            inspect_outgoing_message(&json!({
                "method": "session/new",
                "params": { "cwd": "/tmp/project", "mcpServers": [{ "name": "other" }] }
            }))
            .is_err()
        );
    }

    #[test]
    fn reports_host_actions_for_privileged_modes() {
        assert_eq!(
            inspect_outgoing_message(&json!({
                "method": "session/new",
                "params": { "cwd": "/tmp/project", "_meta": { "yoloMode": true } }
            }))
            .unwrap(),
            OutgoingMessage::Request(ClientRequestAction::OpenSession {
                cwd: "/tmp/project".to_string(),
                elevated_mode: Some("always-approve".to_string()),
            })
        );
        assert_eq!(
            inspect_outgoing_message(&json!({
                "method": "x.ai/yolo_mode_changed",
                "params": { "permission_mode": "ask" }
            }))
            .unwrap(),
            OutgoingMessage::Request(ClientRequestAction::ChangePermissionMode {
                mode: "ask".to_string(),
                requires_confirmation: false,
            })
        );
    }

    #[test]
    fn only_allows_known_permission_choices() {
        let mut pending = PendingServerRequests::default();
        pending.remember(&permission_request(1));
        let request = pending.take(&json!(1)).unwrap();

        assert_eq!(
            inspect_server_response(
                &json!({
                    "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } }
                }),
                &request,
            )
            .unwrap(),
            ServerResponseAction::ConfirmPermission
        );
        assert_eq!(
            inspect_server_response(
                &json!({
                    "result": { "outcome": { "outcome": "selected", "optionId": "reject-once" } }
                }),
                &request,
            )
            .unwrap(),
            ServerResponseAction::None
        );
        assert!(
            inspect_server_response(
                &json!({
                    "result": { "outcome": { "outcome": "selected", "optionId": "unknown" } }
                }),
                &request,
            )
            .is_err()
        );
    }

    #[test]
    fn validates_user_question_responses() {
        let mut pending = PendingServerRequests::default();
        pending.remember(&question_request(2, "x.ai/ask_user_question"));
        let request = pending.take(&json!(2)).unwrap();

        assert_eq!(
            inspect_server_response(
                &json!({
                    "result": {
                        "outcome": "accepted",
                        "answers": { "Which database?": ["SQLite"] },
                        "annotations": { "Which database?": { "notes": "local" } }
                    }
                }),
                &request,
            )
            .unwrap(),
            ServerResponseAction::None
        );
        assert!(
            inspect_server_response(
                &json!({
                    "result": { "outcome": "accepted", "answers": { "Which database?": [1] } }
                }),
                &request,
            )
            .is_err()
        );
        assert!(
            inspect_server_response(
                &json!({
                    "result": {
                        "outcome": "accepted",
                        "answers": { "Which database?": ["SQLite"] },
                        "annotations": { "Which database?": { "notes": 1 } }
                    }
                }),
                &request,
            )
            .is_err()
        );
        assert!(
            inspect_server_response(
                &json!({
                    "result": { "outcome": "chat_about_this", "partial_answers": {} }
                }),
                &request,
            )
            .is_ok()
        );
        assert!(
            inspect_server_response(&json!({ "result": { "outcome": "unknown" } }), &request,)
                .is_err()
        );
    }

    #[test]
    fn remembers_wrapped_question_session_id() {
        let mut pending = PendingServerRequests::default();
        pending.remember(&json!({
            "id": "wrapped-1",
            "method": "_x.ai/ask_user_question",
            "params": {
                "method": "x.ai/ask_user_question",
                "params": {
                    "sessionId": "session-wrapped",
                    "toolCallId": "question-wrapped",
                    "questions": [{ "question": "Continue?", "options": [] }]
                }
            }
        }));
        assert_eq!(
            pending.take(&json!("wrapped-1")).unwrap().session_id(),
            Some("session-wrapped")
        );
    }

    #[test]
    fn pending_requests_expire_and_are_bounded() {
        let start = Instant::now();
        let mut pending = PendingServerRequests::default();
        pending.remember_at(&permission_request(0), start);
        pending.remember_at(&permission_request(1), start + PENDING_SERVER_REQUEST_TTL);
        assert!(pending.take(&json!(0)).is_none());

        pending.clear();
        pending.remember_at(&permission_request(1), start);
        for id in 2..=MAX_PENDING_SERVER_REQUESTS + 2 {
            pending.remember_at(
                &permission_request(id),
                start + Duration::from_millis(id as u64),
            );
        }
        assert_eq!(pending.requests.len(), MAX_PENDING_SERVER_REQUESTS);
        assert!(pending.take(&json!(1)).is_none());
    }
}
