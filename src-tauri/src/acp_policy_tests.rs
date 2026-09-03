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
        inspect_server_response(&json!({ "result": { "outcome": "unknown" } }), &request,).is_err()
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
