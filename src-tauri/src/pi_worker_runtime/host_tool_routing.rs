use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    config_runtime::{pi_respect_gitignore, pi_terminal_policy},
    database::{AppDatabase, permission_decision_for_session},
    pi_codebase_runtime,
    pi_hook_runtime::{self, HookEvent, HookRunResult},
    pi_lsp_runtime,
    pi_mcp_runtime::PiMcpRuntime,
    pi_memory_runtime, pi_tool_gateway, pi_web_runtime,
    workspace_access::WorkspaceRegistry,
};

use super::{AGENT_PROTOCOL_VERSION, PI_AGENT_STDERR, PiWorkerRuntime, encode_command};

/// A stored permission decision after mapping the database result.
///
/// `Invalid` and `Unavailable` deliberately collapse to "keep the request
/// interactive"; a broken store must never widen permissions.
#[derive(Debug, PartialEq, Eq)]
enum PersistedDecision {
    Allow,
    Deny,
    Missing,
    Invalid,
    Unavailable(String),
}

fn classify_persisted_decision(result: Result<Option<String>, String>) -> PersistedDecision {
    match result {
        Ok(Some(decision)) if decision == "allow" => PersistedDecision::Allow,
        Ok(Some(decision)) if decision == "deny" => PersistedDecision::Deny,
        Ok(Some(_)) => PersistedDecision::Invalid,
        Ok(None) => PersistedDecision::Missing,
        Err(error) => PersistedDecision::Unavailable(error),
    }
}

fn lookup_persisted_permission(
    app: &AppHandle,
    session_id: &str,
    tool_key: &str,
) -> Option<String> {
    let database = app.try_state::<AppDatabase>()?;
    match classify_persisted_decision(permission_decision_for_session(
        database.inner(),
        session_id,
        tool_key,
    )) {
        PersistedDecision::Allow => Some("allow".to_string()),
        PersistedDecision::Deny => Some("deny".to_string()),
        PersistedDecision::Invalid => {
            let _ = app.emit(
                PI_AGENT_STDERR,
                "Pi permission store returned an invalid decision; leaving the request interactive.",
            );
            None
        }
        PersistedDecision::Unavailable(error) => {
            // A lookup failure must never widen permissions. Leaving the
            // worker's `ask` interaction in place is safe and lets the user
            // make an explicit one-shot decision.
            let _ = app.emit(
                PI_AGENT_STDERR,
                format!("Pi permission store unavailable: {error}"),
            );
            None
        }
        PersistedDecision::Missing => None,
    }
}

fn persisted_permission_for_tool_request(app: &AppHandle, value: &Value) -> Option<String> {
    let session_id = value.get("sessionId").and_then(Value::as_str)?;
    let tool_key = pi_tool_gateway::permission_tool_key(value)?;
    lookup_persisted_permission(app, session_id, &tool_key)
}

pub(super) fn persisted_permission_for_interaction(
    app: &AppHandle,
    value: &Value,
) -> Option<(String, String, String)> {
    let (session_id, interaction_id, tool_key) = pi_tool_gateway::permission_interaction(value)?;
    let decision = lookup_persisted_permission(app, &session_id, &tool_key)?;
    Some((session_id, interaction_id, decision))
}

/// Host-owned execution branch for one worker tool request.
///
/// Variant order mirrors the precedence applied by `classify_tool_request`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ToolDispatchKind {
    BackgroundTask,
    SubagentWorktree,
    Codebase,
    Lsp,
    Memory,
    Browser,
    Web,
    Mcp,
    Gateway,
}

fn classify_tool_request(value: &Value) -> ToolDispatchKind {
    if pi_tool_gateway::background_task_tool_kind(value).is_some() {
        ToolDispatchKind::BackgroundTask
    } else if pi_tool_gateway::subagent_worktree_tool_kind(value).is_some() {
        ToolDispatchKind::SubagentWorktree
    } else if pi_codebase_runtime::codebase_tool_kind(value).is_some() {
        ToolDispatchKind::Codebase
    } else if pi_lsp_runtime::lsp_tool_kind(value).is_some() {
        ToolDispatchKind::Lsp
    } else if pi_tool_gateway::memory_tool_kind(value).is_some() {
        ToolDispatchKind::Memory
    } else if pi_tool_gateway::browser_tool_kind(value).is_some() {
        ToolDispatchKind::Browser
    } else if pi_tool_gateway::web_tool_kind(value).is_some() {
        ToolDispatchKind::Web
    } else if pi_tool_gateway::mcp_tool_kind(value).is_some() {
        ToolDispatchKind::Mcp
    } else {
        ToolDispatchKind::Gateway
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PreHookDecision<'a> {
    /// The caller must run PreToolUse before asking for the final plan.
    NotRun,
    Passed,
    Blocked(&'a str),
}

struct ToolRequestInput<'a> {
    worker_cwd: Result<&'a Path, &'a str>,
    requested_cwd: Option<&'a str>,
    authorization: Option<Result<PathBuf, String>>,
    instruction_scope: bool,
    pre_hook: PreHookDecision<'a>,
    persisted_decision: Option<&'a str>,
    dispatch: ToolDispatchKind,
}

#[derive(Debug, PartialEq, Eq)]
enum ToolRequestPlan {
    FailWorkspace(String),
    InstructionScope {
        root: PathBuf,
    },
    RunPreToolHooks {
        root: PathBuf,
    },
    HookBlocked(String),
    PersistedDeny,
    Dispatch {
        kind: ToolDispatchKind,
        root: PathBuf,
    },
}

/// Decide what the Host may do with one worker tool request.
///
/// The order is the contract: worker workspace → requested-cwd authorization →
/// instruction-scope bypass → enforceable PreToolUse → persisted deny →
/// dispatch. Callers must not run Hooks before this function reports
/// `RunPreToolHooks`.
fn plan_tool_request(input: ToolRequestInput<'_>) -> ToolRequestPlan {
    let worker_cwd = match input.worker_cwd {
        Ok(cwd) => cwd,
        Err(error) => return ToolRequestPlan::FailWorkspace(error.to_string()),
    };
    let root = if input.requested_cwd.is_some() {
        let Some(authorization) = input.authorization else {
            return ToolRequestPlan::FailWorkspace(
                "Workspace authorization is unavailable.".to_string(),
            );
        };
        match authorization {
            // A Pi child may intentionally run from an authorized descendant
            // directory. The worker still starts from one registered project
            // root; allowing only descendants keeps the Host boundary intact.
            Ok(root) if root == worker_cwd || root.starts_with(worker_cwd) => root,
            Ok(_) => {
                return ToolRequestPlan::FailWorkspace(
                    "Tool request workspace does not match the active Pi worker workspace."
                        .to_string(),
                );
            }
            Err(error) => return ToolRequestPlan::FailWorkspace(error),
        }
    } else {
        worker_cwd.to_path_buf()
    };

    if input.instruction_scope {
        return ToolRequestPlan::InstructionScope { root };
    }
    match input.pre_hook {
        PreHookDecision::NotRun => return ToolRequestPlan::RunPreToolHooks { root },
        PreHookDecision::Blocked(reason) => {
            return ToolRequestPlan::HookBlocked(reason.to_string());
        }
        PreHookDecision::Passed => {}
    }
    if input.persisted_decision == Some("deny") {
        return ToolRequestPlan::PersistedDeny;
    }
    ToolRequestPlan::Dispatch {
        kind: input.dispatch,
        root,
    }
}

/// Post-hook choice for a delivered resolution. `pi.hook_blocked` never
/// produces a post hook because the hook already denied the call.
fn post_hook_event(status: Option<&str>, error_code: Option<&str>) -> Option<HookEvent> {
    if error_code == Some("pi.hook_blocked") {
        return None;
    }
    Some(if error_code == Some("pi.permission_denied") {
        HookEvent::PermissionDenied
    } else if status == Some("completed") {
        HookEvent::PostToolUse
    } else {
        HookEvent::PostToolUseFailure
    })
}

impl PiWorkerRuntime {
    fn emit_hook_warnings(app: &AppHandle, result: &HookRunResult) {
        for warning in &result.warnings {
            let _ = app.emit(PI_AGENT_STDERR, format!("Pi Hook: {warning}"));
        }
    }

    async fn run_host_tool_hooks(
        &self,
        root: &Path,
        event: HookEvent,
        request: &Value,
        resolution: Option<&Value>,
    ) -> HookRunResult {
        let root = root.to_path_buf();
        let request = request.clone();
        let resolution = resolution.cloned();
        match tauri::async_runtime::spawn_blocking(move || {
            pi_hook_runtime::run_tool_hooks(&root, event, &request, resolution.as_ref())
        })
        .await
        {
            Ok(result) => result,
            Err(error) => HookRunResult {
                warnings: vec![format!("Hook worker failed: {error}")],
                ..HookRunResult::default()
            },
        }
    }

    pub(super) async fn observe_host_hook_event(
        &self,
        app: &AppHandle,
        generation: u64,
        value: &Value,
    ) {
        let Some(event) = value.get("event").and_then(Value::as_object) else {
            return;
        };
        let event_type = event.get("type").and_then(Value::as_str);
        let hook_event = match event_type {
            Some("session.opened") => HookEvent::SessionStart,
            Some("session.closed") => HookEvent::SessionEnd,
            Some("session.compacting") => HookEvent::PreCompact,
            Some("session.compacted") => HookEvent::PostCompact,
            Some("subagent.changed")
                if event.get("status").and_then(Value::as_str) == Some("running") =>
            {
                HookEvent::SubagentStart
            }
            Some("subagent.changed")
                if matches!(
                    event.get("status").and_then(Value::as_str),
                    Some("completed" | "failed" | "cancelled")
                ) =>
            {
                HookEvent::SubagentStop
            }
            _ => return,
        };
        let Ok(root) = self.worker_cwd(generation).await else {
            return;
        };
        let payload = value.clone();
        let result = match tauri::async_runtime::spawn_blocking(move || {
            pi_hook_runtime::run_event_hooks(&root, hook_event, &payload)
        })
        .await
        {
            Ok(result) => result,
            Err(error) => HookRunResult {
                warnings: vec![format!("Hook worker failed: {error}")],
                ..HookRunResult::default()
            },
        };
        Self::emit_hook_warnings(app, &result);
        if result.blocked {
            // Lifecycle hooks are intentionally observational in Pi. A late
            // block cannot safely undo a completed session/compaction event;
            // keep the diagnostic visible and leave enforcement to ACP.
            let _ = app.emit(
                PI_AGENT_STDERR,
                format!(
                    "Pi Hook: {} returned a blocking decision after the event; decision ignored",
                    hook_event.as_str()
                ),
            );
        }
    }

    pub(super) async fn resolve_tool_request(
        &self,
        app: &AppHandle,
        generation: u64,
        value: &Value,
    ) {
        let worker_cwd = self.worker_cwd(generation).await;
        let requested_cwd = pi_tool_gateway::requested_cwd(value);
        let authorization = requested_cwd.map(|cwd| {
            app.try_state::<WorkspaceRegistry>()
                .ok_or_else(|| "Workspace authorization is unavailable.".to_string())
                .and_then(|registry| registry.authorize(cwd))
        });
        let instruction_scope = pi_tool_gateway::is_instruction_scope_request(value);
        let dispatch = classify_tool_request(value);

        // Authorization and the instruction-scope bypass run before any Hook:
        // a Hook may only deny inside the authorized project boundary, and the
        // internal instruction lookup never consults product permission rules.
        let plan = plan_tool_request(ToolRequestInput {
            worker_cwd: worker_cwd.as_deref().map_err(|error| error.as_str()),
            requested_cwd,
            authorization: authorization.clone(),
            instruction_scope,
            pre_hook: PreHookDecision::NotRun,
            persisted_decision: None,
            dispatch,
        });
        let mut persisted_decision = None;
        let plan = match plan {
            ToolRequestPlan::RunPreToolHooks { root } => {
                let pre_hooks = self
                    .run_host_tool_hooks(&root, HookEvent::PreToolUse, value, None)
                    .await;
                Self::emit_hook_warnings(app, &pre_hooks);
                persisted_decision = persisted_permission_for_tool_request(app, value);
                let pre_hook = if pre_hooks.blocked {
                    PreHookDecision::Blocked(
                        pre_hooks
                            .reason
                            .as_deref()
                            .unwrap_or("Hook denied this tool call."),
                    )
                } else {
                    PreHookDecision::Passed
                };
                plan_tool_request(ToolRequestInput {
                    worker_cwd: worker_cwd.as_deref().map_err(|error| error.as_str()),
                    requested_cwd,
                    authorization,
                    instruction_scope,
                    pre_hook,
                    persisted_decision: persisted_decision.as_deref(),
                    dispatch,
                })
            }
            resolved => resolved,
        };
        let persisted_decision = persisted_decision.as_deref();

        match plan {
            ToolRequestPlan::FailWorkspace(message) => {
                let command = pi_tool_gateway::fail_for_workspace(value, message);
                self.send_tool_resolution(app, generation, value, command)
                    .await;
            }
            ToolRequestPlan::InstructionScope { root } => {
                // Directory instruction lookup is an internal worker
                // preflight. It reads only Host-validated AGENTS.md files,
                // bypasses product permission rules/hooks, and cannot execute
                // the model's requested filesystem operation.
                let scope_root = root;
                let scope_value = value.clone();
                let command = match tauri::async_runtime::spawn_blocking(move || {
                    pi_tool_gateway::resolve_instruction_scope_request(&scope_root, &scope_value)
                })
                .await
                {
                    Ok(command) => command,
                    Err(error) => pi_tool_gateway::fail_for_request(
                        value,
                        "pi.instruction_scope_failed",
                        format!("Instruction-scope worker failed: {error}"),
                    ),
                };
                self.write_tool_resolution(app, generation, value, command)
                    .await;
            }
            ToolRequestPlan::HookBlocked(reason) => {
                let (session_id, run_id, tool_call_id) = pi_tool_gateway::event_context(value)
                    .map(|(session_id, run_id, tool_call_id, _, _, _)| {
                        (session_id, run_id, tool_call_id)
                    })
                    .unwrap_or(("unknown", None, "unknown"));
                let command = pi_tool_gateway::fail_resolution(
                    session_id,
                    run_id,
                    tool_call_id,
                    "pi.hook_blocked",
                    reason,
                );
                self.write_tool_resolution(app, generation, value, command)
                    .await;
            }
            ToolRequestPlan::PersistedDeny => {
                let command = pi_tool_gateway::deny_for_persisted_permission(value);
                self.send_tool_resolution(app, generation, value, command)
                    .await;
            }
            ToolRequestPlan::Dispatch { kind, root } => {
                let command = match kind {
                    ToolDispatchKind::BackgroundTask => {
                        // Background terminal processes are owned by the Host registry.
                        // Route their get/wait/kill controls through a blocking boundary
                        // just like foreground terminal execution; the worker receives
                        // only a bounded JSON snapshot.
                        let control_root = root.clone();
                        let control_value = value.clone();
                        match tauri::async_runtime::spawn_blocking(move || {
                            pi_tool_gateway::resolve_background_task_request(
                                &control_root,
                                &control_value,
                            )
                        })
                        .await
                        {
                            Ok(command) => command,
                            Err(error) => {
                                let command = pi_tool_gateway::fail_for_workspace(
                                    value,
                                    format!("Background task control worker failed: {error}"),
                                );
                                self.send_tool_resolution(app, generation, value, command)
                                    .await;
                                return;
                            }
                        }
                    }
                    ToolDispatchKind::SubagentWorktree => {
                        // Worktree isolation is provisioned by the Host so the worker
                        // never shells out to git or chooses an arbitrary destination.
                        // The resulting path is still scoped to the requested child cwd
                        // and returned as a bounded JSON payload.
                        let worktree_root = root.clone();
                        let worktree_value = value.clone();
                        match tauri::async_runtime::spawn_blocking(move || {
                            pi_tool_gateway::resolve_subagent_worktree_request(
                                &worktree_root,
                                &worktree_value,
                            )
                        })
                        .await
                        {
                            Ok(command) => command,
                            Err(error) => {
                                let command = pi_tool_gateway::fail_for_workspace(
                                    value,
                                    format!("Subagent worktree worker failed: {error}"),
                                );
                                self.send_tool_resolution(app, generation, value, command)
                                    .await;
                                return;
                            }
                        }
                    }
                    ToolDispatchKind::Codebase => {
                        // The codebase index is owned by the Host. Keep parser work off
                        // Tokio's runtime thread and return only bounded JSON locations.
                        let codebase_root = root.clone();
                        let codebase_value = value.clone();
                        match tauri::async_runtime::spawn_blocking(move || {
                            pi_codebase_runtime::resolve_request(&codebase_root, &codebase_value)
                        })
                        .await
                        {
                            Ok(command) => command,
                            Err(error) => {
                                let command = pi_tool_gateway::fail_for_workspace(
                                    value,
                                    format!("Codebase index worker failed: {error}"),
                                );
                                self.send_tool_resolution(app, generation, value, command)
                                    .await;
                                return;
                            }
                        }
                    }
                    ToolDispatchKind::Lsp => {
                        // LSP processes are owned by the Host bridge.  Keep the one-shot
                        // stdio JSON-RPC session off Tokio's runtime thread and return
                        // only the bounded, formatted read-only result to the worker.
                        let lsp_root = root.clone();
                        let lsp_value = value.clone();
                        match tauri::async_runtime::spawn_blocking(move || {
                            pi_lsp_runtime::resolve_request(&lsp_root, &lsp_value)
                        })
                        .await
                        {
                            Ok(command) => command,
                            Err(error) => {
                                let command = pi_tool_gateway::fail_for_workspace(
                                    value,
                                    format!("LSP bridge worker failed: {error}"),
                                );
                                self.send_tool_resolution(app, generation, value, command)
                                    .await;
                                return;
                            }
                        }
                    }
                    ToolDispatchKind::Memory => {
                        // Memory files live in Melody's app-owned directory rather than
                        // inside the project workspace. The worker emits only a bounded
                        // declarative request; the Host owns scope, hashing, indexing and
                        // line-range checks.
                        if pi_tool_gateway::memory_write_requires_permission(value)
                            && persisted_decision != Some("allow")
                        {
                            pi_tool_gateway::permission_required_for_request(value)
                        } else {
                            let memory_value = value.clone();
                            let memory_root = root.clone();
                            match tauri::async_runtime::spawn_blocking(move || {
                                tauri::async_runtime::block_on(pi_memory_runtime::resolve_request(
                                    &memory_root,
                                    &memory_value,
                                ))
                            })
                            .await
                            {
                                Ok(Ok(output)) => {
                                    pi_tool_gateway::success_for_request(value, output)
                                }
                                Ok(Err(error)) => pi_tool_gateway::fail_resolution(
                                    value
                                        .get("sessionId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("unknown"),
                                    value.get("runId").and_then(Value::as_str),
                                    value
                                        .get("event")
                                        .and_then(Value::as_object)
                                        .and_then(|event| event.get("toolCallId"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("unknown"),
                                    "pi.memory_tool_failed",
                                    error,
                                ),
                                Err(error) => pi_tool_gateway::fail_resolution(
                                    value
                                        .get("sessionId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("unknown"),
                                    value.get("runId").and_then(Value::as_str),
                                    value
                                        .get("event")
                                        .and_then(Value::as_object)
                                        .and_then(|event| event.get("toolCallId"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("unknown"),
                                    "pi.memory_tool_failed",
                                    format!("Memory execution worker failed: {error}"),
                                ),
                            }
                        }
                    }
                    ToolDispatchKind::Browser => {
                        // Browser actions execute only in a session-scoped Host-owned
                        // WebviewWindow. Page content and refs are treated as untrusted;
                        // navigation/click/type must carry the worker's explicit approval.
                        if pi_tool_gateway::browser_action_requires_permission(value) {
                            pi_tool_gateway::permission_required_for_request(value)
                        } else {
                            let Some(browser_runtime) =
                                app.try_state::<crate::pi_browser_runtime::PiBrowserRuntime>()
                            else {
                                let command = pi_tool_gateway::fail_for_request(
                                    value,
                                    "pi.browser_unavailable",
                                    "Browser Host is unavailable in this runtime.",
                                );
                                self.send_tool_resolution(app, generation, value, command)
                                    .await;
                                return;
                            };
                            match crate::pi_browser_runtime::resolve_request(
                                app,
                                value,
                                &browser_runtime,
                            )
                            .await
                            {
                                Ok(output) => pi_tool_gateway::success_for_request(value, output),
                                Err(error) => pi_tool_gateway::fail_for_request(
                                    value,
                                    "pi.browser_tool_failed",
                                    error,
                                ),
                            }
                        }
                    }
                    ToolDispatchKind::Web => {
                        // Web search/fetch use a separate Host bridge.  The worker only
                        // emits a bounded declarative request; it never receives a raw
                        // HTTP client, DNS resolver, or redirect-capable transport.
                        match pi_web_runtime::resolve_request(&root, value).await {
                            Ok(output) => pi_tool_gateway::success_for_request(value, output),
                            Err(error) => pi_tool_gateway::fail_resolution(
                                value
                                    .get("sessionId")
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown"),
                                value.get("runId").and_then(Value::as_str),
                                value
                                    .get("event")
                                    .and_then(Value::as_object)
                                    .and_then(|event| event.get("toolCallId"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown"),
                                "pi.web_tool_failed",
                                error,
                            ),
                        }
                    }
                    ToolDispatchKind::Mcp => {
                        // MCP is the one Pi ecosystem capability that crosses the worker
                        // boundary asynchronously. The worker only emits the request;
                        // the Host owns config parsing, process lifecycle and JSON-RPC.
                        // Keep the same permission defense as the regular gateway in case
                        // a stale/replayed event bypasses the worker-side interaction.
                        if pi_tool_gateway::mcp_call_requires_permission(value)
                            && persisted_decision != Some("allow")
                        {
                            pi_tool_gateway::resolve_request(&root, value)
                        } else {
                            let Some(mcp_runtime) = app.try_state::<PiMcpRuntime>() else {
                                let command = pi_tool_gateway::fail_for_workspace(
                                    value,
                                    "MCP Host bridge is unavailable in this runtime.",
                                );
                                self.send_tool_resolution(app, generation, value, command)
                                    .await;
                                return;
                            };
                            match mcp_runtime.resolve_request(&root, value).await {
                                Ok(output) => pi_tool_gateway::success_for_request(value, output),
                                Err(error) => pi_tool_gateway::fail_resolution(
                                    value
                                        .get("sessionId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("unknown"),
                                    value.get("runId").and_then(Value::as_str),
                                    value
                                        .get("event")
                                        .and_then(Value::as_object)
                                        .and_then(|event| event.get("toolCallId"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("unknown"),
                                    "pi.mcp_tool_failed",
                                    error,
                                ),
                            }
                        }
                    }
                    ToolDispatchKind::Gateway => {
                        // File traversal and terminal execution are deliberately
                        // synchronous inside the policy gateway. Keep them off Tokio's
                        // runtime thread so a long-running tool cannot starve stdout,
                        // permission, or cancellation events for other sessions.
                        let gateway_root = root.clone();
                        let gateway_value = value.clone();
                        let permission_override =
                            (persisted_decision == Some("allow")).then_some(true);
                        // Resolve the visibility policy from Host-owned configuration at
                        // the authorization boundary. The worker's boolean is useful for
                        // replay shape/diagnostics, but is not trusted to widen access.
                        let respect_gitignore = pi_respect_gitignore(&root.to_string_lossy());
                        let terminal_policy = pi_terminal_policy(&root.to_string_lossy());
                        let monitor_app = app.clone();
                        match tauri::async_runtime::spawn_blocking(move || {
                            let monitor_app = Some(monitor_app);
                            permission_override.map_or_else(
                                || {
                                    pi_tool_gateway::resolve_request_with_host_policy(
                                        &gateway_root,
                                        &gateway_value,
                                        None,
                                        Some(respect_gitignore),
                                        terminal_policy,
                                        monitor_app.clone(),
                                    )
                                },
                                |override_value| {
                                    pi_tool_gateway::resolve_request_with_host_policy(
                                        &gateway_root,
                                        &gateway_value,
                                        Some(override_value),
                                        Some(respect_gitignore),
                                        terminal_policy,
                                        monitor_app.clone(),
                                    )
                                },
                            )
                        })
                        .await
                        {
                            Ok(command) => command,
                            Err(error) => {
                                let command = pi_tool_gateway::fail_for_workspace(
                                    value,
                                    format!("Tool execution worker failed: {error}"),
                                );
                                self.send_tool_resolution(app, generation, value, command)
                                    .await;
                                return;
                            }
                        }
                    }
                };
                self.send_tool_resolution(app, generation, value, command)
                    .await;
            }
            ToolRequestPlan::RunPreToolHooks { .. } => {
                unreachable!("pre-tool hooks are resolved before dispatch")
            }
        }
    }

    async fn send_tool_resolution(
        &self,
        app: &AppHandle,
        generation: u64,
        value: &Value,
        command: Value,
    ) {
        let status = command
            .get("resolution")
            .and_then(Value::as_object)
            .and_then(|resolution| resolution.get("status"))
            .and_then(Value::as_str);
        let error_code = command
            .get("resolution")
            .and_then(Value::as_object)
            .and_then(|resolution| resolution.get("error"))
            .and_then(Value::as_object)
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str);
        let post_hook = match post_hook_event(status, error_code) {
            Some(event) => self
                .worker_cwd(generation)
                .await
                .ok()
                .map(|root| (root, event)),
            None => None,
        };
        // Deliver the resolution first. Post/failure hooks are observational;
        // they must not make Pi wait for a slow external command before it can
        // continue the turn.
        self.write_tool_resolution(app, generation, value, command.clone())
            .await;
        if let Some((root, event)) = post_hook {
            let runtime = self.clone();
            let hook_app = app.clone();
            let hook_value = value.clone();
            tauri::async_runtime::spawn(async move {
                let result = runtime
                    .run_host_tool_hooks(&root, event, &hook_value, Some(&command))
                    .await;
                Self::emit_hook_warnings(&hook_app, &result);
            });
        }
    }

    async fn write_tool_resolution(
        &self,
        app: &AppHandle,
        generation: u64,
        value: &Value,
        command: Value,
    ) {
        let event_id = value
            .get("eventId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let envelope = json!({
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "requestId": format!("pi-tool-{event_id}"),
            "sessionId": value.get("sessionId"),
            "command": command
        });
        let frame = match encode_command(&envelope) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = app.emit(PI_AGENT_STDERR, format!("Pi ToolGateway: {error}"));
                return;
            }
        };
        if let Err(error) = self.write_frame(generation, &frame, true).await {
            let _ = app.emit(
                PI_AGENT_STDERR,
                format!("Pi ToolGateway response failed: {error}"),
            );
        }
    }

    pub(super) async fn resolve_persisted_permission(
        &self,
        app: &AppHandle,
        generation: u64,
        value: &Value,
        session_id: String,
        interaction_id: String,
        decision: String,
    ) {
        let option_id = if decision == "allow" {
            "allow_always"
        } else {
            // Pi treats any non-allow outcome as a rejection. Use the
            // explicit one-shot option because older workers may not expose
            // `reject_always` even though the Host rule is project-scoped.
            "reject_once"
        };
        let event_id = value
            .get("eventId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let envelope = json!({
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "requestId": format!("pi-permission-{event_id}"),
            "sessionId": session_id,
            "command": {
                "type": "interaction.resolve",
                "sessionId": session_id,
                "interactionId": interaction_id,
                "resolution": {
                    "outcome": { "outcome": "selected", "optionId": option_id }
                }
            }
        });
        let frame = match encode_command(&envelope) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = app.emit(
                    PI_AGENT_STDERR,
                    format!("Pi persisted permission response: {error}"),
                );
                return;
            }
        };
        if let Err(error) = self.write_frame(generation, &frame, true).await {
            let _ = app.emit(
                PI_AGENT_STDERR,
                format!("Pi persisted permission response failed: {error}"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    fn tool_request(tool_name: &str) -> Value {
        json!({
            "sessionId": "session-1",
            "event": {
                "type": "tool.requested",
                "toolCallId": "call-1",
                "toolName": tool_name,
                "activity": { "arguments": {} }
            }
        })
    }

    fn input<'a>(
        worker_cwd: Result<&'a Path, &'a str>,
        requested_cwd: Option<&'a str>,
        authorization: Option<Result<PathBuf, String>>,
    ) -> ToolRequestInput<'a> {
        ToolRequestInput {
            worker_cwd,
            requested_cwd,
            authorization,
            instruction_scope: false,
            pre_hook: PreHookDecision::NotRun,
            persisted_decision: None,
            dispatch: ToolDispatchKind::Gateway,
        }
    }

    #[test]
    fn worker_not_running_fails_before_authorization() {
        let plan = plan_tool_request(input(Err("Pi worker is not running"), None, None));
        assert_eq!(
            plan,
            ToolRequestPlan::FailWorkspace("Pi worker is not running".to_string())
        );
    }

    #[test]
    fn missing_workspace_registry_fails_closed() {
        let plan = plan_tool_request(input(
            Ok(Path::new("/repo/app")),
            Some("/repo/app/sub"),
            None,
        ));
        assert_eq!(
            plan,
            ToolRequestPlan::FailWorkspace("Workspace authorization is unavailable.".to_string())
        );
    }

    #[test]
    fn unauthorized_cwd_reports_registry_error() {
        let plan = plan_tool_request(input(
            Ok(Path::new("/repo/app")),
            Some("/elsewhere"),
            Some(Err("Workspace is not authorized.".to_string())),
        ));
        assert_eq!(
            plan,
            ToolRequestPlan::FailWorkspace("Workspace is not authorized.".to_string())
        );
    }

    #[test]
    fn authorized_sibling_does_not_match_worker_root() {
        let plan = plan_tool_request(input(
            Ok(Path::new("/repo/app")),
            Some("/repo/other"),
            Some(Ok(path("/repo/other"))),
        ));
        assert_eq!(
            plan,
            ToolRequestPlan::FailWorkspace(
                "Tool request workspace does not match the active Pi worker workspace.".to_string()
            )
        );
    }

    #[test]
    fn authorized_descendant_runs_pre_tool_hooks() {
        let plan = plan_tool_request(input(
            Ok(Path::new("/repo/app")),
            Some("/repo/app/sub"),
            Some(Ok(path("/repo/app/sub"))),
        ));
        assert_eq!(
            plan,
            ToolRequestPlan::RunPreToolHooks {
                root: path("/repo/app/sub")
            }
        );
    }

    #[test]
    fn worker_root_is_used_when_the_request_has_no_cwd() {
        let plan = plan_tool_request(input(Ok(Path::new("/repo/app")), None, None));
        assert_eq!(
            plan,
            ToolRequestPlan::RunPreToolHooks {
                root: path("/repo/app")
            }
        );
    }

    #[test]
    fn instruction_scope_bypasses_hooks_and_persisted_deny() {
        let plan = plan_tool_request(ToolRequestInput {
            instruction_scope: true,
            pre_hook: PreHookDecision::Blocked("hook denied"),
            persisted_decision: Some("deny"),
            ..input(Ok(Path::new("/repo/app")), None, None)
        });
        assert_eq!(
            plan,
            ToolRequestPlan::InstructionScope {
                root: path("/repo/app")
            }
        );
    }

    #[test]
    fn hook_block_beats_persisted_allow_and_deny() {
        for decision in ["allow", "deny"] {
            let plan = plan_tool_request(ToolRequestInput {
                pre_hook: PreHookDecision::Blocked("hook denied"),
                persisted_decision: Some(decision),
                ..input(Ok(Path::new("/repo/app")), None, None)
            });
            assert_eq!(
                plan,
                ToolRequestPlan::HookBlocked("hook denied".to_string())
            );
        }
    }

    #[test]
    fn persisted_deny_beats_dispatch() {
        let plan = plan_tool_request(ToolRequestInput {
            pre_hook: PreHookDecision::Passed,
            persisted_decision: Some("deny"),
            dispatch: ToolDispatchKind::Gateway,
            ..input(Ok(Path::new("/repo/app")), None, None)
        });
        assert_eq!(plan, ToolRequestPlan::PersistedDeny);
    }

    #[test]
    fn persisted_allow_keeps_the_dispatch_kind() {
        let plan = plan_tool_request(ToolRequestInput {
            pre_hook: PreHookDecision::Passed,
            persisted_decision: Some("allow"),
            dispatch: ToolDispatchKind::Memory,
            ..input(Ok(Path::new("/repo/app")), None, None)
        });
        assert_eq!(
            plan,
            ToolRequestPlan::Dispatch {
                kind: ToolDispatchKind::Memory,
                root: path("/repo/app")
            }
        );
    }

    #[test]
    fn invalid_persisted_decision_stays_interactive() {
        assert_eq!(
            classify_persisted_decision(Ok(Some("ask".to_string()))),
            PersistedDecision::Invalid
        );
    }

    #[test]
    fn persisted_lookup_failure_stays_interactive() {
        assert_eq!(
            classify_persisted_decision(Err("database offline".to_string())),
            PersistedDecision::Unavailable("database offline".to_string())
        );
    }

    #[test]
    fn persisted_decisions_map_allow_deny_and_missing() {
        assert_eq!(
            classify_persisted_decision(Ok(Some("allow".to_string()))),
            PersistedDecision::Allow
        );
        assert_eq!(
            classify_persisted_decision(Ok(Some("deny".to_string()))),
            PersistedDecision::Deny
        );
        assert_eq!(
            classify_persisted_decision(Ok(None)),
            PersistedDecision::Missing
        );
    }

    #[test]
    fn dispatch_precedence_matches_the_host_routing_table() {
        let cases = [
            (
                "get_command_or_subagent_output",
                ToolDispatchKind::BackgroundTask,
            ),
            (
                "workspace_create_subagent_worktree",
                ToolDispatchKind::SubagentWorktree,
            ),
            ("codebase_navigation", ToolDispatchKind::Codebase),
            ("lsp", ToolDispatchKind::Lsp),
            ("memory_search", ToolDispatchKind::Memory),
            ("browser_navigate", ToolDispatchKind::Browser),
            ("web_search", ToolDispatchKind::Web),
            ("mcp_list_tools", ToolDispatchKind::Mcp),
            ("workspace_read_file", ToolDispatchKind::Gateway),
        ];
        for (tool_name, expected) in cases {
            assert_eq!(
                classify_tool_request(&tool_request(tool_name)),
                expected,
                "tool {tool_name}"
            );
        }
    }

    #[test]
    fn post_hook_selection_covers_all_resolution_outcomes() {
        assert_eq!(
            post_hook_event(Some("completed"), None),
            Some(HookEvent::PostToolUse)
        );
        assert_eq!(
            post_hook_event(None, Some("pi.permission_denied")),
            Some(HookEvent::PermissionDenied)
        );
        assert_eq!(
            post_hook_event(Some("failed"), Some("pi.tool_error")),
            Some(HookEvent::PostToolUseFailure)
        );
        assert_eq!(post_hook_event(None, Some("pi.hook_blocked")), None);
    }
}
