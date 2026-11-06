/**
 * Tool names shared by the worker, the Host gateway, and the compatibility
 * manifest.
 *
 * The worker advertises exactly `AGENT_TOOL_NAMES` to the Host. `request_policy`
 * in the Rust Host routes every advertised name except the ones in
 * `AGENT_WORKER_OWNED_TOOL_NAMES` (the worker resolves those itself) and the
 * ones in `AGENT_INTERNAL_TOOL_NAMES` (Host-only bridges the model never sees).
 *
 * `scripts/pi-tool-names-compatibility.mjs` enforces that agreement, because
 * Rust cannot import this module.
 */
export const AGENT_TOOL_NAMES = [
  /** Workspace file and search tools executed by the Host gateway. */
  "workspace_read_file",
  "workspace_read_tool_output",
  "workspace_search",
  /** Melody-build's `list_dir`, exposed with the workspace-owned prefix. */
  "workspace_list_directory",
  "workspace_write_file",
  "workspace_edit",
  "workspace_apply_patch",
  "run_terminal_command",
  /**
   * Melody's streaming monitor: the Host runs the command and turns every
   * output line into a conversation notification, with its own volume limits.
   */
  "monitor",
  /**
   * Melody's scheduler tools. A skill that schedules work calls these names,
   * so the Host keeps them rather than inventing a parallel surface.
   */
  "scheduler_create",
  "scheduler_list",
  "scheduler_delete",
  "ask_user_question",
  "update_plan",
  "spawn_subagent",
  "run_background_task",
  /** Original Melody-build task tool name retained for prompt compatibility. */
  "task",
  /** Melody-build-compatible background task inspection controls. */
  "get_command_or_subagent_output",
  "wait_commands_or_subagents",
  "kill_command_or_subagent",
  /** Original Melody-build background-task control aliases. */
  "get_task_output",
  "wait_tasks",
  "kill_task",
  "mcp_list_tools",
  "mcp_call_tool",
  /** Host-owned network tools that replace Melody-build's web implementations. */
  "web_search",
  "web_fetch",
  /** Session-scoped native browser tools resolved by the Rust Host. */
  "browser_navigate",
  "browser_tabs",
  "browser_snapshot",
  "browser_wait",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_tab_open",
  "browser_tab_select",
  "browser_tab_close",
  /** Host-owned cross-session memory tools. */
  "memory_search",
  "memory_get",
  "memory_remember",
  /** Host-owned read-only language-server bridge. */
  "lsp",
  /** Host-owned tree-sitter codebase index/navigation bridge. */
  "codebase_navigation",
  /** Worker extension tools registered outside the gateway. */
  "todo_write",
  "update_goal",
] as const;

/**
 * Advertised names the worker resolves itself: the background-task aliases and
 * the Pi extension tools. The Host gateway never routes them, so they must stay
 * out of `request_policy.rs`.
 */
export const AGENT_WORKER_OWNED_TOOL_NAMES = [
  "task",
  "get_task_output",
  "wait_tasks",
  "kill_task",
  "todo_write",
  "update_goal",
] as const satisfies readonly (typeof AGENT_TOOL_NAMES)[number][];

/**
 * Host-only bridges that are routed but never advertised to the model.
 *
 * `workspace_create_subagent_worktree` provisions an isolated child worktree;
 * `melody_internal_instruction_scope` is the directory instruction preflight.
 */
export const AGENT_INTERNAL_TOOL_NAMES = [
  "workspace_create_subagent_worktree",
  "melody_internal_instruction_scope",
] as const;

export type AgentAdvertisedToolName = (typeof AGENT_TOOL_NAMES)[number];

export type AgentWorkerOwnedToolName =
  (typeof AGENT_WORKER_OWNED_TOOL_NAMES)[number];

export type AgentInternalToolName = (typeof AGENT_INTERNAL_TOOL_NAMES)[number];

export type AgentToolName = AgentAdvertisedToolName | AgentInternalToolName;

export const isAgentAdvertisedToolName = (
  value: string,
): value is AgentAdvertisedToolName =>
  (AGENT_TOOL_NAMES as readonly string[]).includes(value);

export const isAgentInternalToolName = (
  value: string,
): value is AgentInternalToolName =>
  (AGENT_INTERNAL_TOOL_NAMES as readonly string[]).includes(value);

export const isAgentToolName = (value: string): value is AgentToolName =>
  isAgentAdvertisedToolName(value) || isAgentInternalToolName(value);
