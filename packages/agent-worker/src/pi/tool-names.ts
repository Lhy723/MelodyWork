import type {
  AgentAdvertisedToolName,
  AgentInternalToolName,
} from "@melody/agent-contract";

/**
 * Stable names for tools exposed through the Pi-to-Host gateway.
 *
 * Each constant is typed by the contract union, so a name that is not declared
 * in `@melody/agent-contract`'s `AGENT_TOOL_NAMES` / `AGENT_INTERNAL_TOOL_NAMES`
 * fails `tsc` instead of drifting silently.
 */
export const PI_WORKSPACE_READ_FILE: AgentAdvertisedToolName =
  "workspace_read_file";
export const PI_WORKSPACE_READ_TOOL_OUTPUT: AgentAdvertisedToolName =
  "workspace_read_tool_output";
export const PI_WORKSPACE_SEARCH: AgentAdvertisedToolName = "workspace_search";
/** Melody-build's `list_dir`, exposed with the workspace-owned prefix. */
export const PI_WORKSPACE_LIST_DIRECTORY: AgentAdvertisedToolName =
  "workspace_list_directory";
export const PI_WORKSPACE_WRITE_FILE: AgentAdvertisedToolName =
  "workspace_write_file";
export const PI_WORKSPACE_EDIT: AgentAdvertisedToolName = "workspace_edit";
export const PI_WORKSPACE_APPLY_PATCH: AgentAdvertisedToolName =
  "workspace_apply_patch";
export const PI_RUN_TERMINAL_COMMAND: AgentAdvertisedToolName =
  "run_terminal_command";
/**
 * Melody's streaming monitor: the Host runs the command and turns every output
 * line into a conversation notification, with its own volume limits.
 */
export const PI_MONITOR: AgentAdvertisedToolName = "monitor";
/**
 * Melody's scheduler tools. A skill that schedules work calls these names, so
 * the Host keeps them rather than inventing a parallel surface.
 */
export const PI_SCHEDULER_CREATE: AgentAdvertisedToolName = "scheduler_create";
export const PI_SCHEDULER_LIST: AgentAdvertisedToolName = "scheduler_list";
export const PI_SCHEDULER_DELETE: AgentAdvertisedToolName = "scheduler_delete";
export const PI_ASK_USER_QUESTION: AgentAdvertisedToolName =
  "ask_user_question";
export const PI_UPDATE_PLAN: AgentAdvertisedToolName = "update_plan";
export const PI_SPAWN_SUBAGENT: AgentAdvertisedToolName = "spawn_subagent";
export const PI_RUN_BACKGROUND_TASK: AgentAdvertisedToolName =
  "run_background_task";
/** Original Melody-build task tool name retained for agent/prompt compatibility. */
export const PI_TASK: AgentAdvertisedToolName = "task";
/** Stable prefix for Host-owned background terminal task ids. */
export const PI_BACKGROUND_TERMINAL_TASK_PREFIX = "pi-terminal-task:" as const;
/** Internal Host bridge used to provision an isolated child worktree. */
export const PI_CREATE_SUBAGENT_WORKTREE: AgentInternalToolName =
  "workspace_create_subagent_worktree";
/** Melody-build-compatible background task inspection controls. */
export const PI_GET_COMMAND_OR_SUBAGENT_OUTPUT: AgentAdvertisedToolName =
  "get_command_or_subagent_output";
export const PI_WAIT_COMMANDS_OR_SUBAGENTS: AgentAdvertisedToolName =
  "wait_commands_or_subagents";
export const PI_KILL_COMMAND_OR_SUBAGENT: AgentAdvertisedToolName =
  "kill_command_or_subagent";
/** Original Melody-build background-task control aliases. */
export const PI_GET_TASK_OUTPUT: AgentAdvertisedToolName = "get_task_output";
export const PI_WAIT_TASKS: AgentAdvertisedToolName = "wait_tasks";
export const PI_KILL_TASK: AgentAdvertisedToolName = "kill_task";
export const PI_MCP_LIST_TOOLS: AgentAdvertisedToolName = "mcp_list_tools";
export const PI_MCP_CALL_TOOL: AgentAdvertisedToolName = "mcp_call_tool";
/** Host-owned network tools that replace Melody-build's web implementations. */
export const PI_WEB_SEARCH: AgentAdvertisedToolName = "web_search";
export const PI_WEB_FETCH: AgentAdvertisedToolName = "web_fetch";
/** Session-scoped native browser tools resolved by the Rust Host. */
export const PI_BROWSER_NAVIGATE: AgentAdvertisedToolName = "browser_navigate";
export const PI_BROWSER_TABS: AgentAdvertisedToolName = "browser_tabs";
export const PI_BROWSER_SNAPSHOT: AgentAdvertisedToolName = "browser_snapshot";
export const PI_BROWSER_WAIT: AgentAdvertisedToolName = "browser_wait";
export const PI_BROWSER_SCREENSHOT: AgentAdvertisedToolName =
  "browser_screenshot";
export const PI_BROWSER_CLICK: AgentAdvertisedToolName = "browser_click";
export const PI_BROWSER_TYPE: AgentAdvertisedToolName = "browser_type";
export const PI_BROWSER_TAB_OPEN: AgentAdvertisedToolName = "browser_tab_open";
export const PI_BROWSER_TAB_SELECT: AgentAdvertisedToolName =
  "browser_tab_select";
export const PI_BROWSER_TAB_CLOSE: AgentAdvertisedToolName =
  "browser_tab_close";
/** Host-owned cross-session memory tools. */
export const PI_MEMORY_SEARCH: AgentAdvertisedToolName = "memory_search";
export const PI_MEMORY_GET: AgentAdvertisedToolName = "memory_get";
/** Append a bounded durable note to the configured Melody memory scope. */
export const PI_MEMORY_REMEMBER: AgentAdvertisedToolName = "memory_remember";
/** Host-owned read-only language-server bridge. */
export const PI_LSP: AgentAdvertisedToolName = "lsp";
/** Host-owned tree-sitter codebase index/navigation bridge. */
export const PI_CODEBASE_NAVIGATION: AgentAdvertisedToolName =
  "codebase_navigation";
/** Internal preflight bridge; never declared as a model-facing Pi tool. */
export const PI_INTERNAL_INSTRUCTION_SCOPE: AgentInternalToolName =
  "melody_internal_instruction_scope";

/**
 * Every tool the Host gateway executes on the model's behalf.
 *
 * This set is load-bearing twice over: the event mapper suppresses the
 * provider-level `toolcall_start`/`toolcall_delta` events for these names (the
 * gateway emits one authoritative request with validated arguments), and the
 * session adapter advertises exactly this set to the Host. A tool missing
 * here would show up as a duplicate tool card with raw arguments and would
 * not appear in the capability announcement.
 *
 * Typed by the contract union so an undeclared name cannot enter the list.
 */
export const PI_GATEWAY_TOOL_NAMES: readonly AgentAdvertisedToolName[] = [
  PI_WORKSPACE_READ_FILE,
  PI_WORKSPACE_READ_TOOL_OUTPUT,
  PI_WORKSPACE_SEARCH,
  PI_WORKSPACE_LIST_DIRECTORY,
  PI_WORKSPACE_WRITE_FILE,
  PI_WORKSPACE_EDIT,
  PI_WORKSPACE_APPLY_PATCH,
  PI_RUN_TERMINAL_COMMAND,
  PI_MONITOR,
  PI_SCHEDULER_CREATE,
  PI_SCHEDULER_LIST,
  PI_SCHEDULER_DELETE,
  PI_ASK_USER_QUESTION,
  PI_UPDATE_PLAN,
  PI_SPAWN_SUBAGENT,
  PI_RUN_BACKGROUND_TASK,
  PI_TASK,
  PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
  PI_WAIT_COMMANDS_OR_SUBAGENTS,
  PI_KILL_COMMAND_OR_SUBAGENT,
  PI_GET_TASK_OUTPUT,
  PI_WAIT_TASKS,
  PI_KILL_TASK,
  PI_MCP_LIST_TOOLS,
  PI_MCP_CALL_TOOL,
  PI_WEB_SEARCH,
  PI_WEB_FETCH,
  PI_BROWSER_NAVIGATE,
  PI_BROWSER_TABS,
  PI_BROWSER_SNAPSHOT,
  PI_BROWSER_WAIT,
  PI_BROWSER_SCREENSHOT,
  PI_BROWSER_CLICK,
  PI_BROWSER_TYPE,
  PI_BROWSER_TAB_OPEN,
  PI_BROWSER_TAB_SELECT,
  PI_BROWSER_TAB_CLOSE,
  PI_MEMORY_SEARCH,
  PI_MEMORY_GET,
  PI_MEMORY_REMEMBER,
  PI_LSP,
  PI_CODEBASE_NAVIGATION,
];
