//! Stable Pi tool names and the Host-side policy projection for worker events.

use serde_json::{Value, json};

pub(crate) const WORKSPACE_READ_FILE: &str = "workspace_read_file";
pub(crate) const WORKSPACE_READ_TOOL_OUTPUT: &str = "workspace_read_tool_output";
pub(crate) const WORKSPACE_SEARCH: &str = "workspace_search";
pub(crate) const WORKSPACE_LIST_DIRECTORY: &str = "workspace_list_directory";
pub(crate) const WORKSPACE_WRITE_FILE: &str = "workspace_write_file";
pub(crate) const WORKSPACE_EDIT: &str = "workspace_edit";
pub(crate) const WORKSPACE_APPLY_PATCH: &str = "workspace_apply_patch";
pub(crate) const RUN_TERMINAL_COMMAND: &str = "run_terminal_command";
/// Melody-build's streaming monitor tool: every output line becomes a
/// conversation notification. It is Host-owned because it starts a process.
pub(crate) const MONITOR: &str = "monitor";
/// Melody's scheduler tools, kept under their original names so a skill that
/// schedules work keeps working on the Pi path.
pub(crate) const SCHEDULER_CREATE: &str = "scheduler_create";
pub(crate) const SCHEDULER_LIST: &str = "scheduler_list";
pub(crate) const SCHEDULER_DELETE: &str = "scheduler_delete";
pub(crate) const ASK_USER_QUESTION: &str = "ask_user_question";
pub(crate) const UPDATE_PLAN: &str = "update_plan";
pub(crate) const SPAWN_SUBAGENT: &str = "spawn_subagent";
pub(crate) const RUN_BACKGROUND_TASK: &str = "run_background_task";
pub(crate) const GET_COMMAND_OR_SUBAGENT_OUTPUT: &str = "get_command_or_subagent_output";
pub(crate) const WAIT_COMMANDS_OR_SUBAGENTS: &str = "wait_commands_or_subagents";
pub(crate) const KILL_COMMAND_OR_SUBAGENT: &str = "kill_command_or_subagent";
pub(crate) const MCP_LIST_TOOLS: &str = "mcp_list_tools";
pub(crate) const MCP_CALL_TOOL: &str = "mcp_call_tool";
pub(crate) const WEB_SEARCH: &str = "web_search";
pub(crate) const WEB_FETCH: &str = "web_fetch";
pub(crate) const BROWSER_NAVIGATE: &str = "browser_navigate";
pub(crate) const BROWSER_TABS: &str = "browser_tabs";
pub(crate) const BROWSER_SNAPSHOT: &str = "browser_snapshot";
pub(crate) const BROWSER_WAIT: &str = "browser_wait";
pub(crate) const BROWSER_SCREENSHOT: &str = "browser_screenshot";
pub(crate) const BROWSER_CLICK: &str = "browser_click";
pub(crate) const BROWSER_TYPE: &str = "browser_type";
pub(crate) const BROWSER_TAB_OPEN: &str = "browser_tab_open";
pub(crate) const BROWSER_TAB_SELECT: &str = "browser_tab_select";
pub(crate) const BROWSER_TAB_CLOSE: &str = "browser_tab_close";
pub(crate) const MEMORY_SEARCH: &str = "memory_search";
pub(crate) const MEMORY_GET: &str = "memory_get";
pub(crate) const MEMORY_REMEMBER: &str = "memory_remember";
/// Internal worker-to-Host operation used only for explicitly isolated subagents.
pub(crate) const CREATE_SUBAGENT_WORKTREE: &str = "workspace_create_subagent_worktree";
/// Internal worker preflight for path-scoped project instruction files.
pub(crate) const INSTRUCTION_SCOPE_LOOKUP: &str = "melody_internal_instruction_scope";

pub(super) fn mutating_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        WORKSPACE_WRITE_FILE
            | WORKSPACE_EDIT
            | WORKSPACE_APPLY_PATCH
            | RUN_TERMINAL_COMMAND
            // A monitor starts a long-running process, so it is authorized
            // exactly like a terminal command: never silently approved.
            | MONITOR
            // Creating or cancelling a timer changes future autonomous work.
            | SCHEDULER_CREATE
            | SCHEDULER_DELETE
            | MCP_CALL_TOOL
            | BROWSER_NAVIGATE
            | BROWSER_CLICK
            | BROWSER_TYPE
    )
}

fn error_value(code: &str, message: impl Into<String>) -> Value {
    let message = message.into();
    json!({
        "code": code,
        "message": message,
        "retriable": false,
        "scope": "tool"
    })
}

pub(crate) fn fail_resolution(
    session_id: &str,
    run_id: Option<&str>,
    tool_call_id: &str,
    code: &str,
    message: impl Into<String>,
) -> Value {
    let mut command = json!({
        "type": "tool.resolve",
        "sessionId": session_id,
        "toolCallId": tool_call_id,
        "resolution": {
            "status": "failed",
            "error": error_value(code, message)
        }
    });
    if let Some(run_id) = run_id {
        command["runId"] = Value::String(run_id.to_string());
    }
    command
}

pub(super) fn success_resolution(
    session_id: &str,
    run_id: Option<&str>,
    tool_call_id: &str,
    output: String,
) -> Value {
    let mut command = json!({
        "type": "tool.resolve",
        "sessionId": session_id,
        "toolCallId": tool_call_id,
        "resolution": { "status": "completed", "output": output }
    });
    if let Some(run_id) = run_id {
        command["runId"] = Value::String(run_id.to_string());
    }
    command
}

pub(crate) fn event_context(
    value: &Value,
) -> Result<(&str, Option<&str>, &str, &str, &Value, &Value), String> {
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "tool.requested.sessionId is required".to_string())?;
    let run_id = value.get("runId").and_then(Value::as_str);
    let event = value
        .get("event")
        .and_then(Value::as_object)
        .ok_or_else(|| "tool.requested.event is required".to_string())?;
    let tool_call_id = event
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "tool.requested.toolCallId is required".to_string())?;
    let tool_name = event
        .get("toolName")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "tool.requested.toolName is required".to_string())?;
    let activity = event.get("activity").unwrap_or(&Value::Null);
    let arguments = activity
        .get("activity")
        .and_then(Value::as_object)
        .and_then(|activity| activity.get("arguments"))
        .unwrap_or(&Value::Null);
    // The worker puts arguments directly under activity. Accept both the
    // current shape and the older nested shape for replay compatibility.
    let arguments = activity
        .as_object()
        .and_then(|activity| activity.get("arguments"))
        .or_else(|| {
            event
                .get("activity")
                .and_then(Value::as_object)
                .and_then(|activity| activity.get("activity"))
                .and_then(Value::as_object)
                .and_then(|activity| activity.get("arguments"))
        })
        .unwrap_or(arguments);
    Ok((
        session_id,
        run_id,
        tool_call_id,
        tool_name,
        arguments,
        activity,
    ))
}

/// Return the MCP operation represented by a worker tool request.  Keeping
/// this parser at the gateway boundary lets the worker runtime route MCP to
/// the Host bridge without duplicating the event-shape compatibility logic.
pub(crate) fn mcp_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        MCP_LIST_TOOLS => Some("list"),
        MCP_CALL_TOOL => Some("call"),
        _ => None,
    }
}

/// Return the web operation represented by a worker tool request.  Network
/// access is deliberately routed separately from the filesystem gateway so
/// the Host can apply URL/domain/response limits without treating a URL as a
/// workspace path.
pub(crate) fn web_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        WEB_SEARCH => Some("search"),
        WEB_FETCH => Some("fetch"),
        _ => None,
    }
}

/// Browser requests are dispatched to the session-scoped Browser Host, never
/// interpreted as arbitrary worker-side JavaScript or network access.
pub(crate) fn browser_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        BROWSER_NAVIGATE => Some("navigate"),
        BROWSER_TABS => Some("tabs"),
        BROWSER_SNAPSHOT => Some("snapshot"),
        BROWSER_WAIT => Some("wait"),
        BROWSER_SCREENSHOT => Some("screenshot"),
        BROWSER_CLICK => Some("click"),
        BROWSER_TYPE => Some("type"),
        BROWSER_TAB_OPEN => Some("tab_open"),
        BROWSER_TAB_SELECT => Some("tab_select"),
        BROWSER_TAB_CLOSE => Some("tab_close"),
        _ => None,
    }
}

/// Defense-in-depth permission check for page navigation and DOM interaction.
/// Read-only snapshots do not require a second approval prompt.
pub(crate) fn browser_action_requires_permission(value: &Value) -> bool {
    if !matches!(
        browser_tool_kind(value),
        Some(
            "navigate" | "click" | "type" | "screenshot" | "tab_open" | "tab_select" | "tab_close"
        )
    ) {
        return false;
    }
    let (_, _, _, _, _, activity) = match event_context(value) {
        Ok(context) => context,
        Err(_) => return true,
    };
    activity.get("approved").and_then(Value::as_bool) != Some(true)
}

/// Return the memory operation represented by a worker tool request. Memory
/// reads use a dedicated Host boundary because their files live outside the
/// authorized project workspace.
pub(crate) fn memory_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        MEMORY_SEARCH => Some("search"),
        MEMORY_GET => Some("get"),
        MEMORY_REMEMBER => Some("remember"),
        _ => None,
    }
}

/// Return the Host-owned background terminal operation represented by a
/// worker request. These controls intentionally live beside the normal
/// gateway, but are resolved by the task registry instead of being treated as
/// ordinary shell commands.
pub(crate) fn background_task_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        GET_COMMAND_OR_SUBAGENT_OUTPUT => Some("get"),
        WAIT_COMMANDS_OR_SUBAGENTS => Some("wait"),
        KILL_COMMAND_OR_SUBAGENT => Some("kill"),
        _ => None,
    }
}

/// Return whether a worker request is the internal isolated-worktree bridge.
/// Keeping this parser beside the other Host-owned operations prevents the
/// generic file gateway from ever treating a task id as a shell/path input.
pub(crate) fn subagent_worktree_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    (tool_name == CREATE_SUBAGENT_WORKTREE).then_some("create")
}

pub(crate) fn tool_request_arguments(
    value: &Value,
) -> Result<(&str, &serde_json::Map<String, Value>), String> {
    let (_, _, _, tool_name, arguments, _) = event_context(value)?;
    Ok((
        tool_name,
        arguments
            .as_object()
            .ok_or_else(|| "tool.requested.activity.arguments must be an object".to_string())?,
    ))
}

pub(crate) fn is_instruction_scope_request(value: &Value) -> bool {
    event_context(value)
        .map(|context| context.3 == INSTRUCTION_SCOPE_LOOKUP)
        .unwrap_or(false)
}

pub(crate) fn mcp_call_requires_permission(value: &Value) -> bool {
    if mcp_tool_kind(value) != Some("call") {
        return false;
    }
    let (_, _, _, _, _, activity) = match event_context(value) {
        Ok(context) => context,
        Err(_) => return true,
    };
    activity
        .get("permissionMode")
        .and_then(Value::as_str)
        .unwrap_or("ask")
        == "ask"
        && activity.get("approved").and_then(Value::as_bool) != Some(true)
}

/// Return whether a durable memory write still needs the interactive
/// permission gate. Memory files live outside the workspace, so they bypass
/// the normal mutating-tool matcher below; keep the same ask/approved
/// semantics explicitly at the Host routing boundary.
pub(crate) fn memory_write_requires_permission(value: &Value) -> bool {
    if memory_tool_kind(value) != Some("remember") {
        return false;
    }
    let (_, _, _, _, _, activity) = match event_context(value) {
        Ok(context) => context,
        Err(_) => return true,
    };
    activity
        .get("permissionMode")
        .and_then(Value::as_str)
        .unwrap_or("ask")
        == "ask"
        && activity.get("approved").and_then(Value::as_bool) != Some(true)
}

pub(crate) fn success_for_request(value: &Value, output: String) -> Value {
    match event_context(value) {
        Ok((session_id, run_id, tool_call_id, _, _, _)) => {
            success_resolution(session_id, run_id, tool_call_id, output)
        }
        Err(error) => fail_for_request(value, "pi.invalid_tool_request", error),
    }
}

pub(crate) fn fail_for_request(value: &Value, code: &str, message: impl Into<String>) -> Value {
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let run_id = value.get("runId").and_then(Value::as_str);
    let tool_call_id = value
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("toolCallId"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    fail_resolution(session_id, run_id, tool_call_id, code, message)
}

pub(crate) fn is_tool_request(value: &Value) -> bool {
    value
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("type"))
        .and_then(Value::as_str)
        == Some("tool.requested")
}

/// Return the stable permission identity used by the renderer's persisted
/// project rules (`title\\ncommand`). Pi permission interactions include a
/// minimal `rawInput` object so that this identity does not depend on the
/// complete file contents or patch body.
fn permission_command(raw_input: &Value) -> String {
    let Some(raw_input) = raw_input.as_object() else {
        return String::new();
    };
    raw_input
        .get("command")
        .or_else(|| raw_input.get("cmd"))
        .or_else(|| raw_input.get("path"))
        .or_else(|| raw_input.get("scope"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| serde_json::to_string_pretty(raw_input).unwrap_or_default())
}

fn permission_identity(title: &str, raw_input: &Value) -> String {
    let command = if title.trim() == WORKSPACE_APPLY_PATCH {
        "apply_patch".to_string()
    } else {
        permission_command(raw_input)
    };
    format!("{}\\n{}", title.trim(), command.trim())
}

/// Return the project-rule key for a `tool.requested` event. This is used by
/// the Host as a defense-in-depth check even when the worker normally emits
/// `approved: true` after resolving the preceding permission interaction.
pub(crate) fn permission_tool_key(value: &Value) -> Option<String> {
    let (_, _, _, tool_name, arguments, _) = event_context(value).ok()?;
    Some(permission_identity(tool_name, arguments))
}

/// Extract a pending permission interaction and its project-rule key. The
/// returned strings are owned because the lookup/auto-resolution runs after
/// the stdout reader has moved on to later events.
pub(crate) fn permission_interaction(value: &Value) -> Option<(String, String, String)> {
    // Replayed historical interactions have no pending worker promise to
    // resolve. They are display-only and must not receive a fresh command.
    if value.get("replay").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    let event = value.get("event").and_then(Value::as_object)?;
    if event.get("type").and_then(Value::as_str) != Some("interaction.requested")
        || event.get("kind").and_then(Value::as_str) != Some("permission")
    {
        return None;
    }
    let interaction_id = event
        .get("interactionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    let payload = event.get("payload").and_then(Value::as_object)?;
    let tool = payload
        .get("toolCall")
        .or_else(|| payload.get("tool_call"))
        .and_then(Value::as_object)
        .unwrap_or(payload);
    let title = tool
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("工具调用");
    let raw_input = tool.get("rawInput").or_else(|| tool.get("raw_input"));
    let key = permission_identity(title, raw_input.unwrap_or(&Value::Null));
    Some((session_id.to_string(), interaction_id.to_string(), key))
}

/// Return the worker-reported session working directory. The Host must still
/// authorize this path through `WorkspaceRegistry`; the worker value is only
/// routing metadata and is never trusted on its own.
pub(crate) fn requested_cwd(value: &Value) -> Option<&str> {
    let activity = value
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("activity"))
        .and_then(Value::as_object)?;
    activity
        .get("cwd")
        .or_else(|| {
            activity
                .get("activity")
                .and_then(Value::as_object)
                .and_then(|nested| nested.get("cwd"))
        })
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
}

pub(crate) fn fail_for_workspace(value: &Value, message: impl Into<String>) -> Value {
    fail_for_request(value, "pi.workspace_unauthorized", message)
}

pub(crate) fn deny_for_persisted_permission(value: &Value) -> Value {
    fail_for_request(
        value,
        "pi.permission_denied",
        "项目权限规则拒绝了这次工具调用。",
    )
}

pub(crate) fn permission_required_for_request(value: &Value) -> Value {
    fail_for_request(
        value,
        "pi.permission_required",
        "该工具需要用户授权后才能执行。",
    )
}
