import { isAgentSessionModeId } from "@melody/agent-contract";
import {
  PI_ASK_USER_QUESTION,
  PI_BROWSER_CLICK,
  PI_BROWSER_NAVIGATE,
  PI_BROWSER_SNAPSHOT,
  PI_BROWSER_SCREENSHOT,
  PI_BROWSER_TAB_CLOSE,
  PI_BROWSER_TAB_OPEN,
  PI_BROWSER_TAB_SELECT,
  PI_BROWSER_TABS,
  PI_BROWSER_TYPE,
  PI_BROWSER_WAIT,
  PI_CODEBASE_NAVIGATION,
  PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
  PI_GET_TASK_OUTPUT,
  PI_KILL_COMMAND_OR_SUBAGENT,
  PI_KILL_TASK,
  PI_LSP,
  PI_MEMORY_GET,
  PI_MEMORY_REMEMBER,
  PI_MEMORY_SEARCH,
  PI_MCP_LIST_TOOLS,
  PI_MONITOR,
  PI_RUN_BACKGROUND_TASK,
  PI_RUN_TERMINAL_COMMAND,
  PI_SCHEDULER_CREATE,
  PI_SCHEDULER_DELETE,
  PI_SCHEDULER_LIST,
  PI_SPAWN_SUBAGENT,
  PI_TASK,
  PI_UPDATE_PLAN,
  PI_WAIT_COMMANDS_OR_SUBAGENTS,
  PI_WAIT_TASKS,
  PI_WEB_FETCH,
  PI_WEB_SEARCH,
  PI_WORKSPACE_APPLY_PATCH,
  PI_WORKSPACE_EDIT,
  PI_WORKSPACE_LIST_DIRECTORY,
  PI_WORKSPACE_READ_FILE,
  PI_WORKSPACE_READ_TOOL_OUTPUT,
  PI_WORKSPACE_SEARCH,
  PI_WORKSPACE_WRITE_FILE,
} from "./tool-names.ts";

/** Capability ceilings understood by Melody-build's subagent tool. */
export type PiSubagentCapabilityMode =
  "read-only" | "read-write" | "read-write-execute" | "execute" | "all";

/** Match Melody-build's capability intersection semantics. */
export const intersectPiSubagentCapabilityModes = (
  requested: PiSubagentCapabilityMode | undefined,
  ceiling: PiSubagentCapabilityMode | undefined,
): PiSubagentCapabilityMode | undefined => {
  if (!requested) return ceiling;
  if (!ceiling) return requested;
  if (requested === "all") return ceiling;
  if (ceiling === "all") return requested;
  if (requested === "read-only" || ceiling === "read-only") {
    return "read-only";
  }
  if (requested === ceiling) return requested;
  // `read-write-execute` is the union of the two disjoint mutation classes, so
  // it narrows to whichever side the other ceiling allows.
  if (requested === "read-write-execute" || ceiling === "read-write-execute") {
    const other = requested === "read-write-execute" ? ceiling : requested;
    return other === "read-write" || other === "execute" ? other : "read-only";
  }
  // `read-write` and `execute` expose disjoint mutation classes; their safe
  // intersection is the common read-only subset.
  return "read-only";
};

const SUBAGENT_READ_ONLY_TOOLS = new Set<string>([
  PI_WORKSPACE_READ_FILE,
  PI_WORKSPACE_READ_TOOL_OUTPUT,
  PI_WORKSPACE_SEARCH,
  PI_WORKSPACE_LIST_DIRECTORY,
  PI_ASK_USER_QUESTION,
  PI_UPDATE_PLAN,
  PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
  PI_WAIT_COMMANDS_OR_SUBAGENTS,
  PI_KILL_COMMAND_OR_SUBAGENT,
  PI_MCP_LIST_TOOLS,
  PI_SCHEDULER_LIST,
  PI_WEB_SEARCH,
  PI_WEB_FETCH,
  PI_BROWSER_TABS,
  PI_BROWSER_SNAPSHOT,
  PI_BROWSER_WAIT,
  PI_BROWSER_SCREENSHOT,
  PI_MEMORY_SEARCH,
  PI_MEMORY_GET,
  PI_LSP,
  PI_CODEBASE_NAVIGATION,
  PI_SPAWN_SUBAGENT,
  PI_RUN_BACKGROUND_TASK,
  PI_TASK,
  PI_GET_TASK_OUTPUT,
  PI_WAIT_TASKS,
  PI_KILL_TASK,
]);

const SUBAGENT_READ_WRITE_TOOLS = new Set<string>([
  ...SUBAGENT_READ_ONLY_TOOLS,
  PI_WORKSPACE_WRITE_FILE,
  PI_WORKSPACE_EDIT,
  PI_WORKSPACE_APPLY_PATCH,
  PI_MEMORY_REMEMBER,
  PI_SCHEDULER_CREATE,
  PI_SCHEDULER_DELETE,
]);

const SUBAGENT_EXECUTE_TOOLS = new Set<string>([
  ...SUBAGENT_READ_ONLY_TOOLS,
  PI_BROWSER_NAVIGATE,
  PI_BROWSER_CLICK,
  PI_BROWSER_TYPE,
  PI_BROWSER_TAB_OPEN,
  PI_BROWSER_TAB_SELECT,
  PI_BROWSER_TAB_CLOSE,
  PI_RUN_TERMINAL_COMMAND,
  PI_MONITOR,
]);

/**
 * Local mutations plus a terminal. Melody's agent definitions commonly
 * request `Read`, `Write`, `Edit`, `Bash`, and `Grep`; without this ceiling the
 * only way to express a write-capable terminal child would be `all`, which
 * would additionally grant MCP calls the definition never listed.
 */
const SUBAGENT_READ_WRITE_EXECUTE_TOOLS = new Set<string>([
  ...SUBAGENT_READ_WRITE_TOOLS,
  PI_BROWSER_NAVIGATE,
  PI_BROWSER_CLICK,
  PI_BROWSER_TYPE,
  PI_BROWSER_TAB_OPEN,
  PI_BROWSER_TAB_SELECT,
  PI_BROWSER_TAB_CLOSE,
  PI_RUN_TERMINAL_COMMAND,
  PI_MONITOR,
]);

/** Return whether a child is allowed to see/call a given gateway tool. */
export const subagentCapabilityAllowsTool = (
  mode: PiSubagentCapabilityMode,
  toolName: string,
): boolean => {
  if (mode === "all") return true;
  if (mode === "read-only") return SUBAGENT_READ_ONLY_TOOLS.has(toolName);
  if (mode === "read-write") return SUBAGENT_READ_WRITE_TOOLS.has(toolName);
  if (mode === "read-write-execute") {
    return SUBAGENT_READ_WRITE_EXECUTE_TOOLS.has(toolName);
  }
  return SUBAGENT_EXECUTE_TOOLS.has(toolName);
};

/**
 * Pi does not have ACP's product session modes. Keep their semantics at the
 * ToolGateway boundary instead of relying on the model to follow a prompt: a
 * model in plan/ask mode must not gain write or process capabilities just
 * because the user selected an auto-approve permission mode.
 */
export const sessionModeAllowsTool = (
  sessionModeId: string | undefined,
  toolName: string,
): boolean => {
  const mode = sessionModeId ?? "default";
  if (!isAgentSessionModeId(mode) || mode === "default")
    return mode === "default";
  if (mode === "plan") {
    return (
      toolName === PI_WORKSPACE_READ_FILE ||
      toolName === PI_WORKSPACE_READ_TOOL_OUTPUT ||
      toolName === PI_WORKSPACE_SEARCH ||
      toolName === PI_WORKSPACE_LIST_DIRECTORY ||
      toolName === PI_ASK_USER_QUESTION ||
      toolName === PI_UPDATE_PLAN ||
      toolName === PI_MCP_LIST_TOOLS ||
      toolName === PI_WEB_SEARCH ||
      toolName === PI_WEB_FETCH ||
      toolName === PI_BROWSER_SNAPSHOT ||
      toolName === PI_BROWSER_WAIT ||
      toolName === PI_BROWSER_SCREENSHOT ||
      toolName === PI_BROWSER_TABS ||
      toolName === PI_MEMORY_SEARCH ||
      toolName === PI_MEMORY_GET ||
      toolName === PI_LSP ||
      toolName === PI_CODEBASE_NAVIGATION
    );
  }
  // Ask mode may inspect the workspace and ask a clarifying question, but it
  // must not mutate files, run commands, update a plan, or delegate work.
  return (
    toolName === PI_WORKSPACE_READ_FILE ||
    toolName === PI_WORKSPACE_READ_TOOL_OUTPUT ||
    toolName === PI_WORKSPACE_SEARCH ||
    toolName === PI_WORKSPACE_LIST_DIRECTORY ||
    toolName === PI_ASK_USER_QUESTION ||
    toolName === PI_MCP_LIST_TOOLS ||
    toolName === PI_WEB_SEARCH ||
    toolName === PI_WEB_FETCH ||
    toolName === PI_BROWSER_SNAPSHOT ||
    toolName === PI_BROWSER_WAIT ||
    toolName === PI_BROWSER_SCREENSHOT ||
    toolName === PI_BROWSER_TABS ||
    toolName === PI_MEMORY_SEARCH ||
    toolName === PI_MEMORY_GET ||
    toolName === PI_LSP ||
    toolName === PI_CODEBASE_NAVIGATION
  );
};
