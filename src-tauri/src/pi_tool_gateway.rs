//! Host-owned, policy-checked tools exposed to the opt-in Pi worker.
//!
//! The worker is intentionally not given a filesystem implementation. It
//! emits a normalized tool.requested event and this module turns the bounded,
//! allowlisted request into a tool.resolve command. Every path is checked
//! against the worker's authorized workspace root before it is read or
//! changed; terminal execution is likewise bounded and audited by the Host.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};

use serde_json::{Map, Value};

use crate::config_core::PiTerminalPolicy;

mod instruction_scopes;
mod monitor_tools;
mod request_policy;
mod scheduler_tools;
mod subagent_worktrees;
mod terminal_tasks;
mod workspace_paths;
mod workspace_tools;
pub(crate) use instruction_scopes::resolve_instruction_scope_request;
pub(crate) use request_policy::{
    ASK_USER_QUESTION, BROWSER_CLICK, BROWSER_NAVIGATE, BROWSER_SCREENSHOT, BROWSER_SNAPSHOT,
    BROWSER_TAB_CLOSE, BROWSER_TAB_OPEN, BROWSER_TAB_SELECT, BROWSER_TABS, BROWSER_TYPE,
    BROWSER_WAIT, GET_COMMAND_OR_SUBAGENT_OUTPUT, KILL_COMMAND_OR_SUBAGENT, MEMORY_GET,
    MEMORY_REMEMBER, MEMORY_SEARCH, MONITOR, RUN_BACKGROUND_TASK, RUN_TERMINAL_COMMAND,
    SCHEDULER_CREATE, SCHEDULER_DELETE, SCHEDULER_LIST, SPAWN_SUBAGENT, UPDATE_PLAN,
    WAIT_COMMANDS_OR_SUBAGENTS, WEB_FETCH, WEB_SEARCH, WORKSPACE_APPLY_PATCH, WORKSPACE_EDIT,
    WORKSPACE_LIST_DIRECTORY, WORKSPACE_READ_FILE, WORKSPACE_READ_TOOL_OUTPUT, WORKSPACE_SEARCH,
    WORKSPACE_WRITE_FILE, background_task_tool_kind, browser_action_requires_permission,
    browser_tool_kind, deny_for_persisted_permission, event_context, fail_for_request,
    fail_for_workspace, fail_resolution, is_instruction_scope_request, is_tool_request,
    mcp_call_requires_permission, mcp_tool_kind, memory_tool_kind,
    memory_write_requires_permission, permission_interaction, permission_required_for_request,
    permission_tool_key, requested_cwd, subagent_worktree_tool_kind, success_for_request,
    tool_request_arguments, web_tool_kind,
};
use request_policy::{mutating_tool, success_resolution};
pub(crate) use subagent_worktrees::resolve_subagent_worktree_request;
use terminal_tasks::run_terminal_with_policy;
use workspace_tools::{
    apply_patch, edit_file, list_directory, read_file, read_tool_output, search, write_file,
};

/// A monitor command is a shell pipeline; keep it comparable to a prompt.
const GITIGNORED_ERROR_PREFIX: &str = "__melody_gitignored__:";
/// Keep the shared monitor/terminal wait cadence bounded and consistent.
const HOST_TASK_CONTROL_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Pi may execute tools from different sessions (or child sessions) in
/// parallel.  `executionMode: "sequential"` only orders calls inside one Pi
/// session, so it cannot protect a shared workspace when two sessions edit
/// the same file.  Keep one conservative mutation gate per canonical
/// workspace. Reads remain parallel, while file writes, patches and terminal
/// commands cannot interleave with one another inside the same project.
static WORKSPACE_MUTATION_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    OnceLock::new();

fn workspace_mutation_lock(root: &Path) -> Arc<Mutex<()>> {
    let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let locks = WORKSPACE_MUTATION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .expect("workspace mutation lock registry must not be poisoned");
    // Do not retain a strong reference for every workspace ever opened. The
    // operation owns the returned `Arc` while it is queued/running; once the
    // last operation finishes, an idle workspace lock can be collected.
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

fn raw_task_id_argument(arguments: &Map<String, Value>) -> Result<&str, String> {
    arguments
        .get("task_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "task_id must be a non-empty string".to_string())
}

fn task_timeout_ms(arguments: &Map<String, Value>, default_ms: u64) -> Result<u64, String> {
    let Some(value) = arguments.get("timeout_ms") else {
        return Ok(default_ms);
    };
    let timeout = value
        .as_u64()
        .ok_or_else(|| "timeout_ms must be a non-negative integer".to_string())?;
    Ok(timeout.min(120_000))
}

fn resolve_background_task_control(
    root: &Path,
    owner_session_id: &str,
    tool_name: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    // Monitor ids are Host-owned too, but they carry a different lifecycle and
    // an event stream instead of a poll buffer; the two kinds are never mixed in
    // one call so an id can only reach its own registry.
    let referenced_monitor_id = match tool_name {
        GET_COMMAND_OR_SUBAGENT_OUTPUT | KILL_COMMAND_OR_SUBAGENT => {
            raw_task_id_argument(arguments)
                .ok()
                .filter(|id| monitor_tools::monitor_task_id(id))
        }
        WAIT_COMMANDS_OR_SUBAGENTS => arguments
            .get("task_ids")
            .and_then(Value::as_array)
            .and_then(|ids| ids.iter().find_map(|id| id.as_str()))
            .filter(|id| monitor_tools::monitor_task_id(id)),
        _ => None,
    };
    if let Some(referenced) = referenced_monitor_id {
        let all_monitors = match tool_name {
            WAIT_COMMANDS_OR_SUBAGENTS => arguments
                .get("task_ids")
                .and_then(Value::as_array)
                .is_some_and(|ids| {
                    ids.iter()
                        .all(|id| id.as_str().is_some_and(monitor_tools::monitor_task_id))
                }),
            _ => true,
        };
        if !all_monitors {
            return Err(format!(
                "task_ids cannot mix monitors and terminal tasks (saw {referenced})"
            ));
        }
        return monitor_tools::resolve_monitor_task_control(tool_name, owner_session_id, arguments);
    }
    terminal_tasks::resolve_control(root, owner_session_id, tool_name, arguments)
}

/// Request cancellation for all Host-owned terminal tasks in a workspace when
/// its Pi worker is stopped. Completed tasks remain queryable until the bounded
/// registry is pruned, while live child processes receive the same cancellation
/// path as an explicit `kill_command_or_subagent` call.
pub(crate) fn cancel_background_tasks_for_workspace(root: &Path) {
    terminal_tasks::cancel_background_tasks_for_workspace(root);
}

/// Resolve a Host-owned background terminal control request. The worker only
/// receives the resulting `tool.resolve` command; it never gets access to the
/// registry or a process handle.
pub(crate) fn resolve_background_task_request(root: &Path, value: &Value) -> Value {
    let (session_id, run_id, tool_call_id, tool_name, arguments, _) = match event_context(value) {
        Ok(context) => context,
        Err(error) => return fail_for_request(value, "pi.invalid_tool_request", error),
    };
    let arguments = match arguments.as_object() {
        Some(arguments) => arguments,
        None => {
            return fail_resolution(
                session_id,
                run_id,
                tool_call_id,
                "pi.invalid_tool_request",
                "tool.requested.activity.arguments must be an object",
            );
        }
    };
    match resolve_background_task_control(root, session_id, tool_name, arguments) {
        Ok(output) => success_resolution(session_id, run_id, tool_call_id, output),
        Err(error) => fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.background_task_failed",
            error,
        ),
    }
}

/// Convert one worker tool request to a validated, bounded resolution command.
///
/// `permission_override` is supplied only by the Rust Host after looking up
/// the session's project rule. It is deliberately not read from the renderer
/// payload, so a client cannot turn an unapproved request into an approved
/// one by editing the event it sends back to the worker.
pub(crate) fn resolve_request(root: &Path, value: &Value) -> Value {
    resolve_request_with_permission(root, value, None)
}

pub(crate) fn resolve_request_with_permission(
    root: &Path,
    value: &Value,
    permission_override: Option<bool>,
) -> Value {
    resolve_request_with_policy(root, value, permission_override, None)
}

/// Resolve a request while optionally applying a Host-owned `.gitignore`
/// policy.  The worker includes `respectGitignore` as a convenience so the
/// same request shape can be replayed, but a live Host must pass the policy
/// resolved from its trusted configuration here.  When supplied, that value
/// replaces the worker field for the file tools covered by the compatibility
/// manifest, so a compromised worker cannot disable the visibility boundary.
pub(crate) fn resolve_request_with_policy(
    root: &Path,
    value: &Value,
    permission_override: Option<bool>,
    respect_gitignore_override: Option<bool>,
) -> Value {
    resolve_request_with_host_policy(
        root,
        value,
        permission_override,
        respect_gitignore_override,
        None,
        None,
    )
}

/// Resolve a request with all policy decisions that belong to the trusted
/// Host.  The worker can request a shorter timeout, but it cannot raise the
/// Host ceiling or bypass the Host-selected output preview limit.
pub(crate) fn resolve_request_with_host_policy(
    root: &Path,
    value: &Value,
    permission_override: Option<bool>,
    respect_gitignore_override: Option<bool>,
    terminal_policy_override: Option<PiTerminalPolicy>,
    // Present for a tool call that can deliver product events without a worker
    // turn (the `monitor` stream). Absent in unit tests and headless bridges,
    // where the monitor still runs but nothing is delivered.
    monitor_app: Option<tauri::AppHandle>,
) -> Value {
    let (session_id, run_id, tool_call_id, tool_name, arguments, activity) =
        match event_context(value) {
            Ok(context) => context,
            Err(error) => return fail_for_request(value, "pi.invalid_tool_request", error),
        };
    if background_task_tool_kind(value).is_some() {
        return resolve_background_task_request(root, value);
    }
    let effective_arguments = if respect_gitignore_override.is_some()
        && matches!(
            tool_name,
            WORKSPACE_READ_FILE
                | WORKSPACE_SEARCH
                | WORKSPACE_LIST_DIRECTORY
                | WORKSPACE_EDIT
                | WORKSPACE_APPLY_PATCH
        ) {
        arguments.as_object().map(|arguments| {
            let mut arguments = arguments.clone();
            arguments.insert(
                "respectGitignore".to_string(),
                Value::Bool(respect_gitignore_override.unwrap_or(false)),
            );
            Value::Object(arguments)
        })
    } else {
        None
    };
    let arguments = effective_arguments.as_ref().unwrap_or(arguments);
    if mutating_tool(tool_name) {
        let approved = permission_override.unwrap_or_else(|| {
            activity
                .get("approved")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
        let permission_mode = activity
            .get("permissionMode")
            .and_then(Value::as_str)
            .unwrap_or("ask");
        if !approved && permission_mode == "ask" {
            return fail_resolution(
                session_id,
                run_id,
                tool_call_id,
                "pi.permission_required",
                "该工具需要用户授权后才能执行。",
            );
        }
    }
    let resolve = || match tool_name {
        WORKSPACE_READ_FILE => read_file(root, arguments),
        WORKSPACE_READ_TOOL_OUTPUT => read_tool_output(root, arguments),
        WORKSPACE_SEARCH => search(root, arguments),
        WORKSPACE_LIST_DIRECTORY => list_directory(root, arguments),
        WORKSPACE_WRITE_FILE => write_file(root, arguments),
        WORKSPACE_EDIT => edit_file(root, arguments),
        WORKSPACE_APPLY_PATCH => apply_patch(root, arguments),
        RUN_TERMINAL_COMMAND => {
            run_terminal_with_policy(root, arguments, terminal_policy_override, Some(session_id))
        }
        MONITOR => arguments
            .as_object()
            .ok_or_else(|| "monitor arguments must be an object".to_string())
            .and_then(|arguments| {
                monitor_tools::start_monitor_tool(root, session_id, arguments, monitor_app.as_ref())
            }),
        SCHEDULER_CREATE | SCHEDULER_LIST | SCHEDULER_DELETE => arguments
            .as_object()
            .ok_or_else(|| "scheduler arguments must be an object".to_string())
            .and_then(|arguments| {
                scheduler_tools::scheduler_tool(
                    monitor_app.as_ref(),
                    tool_name,
                    session_id,
                    arguments,
                )
            }),
        ASK_USER_QUESTION | UPDATE_PLAN | SPAWN_SUBAGENT | RUN_BACKGROUND_TASK => {
            Err("This interaction is resolved by the Pi worker".to_string())
        }
        _ => Err(format!(
            "Tool is not allowed by Melody ToolGateway: {tool_name}"
        )),
    };
    let result = if mutating_tool(tool_name) {
        let lock = workspace_mutation_lock(root);
        match lock.lock() {
            Ok(_guard) => resolve(),
            Err(_) => Err("Workspace mutation lock is poisoned".to_string()),
        }
    } else {
        resolve()
    };
    match result {
        Ok(output) => success_resolution(session_id, run_id, tool_call_id, output),
        Err(error) => {
            let (code, message) = if let Some(message) = error.strip_prefix(GITIGNORED_ERROR_PREFIX)
            {
                ("pi.gitignored_path", message.to_string())
            } else if matches!(
                tool_name,
                WORKSPACE_READ_FILE
                    | WORKSPACE_READ_TOOL_OUTPUT
                    | WORKSPACE_SEARCH
                    | WORKSPACE_LIST_DIRECTORY
                    | WORKSPACE_WRITE_FILE
                    | WORKSPACE_EDIT
                    | WORKSPACE_APPLY_PATCH
                    | RUN_TERMINAL_COMMAND
            ) {
                ("pi.tool_gateway_denied", error)
            } else {
                ("pi.tool_not_allowed", error)
            };
            fail_resolution(session_id, run_id, tool_call_id, code, message)
        }
    }
}
