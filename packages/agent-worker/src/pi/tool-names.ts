/** Stable names for tools exposed through the Pi-to-Host gateway. */
export const PI_WORKSPACE_READ_FILE = "workspace_read_file" as const;
export const PI_WORKSPACE_READ_TOOL_OUTPUT =
  "workspace_read_tool_output" as const;
export const PI_WORKSPACE_SEARCH = "workspace_search" as const;
/** Melody-build's `list_dir`, exposed with the workspace-owned prefix. */
export const PI_WORKSPACE_LIST_DIRECTORY = "workspace_list_directory" as const;
export const PI_WORKSPACE_WRITE_FILE = "workspace_write_file" as const;
export const PI_WORKSPACE_EDIT = "workspace_edit" as const;
export const PI_WORKSPACE_APPLY_PATCH = "workspace_apply_patch" as const;
export const PI_RUN_TERMINAL_COMMAND = "run_terminal_command" as const;
/**
 * Melody's streaming monitor: the Host runs the command and turns every output
 * line into a conversation notification, with its own volume limits.
 */
export const PI_MONITOR = "monitor" as const;
/**
 * Melody's scheduler tools. A skill that schedules work calls these names, so
 * the Host keeps them rather than inventing a parallel surface.
 */
export const PI_SCHEDULER_CREATE = "scheduler_create" as const;
export const PI_SCHEDULER_LIST = "scheduler_list" as const;
export const PI_SCHEDULER_DELETE = "scheduler_delete" as const;
export const PI_ASK_USER_QUESTION = "ask_user_question" as const;
export const PI_UPDATE_PLAN = "update_plan" as const;
export const PI_SPAWN_SUBAGENT = "spawn_subagent" as const;
export const PI_RUN_BACKGROUND_TASK = "run_background_task" as const;
/** Original Melody-build task tool name retained for agent/prompt compatibility. */
export const PI_TASK = "task" as const;
/** Stable prefix for Host-owned background terminal task ids. */
export const PI_BACKGROUND_TERMINAL_TASK_PREFIX = "pi-terminal-task:" as const;
/** Internal Host bridge used to provision an isolated child worktree. */
export const PI_CREATE_SUBAGENT_WORKTREE =
  "workspace_create_subagent_worktree" as const;
/** Melody-build-compatible background task inspection controls. */
export const PI_GET_COMMAND_OR_SUBAGENT_OUTPUT =
  "get_command_or_subagent_output" as const;
export const PI_WAIT_COMMANDS_OR_SUBAGENTS =
  "wait_commands_or_subagents" as const;
export const PI_KILL_COMMAND_OR_SUBAGENT = "kill_command_or_subagent" as const;
/** Original Melody-build background-task control aliases. */
export const PI_GET_TASK_OUTPUT = "get_task_output" as const;
export const PI_WAIT_TASKS = "wait_tasks" as const;
export const PI_KILL_TASK = "kill_task" as const;
export const PI_MCP_LIST_TOOLS = "mcp_list_tools" as const;
export const PI_MCP_CALL_TOOL = "mcp_call_tool" as const;
/** Host-owned network tools that replace Melody-build's web implementations. */
export const PI_WEB_SEARCH = "web_search" as const;
export const PI_WEB_FETCH = "web_fetch" as const;
/** Session-scoped native browser tools resolved by the Rust Host. */
export const PI_BROWSER_NAVIGATE = "browser_navigate" as const;
export const PI_BROWSER_TABS = "browser_tabs" as const;
export const PI_BROWSER_SNAPSHOT = "browser_snapshot" as const;
export const PI_BROWSER_WAIT = "browser_wait" as const;
export const PI_BROWSER_SCREENSHOT = "browser_screenshot" as const;
export const PI_BROWSER_CLICK = "browser_click" as const;
export const PI_BROWSER_TYPE = "browser_type" as const;
export const PI_BROWSER_TAB_OPEN = "browser_tab_open" as const;
export const PI_BROWSER_TAB_SELECT = "browser_tab_select" as const;
export const PI_BROWSER_TAB_CLOSE = "browser_tab_close" as const;
/** Host-owned cross-session memory tools. */
export const PI_MEMORY_SEARCH = "memory_search" as const;
export const PI_MEMORY_GET = "memory_get" as const;
/** Append a bounded durable note to the configured Melody memory scope. */
export const PI_MEMORY_REMEMBER = "memory_remember" as const;
/** Host-owned read-only language-server bridge. */
export const PI_LSP = "lsp" as const;
/** Host-owned tree-sitter codebase index/navigation bridge. */
export const PI_CODEBASE_NAVIGATION = "codebase_navigation" as const;
/** Internal preflight bridge; never declared as a model-facing Pi tool. */
export const PI_INTERNAL_INSTRUCTION_SCOPE =
  "melody_internal_instruction_scope" as const;

/**
 * Every tool the Host gateway executes on the model's behalf.
 *
 * This set is load-bearing twice over: the event mapper suppresses the
 * provider-level `toolcall_start`/`toolcall_delta` events for these names (the
 * gateway emits one authoritative request with validated arguments), and the
 * session adapter advertises exactly this set to the Host. A tool missing
 * here would show up as a duplicate tool card with raw arguments and would
 * not appear in the capability announcement.
 */
export const PI_GATEWAY_TOOL_NAMES = [
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
] as const;
