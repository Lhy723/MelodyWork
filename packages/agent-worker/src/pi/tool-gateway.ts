import type {
  AgentError,
  AgentCommandEnvelope,
  AgentInteractionKind,
  AgentQuestionTimeoutPolicy,
  AgentToolResolution,
  JsonObject,
} from "@melody/agent-contract";
import {
  isAgentSessionModeId,
  type AgentSessionModeId,
} from "@melody/agent-contract";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { WorkerEmitter } from "../protocol.ts";
import {
  parsePiInstructionScopeOutput,
  type PiScopedInstructionFile,
} from "./instruction-scope-extension.ts";

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
 * provider-level `toolcall_start`/`toolcall_delta` events for these names
 * (the gateway emits one authoritative request with validated arguments), and
 * the session adapter advertises exactly this set to the Host. A tool missing
 * here would show up as a duplicate tool card with raw arguments and would not
 * appear in the capability announcement.
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

export const TOOL_GATEWAY_TIMEOUT_MS = 30_000;
/** Match Melody's default ask-user timeout (30 minutes). */
export const INTERACTION_TIMEOUT_MS = 30 * 60_000;
/** Hard foreground terminal ceiling shared with the Host gateway (10 hours). */
export const PI_TERMINAL_MAX_TIMEOUT_MS = 36_000_000;
/** JavaScript's maximum reliable setTimeout delay. */
export const PI_QUESTION_TIMEOUT_MAX_MS = 2_147_483_647;
export const BACKGROUND_TASK_DEFAULT_TIMEOUT_MS = 30_000;
export const BACKGROUND_TASK_MAX_TIMEOUT_MS = 120_000;
const MAX_TASK_CONTROL_OUTPUT_CHARS = 64 * 1024;

export const piInstructionScopePathsFor = (
  toolName: string,
  params: JsonObject,
): string[] => {
  if (
    toolName === PI_WORKSPACE_READ_FILE ||
    toolName === PI_WORKSPACE_WRITE_FILE ||
    toolName === PI_WORKSPACE_EDIT ||
    toolName === PI_WORKSPACE_LIST_DIRECTORY
  ) {
    return typeof params.path === "string" ? [params.path] : [];
  }
  if (toolName === PI_WORKSPACE_SEARCH) {
    return [typeof params.path === "string" ? params.path : "."];
  }
  if (toolName === PI_WORKSPACE_APPLY_PATCH) {
    if (typeof params.patch !== "string") return [];
    const paths = new Set<string>();
    for (const line of params.patch.split("\n")) {
      const file = line
        .trim()
        .match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/u);
      const move = line.trim().match(/^\*\*\* Move to: (.+)$/u);
      const path = file?.[1]?.trim() ?? move?.[1]?.trim();
      if (path) paths.add(path);
      if (paths.size > 64) {
        throw gatewayError(
          "pi.instruction_scope_too_many_paths",
          "单次 patch 涉及的路径过多，无法安全计算目录指令作用域。",
          false,
          "tool",
        );
      }
    }
    return [...paths];
  }
  return [];
};

/** Capability ceilings understood by Melody-build's subagent tool. */
export type PiSubagentCapabilityMode =
  "read-only" | "read-write" | "read-write-execute" | "execute" | "all";

export type PiSubagentIsolation = "none" | "worktree";

export const normalizePiSubagentIsolation = (
  value: unknown,
): PiSubagentIsolation | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw gatewayError(
      "pi.invalid_subagent_isolation",
      "子代理 isolation 必须是 none 或 worktree。",
      false,
      "run",
    );
  }
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "none") return "none";
  if (normalized === "worktree" || normalized === "work-tree") {
    return "worktree";
  }
  throw gatewayError(
    "pi.invalid_subagent_isolation",
    `不支持的子代理 isolation：${value}。可选值为 none、worktree。`,
    false,
    "run",
  );
};

const SUBAGENT_CAPABILITY_MODES = new Set<PiSubagentCapabilityMode>([
  "read-only",
  "read-write",
  "read-write-execute",
  "execute",
  "all",
]);

/**
 * Normalize the aliases accepted by Melody-build while rejecting unknown
 * values. A malformed capability request must fail closed instead of silently
 * granting the child the parent's full toolset.
 */
export const normalizePiSubagentCapabilityMode = (
  value: unknown,
): PiSubagentCapabilityMode | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw gatewayError(
      "pi.invalid_subagent_capability_mode",
      "子代理 capabilityMode 必须是 read-only、read-write、read-write-execute、execute 或 all。",
      false,
      "run",
    );
  }
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const aliases: Record<string, PiSubagentCapabilityMode> = {
    readonly: "read-only",
    "read-only": "read-only",
    readwrite: "read-write",
    "read-write": "read-write",
    readwriteexecute: "read-write-execute",
    "read-write-execute": "read-write-execute",
    execute: "execute",
    all: "all",
  };
  const mode = aliases[normalized];
  if (!mode || !SUBAGENT_CAPABILITY_MODES.has(mode)) {
    throw gatewayError(
      "pi.invalid_subagent_capability_mode",
      `不支持的子代理 capabilityMode：${value}。可选值为 read-only、read-write、read-write-execute、execute、all。`,
      false,
      "run",
    );
  }
  return mode;
};

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
 * Local mutations plus a terminal. Melody's agent definitions commonly request
 * `["Read", "Write", "Edit", "Bash", "Grep"]`; without this ceiling the only
 * way to express a write-capable terminal child would be `all`, which would
 * additionally grant MCP calls the definition never listed.
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

export type PiTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface PiTaskSnapshot {
  taskId: string;
  status: PiTaskStatus;
  output?: string;
  childSessionId?: string;
  parentTaskId?: string;
  role?: string;
  persona?: string;
  agent?: string;
  resumedFrom?: string;
  isolation?: PiSubagentIsolation;
  worktreePath?: string;
}

/**
 * Worker-local controller for the product's background task registry.  The
 * callbacks are deliberately passed into the gateway instead of exposing the
 * registry itself, so a tool can only inspect/cancel tasks visible to its
 * current product session.
 */
export interface PiTaskController {
  wait(input: {
    taskIds: string[];
    mode: "wait_any" | "wait_all";
    timeoutMs: number;
    parentSessionId: string;
  }): Promise<readonly PiTaskSnapshot[]>;
  cancel(input: {
    taskId: string;
    parentSessionId: string;
  }): Promise<PiTaskSnapshot>;
}

const readFileParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative UTF-8 file path." }),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 100_000, description: "First line." }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 10_000,
      description: "Maximum number of lines.",
    }),
  ),
});

const toolOutputParameters = Type.Object({
  path: Type.String({
    description: "Workspace-relative Melody terminal output archive path.",
  }),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 67_108_864,
      description: "Byte offset in the archive.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1_048_576,
      description: "Maximum number of bytes to read.",
    }),
  ),
});

const searchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 256,
    description: "Literal text to search for.",
  }),
  path: Type.Optional(
    Type.String({
      description: "Optional workspace-relative directory or file.",
    }),
  ),
});

const listDirectoryParameters = Type.Object({
  path: Type.String({
    description: "Workspace-relative directory path; use . for the root.",
  }),
  depth: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 8,
      description: "Maximum child depth to include; defaults to 8.",
    }),
  ),
  includeHidden: Type.Optional(
    Type.Boolean({
      description: "Include dot-files and dot-directories when true.",
    }),
  ),
});

const writeFileParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative file path." }),
  content: Type.String({ description: "Complete UTF-8 file content." }),
});

const editParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative file path." }),
  oldText: Type.String({ minLength: 1, description: "Exact text to replace." }),
  newText: Type.String({ description: "Replacement text." }),
  replaceAll: Type.Optional(Type.Boolean()),
});

const patchParameters = Type.Object({
  patch: Type.String({ minLength: 1, description: "A bounded unified diff." }),
});

const terminalParameters = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 16_384 }),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Keep the command running in the Host task registry and return a task_id.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: PI_TERMINAL_MAX_TIMEOUT_MS,
      description:
        "Foreground timeout or background lifetime in milliseconds; 0 means the Host default/no background deadline.",
    }),
  ),
});

const schedulerCreateParameters = Type.Object({
  task_id: Type.Optional(
    Type.String({
      maxLength: 128,
      description: "Optional stable task id; reuse it to update that schedule.",
    }),
  ),
  interval: Type.Optional(
    Type.String({
      minLength: 2,
      maxLength: 32,
      description:
        "Repeat interval such as 5m, 30m, 2h or 1d. Values below 60s are clamped to 60s.",
    }),
  ),
  cron: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description:
        "Optional 5-field cron schedule in the machine's local timezone. Supply either cron or interval, never both.",
    }),
  ),
  prompt: Type.String({
    minLength: 1,
    maxLength: 32_000,
    description: "Prompt text to send to this session on every fire.",
  }),
  fire_immediately: Type.Optional(
    Type.Boolean({
      description:
        "Also fire once as soon as possible, in addition to the recurring schedule.",
    }),
  ),
});

const schedulerListParameters = Type.Object({});

const schedulerDeleteParameters = Type.Object({
  task_id: Type.String({
    minLength: 1,
    maxLength: 128,
    description: "Task id returned by scheduler_create.",
  }),
});

const monitorParameters = Type.Object({
  command: Type.String({
    minLength: 1,
    maxLength: 16_384,
    description:
      "Shell command to watch. Its stdout and stderr are merged and every line becomes a notification; use `grep --line-buffered` in pipelines.",
  }),
  description: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "Short label shown on every notification from this monitor.",
  }),
  persistent: Type.Optional(
    Type.Boolean({
      description: "Keep the monitor running for the lifetime of the session.",
    }),
  ),
});

const questionParameters = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 4_000 }),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.Optional(Type.String({ maxLength: 1_000 })),
      }),
      { maxItems: 8 },
    ),
  ),
  multiple: Type.Optional(Type.Boolean()),
});

const planParameters = Type.Object({
  explanation: Type.Optional(Type.String({ maxLength: 4_000 })),
  plan: Type.Array(
    Type.Object({
      step: Type.String({ minLength: 1, maxLength: 500 }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("blocked"),
      ]),
    }),
    { maxItems: 50 },
  ),
});

const subagentParameters = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 12_000 }),
  resume_from: Type.Optional(
    Type.String({
      maxLength: 512,
      description:
        "Resume a previously completed subagent by task id; its transcript and model are reused.",
    }),
  ),
  /** Camel-case alias retained for Pi callers that do not use Melody names. */
  resumeFrom: Type.Optional(
    Type.String({
      maxLength: 512,
      description: "Alias for resume_from.",
    }),
  ),
  subagentType: Type.Optional(
    Type.Union(
      [
        Type.Literal("general-purpose"),
        Type.Literal("explore"),
        Type.Literal("plan"),
      ],
      {
        description:
          "Child role. explore and plan default to read-only; general-purpose defaults to all.",
      },
    ),
  ),
  role: Type.Optional(
    Type.String({
      maxLength: 128,
      description: "Optional Host-configured subagent role.",
    }),
  ),
  persona: Type.Optional(
    Type.String({
      maxLength: 128,
      description: "Optional Host-configured subagent persona.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      maxLength: 128,
      description:
        "Optional Host-configured declarative agent definition. Definitions with dynamic tools/hooks are unavailable in Pi and reported during capability inspection.",
    }),
  ),
  capabilityMode: Type.Optional(
    Type.Union(
      [
        Type.Literal("read-only"),
        Type.Literal("read-write"),
        Type.Literal("execute"),
        Type.Literal("all"),
      ],
      {
        description:
          "Maximum child tool access. The parent capability ceiling always wins.",
      },
    ),
  ),
  cwd: Type.Optional(
    Type.String({
      maxLength: 4_096,
      description:
        "Optional existing directory inside the authorized workspace. It is ignored when resume_from is set.",
    }),
  ),
  isolation: Type.Optional(
    Type.Union([Type.Literal("none"), Type.Literal("worktree")], {
      description:
        "Execution isolation. none shares the current workspace; worktree creates a managed detached Git worktree.",
    }),
  ),
  modelId: Type.Optional(Type.String({ maxLength: 256 })),
  reasoningEffort: Type.Optional(Type.String({ maxLength: 32 })),
});

/**
 * Wire-compatible shape of Melody-build's original `task` tool. Keep this
 * separate from the Pi-native `spawn_subagent` schema so existing skills can
 * continue sending `prompt`, `subagent_type`, `run_in_background`, `model`,
 * and `capability_mode` without weakening validation of the native tool.
 */
const legacyTaskParameters = Type.Object({
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 12_000 })),
  /** Pi-native alias accepted when a skill is gradually migrated. */
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 12_000 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  subagent_type: Type.Optional(Type.String({ maxLength: 64 })),
  role: Type.Optional(Type.String({ maxLength: 128 })),
  persona: Type.Optional(Type.String({ maxLength: 128 })),
  agent: Type.Optional(Type.String({ maxLength: 128 })),
  run_in_background: Type.Optional(Type.Boolean()),
  capability_mode: Type.Optional(Type.String({ maxLength: 32 })),
  isolation: Type.Optional(Type.String({ maxLength: 32 })),
  resume_from: Type.Optional(Type.String({ maxLength: 512 })),
  cwd: Type.Optional(Type.String({ maxLength: 4_096 })),
  model: Type.Optional(Type.String({ maxLength: 256 })),
});

const backgroundParameters = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 12_000 }),
  resume_from: Type.Optional(
    Type.String({
      maxLength: 512,
      description:
        "Resume a previously completed subagent by task id; its transcript and model are reused.",
    }),
  ),
  /** Camel-case alias retained for Pi callers that do not use Melody names. */
  resumeFrom: Type.Optional(
    Type.String({
      maxLength: 512,
      description: "Alias for resume_from.",
    }),
  ),
  subagentType: Type.Optional(
    Type.Union(
      [
        Type.Literal("general-purpose"),
        Type.Literal("explore"),
        Type.Literal("plan"),
      ],
      {
        description:
          "Child role. explore and plan default to read-only; general-purpose defaults to all.",
      },
    ),
  ),
  role: Type.Optional(
    Type.String({
      maxLength: 128,
      description: "Optional Host-configured subagent role.",
    }),
  ),
  persona: Type.Optional(
    Type.String({
      maxLength: 128,
      description: "Optional Host-configured subagent persona.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      maxLength: 128,
      description:
        "Optional Host-configured declarative agent definition. Definitions with dynamic tools/hooks are unavailable in Pi and reported during capability inspection.",
    }),
  ),
  capabilityMode: Type.Optional(
    Type.Union(
      [
        Type.Literal("read-only"),
        Type.Literal("read-write"),
        Type.Literal("execute"),
        Type.Literal("all"),
      ],
      {
        description:
          "Maximum child tool access. The parent capability ceiling always wins.",
      },
    ),
  ),
  cwd: Type.Optional(
    Type.String({
      maxLength: 4_096,
      description:
        "Optional existing directory inside the authorized workspace. It is ignored when resume_from is set.",
    }),
  ),
  isolation: Type.Optional(
    Type.Union([Type.Literal("none"), Type.Literal("worktree")], {
      description:
        "Execution isolation. none shares the current workspace; worktree creates a managed detached Git worktree.",
    }),
  ),
  modelId: Type.Optional(Type.String({ maxLength: 256 })),
  reasoningEffort: Type.Optional(Type.String({ maxLength: 32 })),
});

/** Original `get_task_output` accepts a list and waits for all on timeout. */
const legacyTaskOutputParameters = Type.Object({
  task_ids: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 20,
  }),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: BACKGROUND_TASK_MAX_TIMEOUT_MS,
    }),
  ),
});

const taskOutputParameters = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: 512 }),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: BACKGROUND_TASK_MAX_TIMEOUT_MS,
      description: "Optional bounded wait before returning the current output.",
    }),
  ),
});

const waitTasksParameters = Type.Object({
  task_ids: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 20,
  }),
  mode: Type.Union([Type.Literal("wait_any"), Type.Literal("wait_all")]),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: BACKGROUND_TASK_MAX_TIMEOUT_MS,
      description: "Maximum time to wait in milliseconds.",
    }),
  ),
});

const killTaskParameters = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: 512 }),
});

const mcpListParameters = Type.Object({
  server: Type.Optional(
    Type.String({
      maxLength: 128,
      description: "Optional configured MCP server name.",
    }),
  ),
});

const mcpCallParameters = Type.Object({
  server: Type.String({
    minLength: 1,
    maxLength: 128,
    description: "Configured local stdio or HTTP/SSE MCP server name.",
  }),
  tool: Type.String({
    minLength: 1,
    maxLength: 256,
    description: "Tool name returned by mcp_list_tools.",
  }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "JSON object passed to the MCP tool.",
    }),
  ),
});

const webSearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description:
      "Natural-language query to search on the configured web provider.",
  }),
  allowedDomains: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
      maxItems: 32,
      description: "Optional domain allowlist passed to the search provider.",
    }),
  ),
});

const webFetchParameters = Type.Object({
  url: Type.String({
    minLength: 1,
    maxLength: 4_096,
    description: "HTTP(S) URL to read through Melody's bounded web gateway.",
  }),
});

const memorySearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 2_048,
    description: "Specific terms to search in cross-session Melody memory.",
  }),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

const memoryGetParameters = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 4_096,
    description: "A Markdown path returned by memory_search.",
  }),
  from: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
});

const memoryRememberParameters = Type.Object({
  content: Type.String({
    minLength: 1,
    maxLength: 16_384,
    description: "A durable Markdown note to append to Melody memory.",
  }),
  scope: Type.Optional(
    Type.Union([Type.Literal("workspace"), Type.Literal("global")], {
      description:
        "Where to save the note. Workspace is the default; global applies across projects.",
    }),
  ),
});

const lspParameters = Type.Object({
  operation: Type.Union(
    [
      Type.Literal("goToDefinition"),
      Type.Literal("definition"),
      Type.Literal("findReferences"),
      Type.Literal("references"),
      Type.Literal("hover"),
      Type.Literal("goToImplementation"),
      Type.Literal("implementation"),
      Type.Literal("documentSymbol"),
      Type.Literal("documentSymbols"),
      Type.Literal("workspaceSymbol"),
      Type.Literal("workspaceSymbols"),
    ],
    { description: "Read-only language-server operation." },
  ),
  file_path: Type.Optional(
    Type.String({
      maxLength: 4_096,
      description: "Workspace-relative UTF-8 file path for file operations.",
    }),
  ),
  line: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 100_000,
      description: "Zero-based line for definition/reference/hover operations.",
    }),
  ),
  character: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 100_000,
      description:
        "Zero-based character for definition/reference/hover operations.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      maxLength: 2_048,
      description: "Symbol query for workspaceSymbol.",
    }),
  ),
});

const codebaseNavigationParameters = Type.Object({
  operation: Type.Union(
    [
      Type.Literal("definition"),
      Type.Literal("goToDefinition"),
      Type.Literal("references"),
      Type.Literal("findReferences"),
      Type.Literal("documentSymbol"),
      Type.Literal("documentSymbols"),
      Type.Literal("workspaceSymbol"),
      Type.Literal("workspaceSymbols"),
      Type.Literal("status"),
      Type.Literal("indexStatus"),
      Type.Literal("rebuild"),
      Type.Literal("refresh"),
    ],
    { description: "Read-only tree-sitter codebase navigation operation." },
  ),
  file_path: Type.Optional(
    Type.String({
      maxLength: 4_096,
      description: "Workspace-relative source file for navigation.",
    }),
  ),
  line: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 100_000,
      description: "Zero-based source line for definition/reference queries.",
    }),
  ),
  character: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 100_000,
      description: "Zero-based byte column for definition/reference queries.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      maxLength: 256,
      description: "Case-insensitive symbol fragment for workspace symbols.",
    }),
  ),
  include_definition: Type.Optional(
    Type.Boolean({
      description:
        "Include the declaration itself in references results (default true).",
    }),
  ),
});

type GatewayToolResultDetails = {
  gateway: "melody";
  toolName: string;
  approved?: boolean;
  taskId?: string;
};

interface PendingToolCall {
  sessionId: string;
  rootSessionId?: string;
  runId?: string;
  resolve: (resolution: AgentToolResolution) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingInteraction {
  sessionId: string;
  rootSessionId?: string;
  runId?: string;
  kind: AgentInteractionKind;
  resolve: (resolution: JsonObject) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const gatewayError = (
  code: string,
  message: string,
  retriable = false,
  scope: AgentError["scope"] = "tool",
): Error & { agentError: AgentError } => {
  const error = new Error(message) as Error & { agentError: AgentError };
  error.agentError = { code, message, retriable, scope };
  return error;
};

/** Resolve the timer used for a product question interaction. Permissions and
 * plan confirmations keep the gateway's fixed safety timeout; only the
 * user-question tool follows Melody's configurable policy. `0` means the
 * configured policy intentionally waits forever. */
export const interactionTimeoutMsFor = (
  kind: AgentInteractionKind,
  policy?: AgentQuestionTimeoutPolicy,
): number => {
  if (kind !== "question" || !policy) return INTERACTION_TIMEOUT_MS;
  if (!policy.enabled) return 0;
  if (
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1 ||
    policy.timeoutMs > PI_QUESTION_TIMEOUT_MAX_MS
  ) {
    return INTERACTION_TIMEOUT_MS;
  }
  return policy.timeoutMs;
};

const textResult = (
  output: string,
  toolName: string,
  approved?: boolean,
  taskId?: string,
): AgentToolResult<GatewayToolResultDetails> => ({
  content: [{ type: "text", text: output }],
  details: {
    gateway: "melody",
    toolName,
    ...(approved === undefined ? {} : { approved }),
    ...(taskId === undefined ? {} : { taskId }),
  },
});

const browserScreenshotResult = (
  output: string,
  toolName: string,
  approved?: boolean,
): AgentToolResult<GatewayToolResultDetails> => {
  const prefix = "data:image/jpeg;base64,";
  const data = output.startsWith(prefix) ? output.slice(prefix.length) : "";
  if (
    !data ||
    data.length > 700_000 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
  ) {
    throw gatewayError(
      "pi.browser_screenshot_invalid",
      "Host returned an invalid or oversized browser screenshot.",
      false,
    );
  }
  return {
    content: [
      { type: "image", data, mimeType: "image/jpeg" },
      { type: "text", text: "Current approved Browser viewport screenshot." },
    ],
    details: {
      gateway: "melody",
      toolName,
      ...(approved === undefined ? {} : { approved }),
    },
  };
};

const boundedTaskSnapshots = (
  snapshots: readonly PiTaskSnapshot[],
): PiTaskSnapshot[] =>
  snapshots.map((snapshot) => {
    if (
      !snapshot.output ||
      snapshot.output.length <= MAX_TASK_CONTROL_OUTPUT_CHARS
    ) {
      return { ...snapshot };
    }
    return {
      ...snapshot,
      output: `${snapshot.output.slice(0, MAX_TASK_CONTROL_OUTPUT_CHARS)}\n[task output truncated]`,
    };
  });

const taskSnapshotsResult = (
  snapshots: readonly PiTaskSnapshot[],
  toolName: string,
): AgentToolResult<GatewayToolResultDetails> =>
  textResult(JSON.stringify(boundedTaskSnapshots(snapshots)), toolName, true);

const taskSnapshotResult = (
  snapshot: PiTaskSnapshot,
  toolName: string,
): AgentToolResult<GatewayToolResultDetails> =>
  textResult(
    JSON.stringify(boundedTaskSnapshots([snapshot])[0]),
    toolName,
    true,
  );

const legacyTaskText = (input: {
  taskId: string;
  output?: string;
  subagentType?: string;
  background: boolean;
}): string => {
  const type = input.subagentType ?? "general-purpose";
  if (input.background) {
    return [
      "Subagent started in background.",
      `subagent_id: ${input.taskId}`,
      `type: ${type}`,
      "Use get_task_output with task_ids and timeout_ms to retrieve the result.",
    ].join("\n");
  }
  return [
    input.output ?? `Subagent ${input.taskId} 已完成。`,
    "",
    "<subagent_result>",
    `subagent_id: ${input.taskId}`,
    `subagent_type: ${type}`,
    `To continue this subagent's conversation, use resume_from=\"${input.taskId}\".`,
    "</subagent_result>",
  ].join("\n");
};

const responseOutcome = (resolution: JsonObject): string => {
  const nested = resolution.resolution;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return responseOutcome(nested as JsonObject);
  }
  const outcome = resolution.outcome;
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    return responseOutcome(outcome as JsonObject);
  }
  return typeof outcome === "string" ? outcome.toLowerCase() : "";
};

const responseOptionId = (resolution: JsonObject): string => {
  if (typeof resolution.optionId === "string") {
    return resolution.optionId;
  }
  const nested = resolution.resolution;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return responseOptionId(nested as JsonObject);
  }
  const outcome = resolution.outcome;
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    return responseOptionId(outcome as JsonObject);
  }
  return "";
};

const isAllowedPermissionOutcome = (resolution: JsonObject): boolean => {
  const outcome = responseOutcome(resolution);
  const optionId = responseOptionId(resolution);
  return (
    outcome === "allow_once" ||
    outcome === "allow_always" ||
    outcome === "allow" ||
    optionId === "allow_once" ||
    optionId === "allow_always"
  );
};

/**
 * Keep the persisted project-permission identity small and deterministic.
 * Sending complete write contents or patch bodies in an interaction would
 * leak data into the product event log and would make an "always allow"
 * rule match only one exact invocation. The Host derives the same key from
 * the subsequent tool request.
 */
const permissionRawInput = (
  toolName: string,
  params: JsonObject,
): JsonObject => {
  if (toolName === PI_RUN_TERMINAL_COMMAND || toolName === PI_MONITOR) {
    return {
      command: typeof params.command === "string" ? params.command : "",
    };
  }
  if (toolName === PI_WORKSPACE_WRITE_FILE || toolName === PI_WORKSPACE_EDIT) {
    return { path: typeof params.path === "string" ? params.path : "" };
  }
  if (toolName === PI_WORKSPACE_APPLY_PATCH) {
    return { command: "apply_patch" };
  }
  if (toolName === PI_SCHEDULER_CREATE) {
    // The prompt may contain user data, so the durable rule identity is only
    // the schedule expression, never the scheduled prompt contents.
    return {
      command:
        typeof params.cron === "string"
          ? params.cron
          : typeof params.interval === "string"
            ? params.interval
            : "",
    };
  }
  if (toolName === PI_SCHEDULER_DELETE) {
    return {
      command: typeof params.task_id === "string" ? params.task_id : "",
    };
  }
  if (toolName === PI_MCP_CALL_TOOL) {
    return {
      server: typeof params.server === "string" ? params.server : "",
      tool: typeof params.tool === "string" ? params.tool : "",
    };
  }
  if (toolName === PI_BROWSER_NAVIGATE) {
    try {
      const url = new URL(typeof params.url === "string" ? params.url : "");
      return { command: `${url.origin}${url.pathname}`.slice(0, 512) };
    } catch {
      return { command: "invalid browser URL" };
    }
  }
  if (toolName === PI_BROWSER_CLICK || toolName === PI_BROWSER_TYPE) {
    return {
      command: `${toolName}:${typeof params.ref_id === "string" ? params.ref_id : "unknown"}`,
      ...(toolName === PI_BROWSER_TYPE
        ? {
            textPreview:
              typeof params.text === "string" ? params.text.slice(0, 120) : "",
          }
        : {}),
    };
  }
  if (toolName === PI_MEMORY_REMEMBER) {
    // Keep the durable-memory permission identity stable across different
    // note contents. A project rule should authorize the selected scope, not
    // just one exact sentence that happened to be saved earlier.
    return {
      scope: typeof params.scope === "string" ? params.scope : "workspace",
    };
  }
  return {};
};

/**
 * Pi does not have ACP's product session modes. Keep their semantics at the
 * ToolGateway boundary instead of relying on the model to follow a prompt:
 * a model in plan/ask mode must not gain write or process capabilities just
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

const modeLabel = (mode: AgentSessionModeId): string => {
  switch (mode) {
    case "default":
      return "代理";
    case "plan":
      return "规划";
    case "ask":
      return "问答";
  }
};

/**
 * Worker-side half of the ToolGateway. Pi receives only these explicit
 * proxies; every filesystem, shell and user-interaction side effect remains
 * implemented by the Rust Host.
 */
export class PiToolGateway {
  private readonly pending = new Map<string, PendingToolCall>();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly emit: WorkerEmitter;

  public constructor(emit: WorkerEmitter) {
    this.emit = emit;
  }

  public async request(input: {
    sessionId: string;
    rootSessionId?: string;
    runId?: string;
    cwd?: string;
    toolCallId: string;
    toolName: string;
    arguments: JsonObject;
    permissionMode?: "ask" | "auto" | "always-approve";
    approved?: boolean;
  }): Promise<AgentToolResolution> {
    if (this.pending.has(input.toolCallId)) {
      throw gatewayError(
        "pi.tool_call_duplicate",
        `Pi tool call 已在等待宿主响应：${input.toolCallId}。`,
      );
    }
    const response = new Promise<AgentToolResolution>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(input.toolCallId);
        reject(
          gatewayError(
            "pi.tool_gateway_timeout",
            `ToolGateway 在 ${TOOL_GATEWAY_TIMEOUT_MS / 1000} 秒内没有返回结果。`,
            true,
          ),
        );
      }, TOOL_GATEWAY_TIMEOUT_MS);
      this.pending.set(input.toolCallId, {
        sessionId: input.sessionId,
        ...(input.rootSessionId ? { rootSessionId: input.rootSessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        resolve,
        reject,
        timer,
      });
    });

    try {
      await this.emit({
        sessionId: input.rootSessionId ?? input.sessionId,
        ...(input.rootSessionId && input.rootSessionId !== input.sessionId
          ? { streamSessionId: input.sessionId }
          : {}),
        runId: input.runId,
        event: {
          type: "tool.requested",
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          status: "pending",
          activity: {
            gateway: "melody",
            arguments: input.arguments,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.permissionMode
              ? { permissionMode: input.permissionMode }
              : {}),
            ...(input.approved === undefined
              ? {}
              : { approved: input.approved }),
          },
        },
      });
      return await response;
    } finally {
      const pending = this.pending.get(input.toolCallId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(input.toolCallId);
      }
    }
  }

  public async requestInteraction(input: {
    sessionId: string;
    rootSessionId?: string;
    runId?: string;
    interactionId: string;
    kind: AgentInteractionKind;
    payload: JsonObject;
    timeoutMs?: number;
  }): Promise<JsonObject> {
    if (this.interactions.has(input.interactionId)) {
      throw gatewayError(
        "pi.interaction_duplicate",
        `Pi interaction 已在等待响应：${input.interactionId}。`,
        false,
        "interaction",
      );
    }
    const response = new Promise<JsonObject>((resolve, reject) => {
      const timer =
        input.timeoutMs === undefined
          ? setTimeout(() => {
              this.interactions.delete(input.interactionId);
              reject(
                gatewayError(
                  "pi.interaction_timeout",
                  "交互请求等待超时，已自动取消。",
                  true,
                  "interaction",
                ),
              );
            }, INTERACTION_TIMEOUT_MS)
          : input.timeoutMs > 0
            ? setTimeout(() => {
                this.interactions.delete(input.interactionId);
                reject(
                  gatewayError(
                    "pi.interaction_timeout",
                    "交互请求等待超时，已自动取消。",
                    true,
                    "interaction",
                  ),
                );
              }, input.timeoutMs)
            : undefined;
      this.interactions.set(input.interactionId, {
        sessionId: input.sessionId,
        ...(input.rootSessionId ? { rootSessionId: input.rootSessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        kind: input.kind,
        resolve,
        reject,
        timer,
      });
    });
    try {
      await this.emit({
        sessionId: input.rootSessionId ?? input.sessionId,
        ...(input.rootSessionId && input.rootSessionId !== input.sessionId
          ? { streamSessionId: input.sessionId }
          : {}),
        runId: input.runId,
        event: {
          type: "interaction.requested",
          interactionId: input.interactionId,
          kind: input.kind,
          payload: input.payload,
        },
      });
      return await response;
    } finally {
      const pending = this.interactions.get(input.interactionId);
      if (pending?.timer) {
        clearTimeout(pending.timer);
        this.interactions.delete(input.interactionId);
      } else if (pending) {
        this.interactions.delete(input.interactionId);
      }
    }
  }

  public resolve(
    command: Extract<AgentCommandEnvelope["command"], { type: "tool.resolve" }>,
  ): void {
    const pending = this.pending.get(command.toolCallId);
    if (!pending) {
      throw gatewayError(
        "pi.tool_call_not_found",
        `没有等待中的 Pi tool call：${command.toolCallId}。`,
      );
    }
    // A late response from an older run must never be allowed to resolve a
    // reused tool-call id in the current run. Older Hosts may omit runId, so
    // the check is strict only when the command carries that assertion.
    if (command.runId !== undefined && pending.runId !== command.runId) {
      throw gatewayError(
        "pi.tool_call_run_mismatch",
        `Tool call ${command.toolCallId} 不属于运行 ${command.runId}。`,
      );
    }
    if (
      pending.sessionId !== command.sessionId &&
      pending.rootSessionId !== command.sessionId
    ) {
      throw gatewayError(
        "pi.tool_call_session_mismatch",
        `Tool call ${command.toolCallId} 不属于当前会话。`,
      );
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(command.toolCallId);
    pending.resolve(command.resolution);
  }

  public resolveInteraction(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "interaction.resolve" }
    >,
  ): void {
    const pending = this.interactions.get(command.interactionId);
    if (!pending) {
      throw gatewayError(
        "pi.interaction_not_found",
        `没有等待中的 Pi interaction：${command.interactionId}。`,
        false,
        "interaction",
      );
    }
    if (
      pending.sessionId !== command.sessionId &&
      pending.rootSessionId !== command.sessionId
    ) {
      throw gatewayError(
        "pi.interaction_session_mismatch",
        `Interaction ${command.interactionId} 不属于当前会话。`,
        false,
        "interaction",
      );
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.interactions.delete(command.interactionId);
    pending.resolve(command.resolution);
    // A resolution has already been delivered to Pi at this point. Event
    // emission is best effort; an unavailable writer must not turn a valid
    // user response into an unhandled rejection in the stdin pump.
    void Promise.resolve(
      this.emit({
        sessionId: pending.rootSessionId ?? pending.sessionId,
        ...(pending.rootSessionId && pending.rootSessionId !== pending.sessionId
          ? { streamSessionId: pending.sessionId }
          : {}),
        ...(pending.runId ? { runId: pending.runId } : {}),
        event: {
          type: "interaction.resolved",
          interactionId: command.interactionId,
          kind: pending.kind,
          payload: { resolution: command.resolution },
        },
      }),
    ).catch(() => undefined);
  }

  public rejectAll(message = "Pi worker 已关闭，网关请求未完成。") {
    for (const [toolCallId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(gatewayError("pi.tool_gateway_closed", message, true));
      this.pending.delete(toolCallId);
    }
    for (const [interactionId, pending] of this.interactions) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        gatewayError("pi.interaction_closed", message, true, "interaction"),
      );
      this.interactions.delete(interactionId);
    }
  }

  public createTools(
    sessionId: () => string,
    runId: () => string | undefined,
    permissionMode: () => "ask" | "auto" | "always-approve",
    cwd: () => string | undefined,
    spawnSubagent?: (input: {
      task: string;
      resumeFrom?: string;
      subagentType?: string;
      role?: string;
      persona?: string;
      agent?: string;
      capabilityMode?: string;
      cwd?: string;
      isolation?: string;
      modelId?: string;
      reasoningEffort?: string;
      background: boolean;
      parentSessionId: string;
    }) => Promise<{ taskId: string; output?: string; worktreePath?: string }>,
    rootSessionId: () => string = sessionId,
    sessionModeId: () => string | undefined = () => "default",
    taskController?: PiTaskController,
    /** Host-resolved Melody `[tools].respect_gitignore` policy. */
    respectGitignore: () => boolean = () => false,
    /** Host-resolved Melody `ask_user_question` wait policy. */
    questionTimeoutPolicy: () => AgentQuestionTimeoutPolicy | undefined = () =>
      undefined,
    /** Effective capability ceiling for this Pi child session. */
    capabilityMode: () => PiSubagentCapabilityMode = () => "all",
    /**
     * Exact `mcp__<server>__<tool>` grants for a child whose ceiling is not
     * `all`. Melody agent definitions list MCP tools by name, so a child may
     * call only those; an empty set withholds MCP calls entirely.
     */
    mcpTools: () => ReadonlySet<string> | undefined = () => undefined,
    activateScopedInstructions?: (
      files: readonly PiScopedInstructionFile[],
    ) => number,
  ): ToolDefinition[] {
    const ensureToolAllowed = (toolName: string): void => {
      const mode = sessionModeId() ?? "default";
      if (sessionModeAllowsTool(mode, toolName)) return;
      const label = isAgentSessionModeId(mode) ? modeLabel(mode) : mode;
      throw gatewayError(
        "pi.session_mode_restricted",
        `${label}模式不允许使用工具 ${toolName}。请切换到代理模式后再试。`,
        false,
        "tool",
      );
    };

    const ensureSubagentCapability = (toolName: string): void => {
      const mode = capabilityMode();
      if (subagentCapabilityAllowsTool(mode, toolName)) return;
      // `mcp_call_tool` is not part of a bounded ceiling; its own per-call
      // grant check (below) is what decides an individual MCP call.
      if (toolName === PI_MCP_CALL_TOOL && mcpCallAllowed()) return;
      throw gatewayError(
        "pi.subagent_capability_restricted",
        `子代理 capabilityMode=${mode} 不允许使用工具 ${toolName}。`,
        false,
        "tool",
      );
    };

    /**
     * A child with a bounded ceiling may still call the MCP tools its agent
     * definition named. The grant is per `mcp__<server>__<tool>`, so it never
     * widens into the rest of that server's surface.
     */
    const ensureMcpToolGranted = (server: string, tool: string): void => {
      if (capabilityMode() === "all") return;
      const allowlist = mcpTools();
      const qualified = `mcp__${server}__${tool}`;
      if (allowlist?.has(qualified)) return;
      throw gatewayError(
        "pi.subagent_capability_restricted",
        `子代理策略未授予 MCP 工具 ${qualified}。`,
        false,
        "tool",
      );
    };

    const mcpCallAllowed = (): boolean =>
      capabilityMode() === "all" || (mcpTools()?.size ?? 0) > 0;

    const execute = async (
      toolName: string,
      toolCallId: string,
      params: JsonObject,
      requiresPermission = false,
    ): Promise<AgentToolResult<GatewayToolResultDetails>> => {
      ensureToolAllowed(toolName);
      ensureSubagentCapability(toolName);
      if (toolName === PI_SCHEDULER_CREATE) {
        const hasInterval = typeof params.interval === "string";
        const hasCron = typeof params.cron === "string";
        if (hasInterval === hasCron) {
          throw gatewayError(
            "pi.scheduler_invalid_schedule",
            "scheduler_create 需要且只能提供 interval 或 cron 其中一项。",
            false,
            "tool",
          );
        }
      }
      if (activateScopedInstructions) {
        const paths = piInstructionScopePathsFor(toolName, params);
        if (paths.length > 0) {
          const scopeResolution = await this.request({
            sessionId: sessionId(),
            rootSessionId: rootSessionId(),
            runId: runId(),
            cwd: cwd(),
            toolCallId: `${PI_INTERNAL_INSTRUCTION_SCOPE}:${toolCallId}`,
            toolName: PI_INTERNAL_INSTRUCTION_SCOPE,
            arguments: { paths },
            permissionMode: permissionMode(),
            approved: true,
          });
          if (scopeResolution.status !== "completed") {
            throw gatewayError(
              scopeResolution.error?.code ?? "pi.instruction_scope_failed",
              scopeResolution.error?.message ??
                "宿主无法解析目标路径适用的项目指令文件。",
              scopeResolution.error?.retriable ?? false,
              "tool",
            );
          }
          const scopedFiles = parsePiInstructionScopeOutput(
            scopeResolution.output ?? "",
          );
          if (activateScopedInstructions(scopedFiles) > 0) {
            return textResult(
              "已将目标路径适用的项目指令加入本会话系统上下文；尚未执行原文件操作，请在遵循新指令后重试。",
              toolName,
            );
          }
        }
      }
      let approved: boolean | undefined;
      const explicitApprovalRequired =
        requiresPermission &&
        (permissionMode() === "ask" || toolName.startsWith("browser_"));
      if (explicitApprovalRequired) {
        const interactionId = `${sessionId()}:permission:${toolCallId}`;
        const resolution = await this.requestInteraction({
          sessionId: sessionId(),
          rootSessionId: rootSessionId(),
          runId: runId(),
          interactionId,
          kind: "permission",
          payload: {
            toolCallId,
            title: toolName,
            rawInput: permissionRawInput(toolName, params),
            options: [
              { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
              ...(toolName.startsWith("browser_")
                ? []
                : [
                    {
                      optionId: "allow_always",
                      name: "始终允许",
                      kind: "allow_always" as const,
                    },
                  ]),
              { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
            ],
          },
        });
        approved = isAllowedPermissionOutcome(resolution);
        if (!approved) {
          throw gatewayError(
            "pi.permission_rejected",
            "用户拒绝了这次工具调用。",
            false,
            "interaction",
          );
        }
      } else {
        approved = requiresPermission;
      }
      const requestArguments =
        respectGitignore() &&
        (toolName === PI_WORKSPACE_READ_FILE ||
          toolName === PI_WORKSPACE_SEARCH ||
          toolName === PI_WORKSPACE_LIST_DIRECTORY ||
          toolName === PI_WORKSPACE_EDIT ||
          toolName === PI_WORKSPACE_APPLY_PATCH)
          ? { ...params, respectGitignore: true }
          : params;
      const resolution = await this.request({
        sessionId: sessionId(),
        rootSessionId: rootSessionId(),
        runId: runId(),
        cwd: cwd(),
        toolCallId,
        toolName,
        arguments: requestArguments,
        permissionMode: permissionMode(),
        ...(approved === undefined ? {} : { approved }),
      });
      if (resolution.status !== "completed") {
        throw gatewayError(
          resolution.error?.code ?? "pi.tool_gateway_failed",
          resolution.error?.message ?? "宿主拒绝了 ToolGateway 请求。",
          resolution.error?.retriable ?? false,
        );
      }
      const output = resolution.output ?? "";
      if (toolName === PI_BROWSER_SCREENSHOT) {
        return browserScreenshotResult(output, toolName, approved);
      }
      return textResult(output, toolName, approved);
    };

    const interactionTool = async (
      toolCallId: string,
      kind: AgentInteractionKind,
      payload: JsonObject,
    ): Promise<AgentToolResult<GatewayToolResultDetails>> => {
      ensureToolAllowed(
        kind === "question" ? PI_ASK_USER_QUESTION : PI_UPDATE_PLAN,
      );
      ensureSubagentCapability(
        kind === "question" ? PI_ASK_USER_QUESTION : PI_UPDATE_PLAN,
      );
      const resolution = await this.requestInteraction({
        sessionId: sessionId(),
        rootSessionId: rootSessionId(),
        runId: runId(),
        interactionId: `${sessionId()}:${kind}:${toolCallId}`,
        kind,
        payload: { ...payload, toolCallId },
        timeoutMs: interactionTimeoutMsFor(kind, questionTimeoutPolicy()),
      });
      return textResult(JSON.stringify(resolution), kind, true);
    };

    const tools: ToolDefinition[] = [
      {
        name: PI_WORKSPACE_READ_FILE,
        label: "Read workspace file",
        description:
          "Read a bounded UTF-8 text file from the authorized workspace.",
        promptSnippet:
          "Read a workspace-relative UTF-8 file through Melody's gateway.",
        parameters: readFileParameters,
        executionMode: "parallel",
        execute: async (toolCallId, params) =>
          execute(PI_WORKSPACE_READ_FILE, toolCallId, params as JsonObject),
      },
      {
        name: PI_WORKSPACE_READ_TOOL_OUTPUT,
        label: "Read terminal output archive",
        description:
          "Read a bounded byte range from a Melody terminal output archive.",
        promptSnippet:
          "Read a terminal output archive in bounded chunks through Melody's gateway.",
        parameters: toolOutputParameters,
        executionMode: "parallel",
        execute: async (toolCallId, params) =>
          execute(
            PI_WORKSPACE_READ_TOOL_OUTPUT,
            toolCallId,
            params as JsonObject,
          ),
      },
      {
        name: PI_WORKSPACE_SEARCH,
        label: "Search workspace",
        description:
          "Search literal text in the authorized workspace with bounded results.",
        promptSnippet: "Search workspace text through Melody's gateway.",
        parameters: searchParameters,
        executionMode: "parallel",
        execute: async (toolCallId, params) =>
          execute(PI_WORKSPACE_SEARCH, toolCallId, params as JsonObject),
      },
      {
        name: PI_WORKSPACE_LIST_DIRECTORY,
        label: "List workspace directory",
        description:
          "List a bounded workspace directory tree, skipping hidden files and common generated directories by default.",
        promptSnippet:
          "List a workspace-relative directory through Melody's gateway.",
        parameters: listDirectoryParameters,
        executionMode: "parallel",
        execute: async (toolCallId, params) =>
          execute(
            PI_WORKSPACE_LIST_DIRECTORY,
            toolCallId,
            params as JsonObject,
          ),
      },
      {
        name: PI_WORKSPACE_WRITE_FILE,
        label: "Write workspace file",
        description:
          "Write a complete bounded UTF-8 file in the authorized workspace.",
        promptSnippet: "Write a file through Melody's permission gateway.",
        parameters: writeFileParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(
            PI_WORKSPACE_WRITE_FILE,
            toolCallId,
            params as JsonObject,
            true,
          ),
      },
      {
        name: PI_WORKSPACE_EDIT,
        label: "Edit workspace file",
        description: "Replace exact text in a bounded workspace file.",
        promptSnippet: "Edit a file through Melody's permission gateway.",
        parameters: editParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_WORKSPACE_EDIT, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_WORKSPACE_APPLY_PATCH,
        label: "Apply workspace patch",
        description: "Apply a bounded unified patch to workspace files.",
        promptSnippet: "Apply a patch through Melody's permission gateway.",
        parameters: patchParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(
            PI_WORKSPACE_APPLY_PATCH,
            toolCallId,
            params as JsonObject,
            true,
          ),
      },
      {
        name: PI_RUN_TERMINAL_COMMAND,
        label: "Run terminal command",
        description:
          "Run one terminal command in the authorized workspace. Set background=true to create a Host-owned task that can be waited on or cancelled; large output is archived with a bounded preview.",
        promptSnippet:
          "Run a terminal command through Melody's permission gateway.",
        parameters: terminalParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(
            PI_RUN_TERMINAL_COMMAND,
            toolCallId,
            params as JsonObject,
            true,
          ),
      },
      {
        name: PI_MONITOR,
        label: "Monitor command",
        description:
          "Watch a long-running shell command: its stdout and stderr are merged and every line becomes a notification. Use `grep --line-buffered` in pipelines, and stop it with kill_command_or_subagent when it is no longer needed. The Host stops a monitor automatically if it emits too many events.",
        promptSnippet:
          "Stream events from a long-running command instead of polling it.",
        parameters: monitorParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_MONITOR, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_SCHEDULER_CREATE,
        label: "Schedule prompt",
        description:
          "Schedule a prompt to run in this session on a repeating interval or a local-time 5-field cron rule. The Host persists the timer, survives restarts, decides what a missed trigger means, and records every trigger in a run journal.",
        promptSnippet:
          "Schedule a recurring prompt when work should repeat without the user asking again.",
        parameters: schedulerCreateParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_SCHEDULER_CREATE, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_SCHEDULER_LIST,
        label: "List scheduled prompts",
        description:
          "List the scheduled prompts for this session, including their status and next fire time.",
        promptSnippet: "Inspect scheduled prompts before changing them.",
        parameters: schedulerListParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_SCHEDULER_LIST, toolCallId, params as JsonObject),
      },
      {
        name: PI_SCHEDULER_DELETE,
        label: "Cancel scheduled prompt",
        description: "Cancel a scheduled prompt by its task id.",
        promptSnippet: "Cancel a scheduled prompt that is no longer needed.",
        parameters: schedulerDeleteParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_SCHEDULER_DELETE, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_ASK_USER_QUESTION,
        label: "Ask user",
        description:
          "Ask the user a blocking question and wait for a response.",
        promptSnippet: "Ask the user when the next step needs a decision.",
        parameters: questionParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          interactionTool(toolCallId, "question", params as JsonObject),
      },
      {
        name: PI_UPDATE_PLAN,
        label: "Update plan",
        description: "Publish the current plan for the user to review.",
        promptSnippet: "Update the visible task plan as work progresses.",
        parameters: planParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          interactionTool(toolCallId, "plan", params as JsonObject),
      },
      {
        name: PI_MCP_LIST_TOOLS,
        label: "List MCP tools",
        description:
          "List tools exposed by configured local stdio or HTTP/SSE MCP servers through Melody's Host bridge.",
        promptSnippet:
          "Inspect the available tools of a configured MCP server.",
        parameters: mcpListParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_MCP_LIST_TOOLS, toolCallId, params as JsonObject),
      },
      {
        name: PI_MCP_CALL_TOOL,
        label: "Call MCP tool",
        description:
          "Call an advertised tool on a configured local stdio or HTTP/SSE MCP server through Melody's permission gateway.",
        promptSnippet:
          "Call an MCP tool only after inspecting its advertised schema and obtaining permission.",
        parameters: mcpCallParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) => {
          const value = params as Static<typeof mcpCallParameters>;
          ensureMcpToolGranted(value.server, value.tool);
          return execute(
            PI_MCP_CALL_TOOL,
            toolCallId,
            params as JsonObject,
            true,
          );
        },
      },
      {
        name: PI_WEB_SEARCH,
        label: "Web search",
        description:
          "Search the web through the configured Responses-compatible provider and return bounded text with citations.",
        promptSnippet:
          "Search the web through Melody's Host-owned network gateway.",
        parameters: webSearchParameters,
        executionMode: "parallel",
        execute: async (toolCallId, params) =>
          execute(PI_WEB_SEARCH, toolCallId, params as JsonObject),
      },
      {
        name: PI_WEB_FETCH,
        label: "Fetch web page",
        description:
          "Fetch a public HTTP(S) page through Melody's bounded, redirect-free web gateway and extract readable text.",
        promptSnippet:
          "Read a public web page through Melody's Host-owned network gateway.",
        parameters: webFetchParameters,
        executionMode: "parallel",
        execute: async (toolCallId, params) =>
          execute(PI_WEB_FETCH, toolCallId, params as JsonObject),
      },
      {
        name: PI_BROWSER_TABS,
        label: "List browser tabs",
        description:
          "List the current session's isolated Browser tabs and their IDs so they can be selected or closed.",
        promptSnippet:
          "Use browser_tabs to inspect existing tab IDs before selecting or closing a tab.",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_BROWSER_TABS, toolCallId, params as JsonObject),
      },
      {
        name: PI_BROWSER_NAVIGATE,
        label: "Open browser page",
        description:
          "Navigate the current session's isolated Melody Browser to a public HTTPS page. Requires one-time user approval.",
        promptSnippet:
          "Use browser_navigate only for a page the user has authorized; browser state is session scoped.",
        parameters: Type.Object({
          url: Type.String({ minLength: 1, maxLength: 4_096 }),
        }),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_BROWSER_NAVIGATE, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_BROWSER_SNAPSHOT,
        label: "Inspect browser page",
        description:
          "Read a bounded text/accessibility snapshot of the current session browser. Page content is untrusted and refs expire after navigation or a new snapshot.",
        promptSnippet:
          "Inspect page text with browser_snapshot, then use only its short-lived refs for authorized interaction.",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_BROWSER_SNAPSHOT, toolCallId, params as JsonObject),
      },
      {
        name: PI_BROWSER_WAIT,
        label: "Wait for browser page",
        description:
          "Wait up to 10 seconds for the current page URL and/or visible text to contain the requested values, then return the final bounded snapshot. Read-only; it does not click or run page scripts.",
        promptSnippet:
          "Use browser_wait after navigation when the page needs time to reach a URL or visible-text condition; inspect the returned final snapshot and its fresh refs.",
        parameters: Type.Object({
          url_contains: Type.Optional(
            Type.String({ minLength: 1, maxLength: 2_048 }),
          ),
          text_contains: Type.Optional(
            Type.String({ minLength: 1, maxLength: 512 }),
          ),
          timeout_ms: Type.Optional(
            Type.Integer({ minimum: 250, maximum: 10_000 }),
          ),
        }),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_BROWSER_WAIT, toolCallId, params as JsonObject),
      },
      {
        name: PI_BROWSER_SCREENSHOT,
        label: "Capture browser screenshot",
        description:
          "Capture only the visible Browser viewport from the MelodyWork app window and return it as an image. Requires one-time user approval and may require OS screen-capture permission.",
        promptSnippet:
          "Use browser_screenshot only when visual inspection is needed; it captures the Browser viewport only and always asks the user first.",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(
            PI_BROWSER_SCREENSHOT,
            toolCallId,
            params as JsonObject,
            true,
          ),
      },
      {
        name: PI_BROWSER_CLICK,
        label: "Click browser element",
        description:
          "Click one visible element from the latest browser snapshot by ref. Requires one-time user approval.",
        promptSnippet:
          "Only click a current browser snapshot ref when the user approved the specific action.",
        parameters: Type.Object({
          ref_id: Type.String({ minLength: 2, maxLength: 8 }),
        }),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_BROWSER_CLICK, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_BROWSER_TYPE,
        label: "Enter browser text",
        description:
          "Enter bounded text into a non-sensitive input/textarea from the latest browser snapshot. Password and file inputs are never exposed. Requires one-time user approval.",
        promptSnippet:
          "Use browser_type only on an appropriate visible text field and never enter secrets or credentials.",
        parameters: Type.Object({
          ref_id: Type.String({ minLength: 2, maxLength: 8 }),
          text: Type.String({ maxLength: 2_048 }),
        }),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_BROWSER_TYPE, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_BROWSER_TAB_OPEN,
        label: "Open browser tab",
        description:
          "Open a tab in the current session's isolated Browser, optionally at a public HTTPS URL. Requires one-time user approval.",
        promptSnippet:
          "Use browser_tab_open only when a separate page is needed; each tab is session scoped and the user approves opening it.",
        parameters: Type.Object({
          url: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        }),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_BROWSER_TAB_OPEN, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_BROWSER_TAB_SELECT,
        label: "Select browser tab",
        description:
          "Select an existing tab in the current session's isolated Browser. Requires one-time user approval because it changes the visible page.",
        promptSnippet:
          "Use browser_tab_select with a tab ID returned by the Browser status; the user approves switching the visible tab.",
        parameters: Type.Object({
          tab_id: Type.String({ minLength: 1, maxLength: 128 }),
        }),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(
            PI_BROWSER_TAB_SELECT,
            toolCallId,
            params as JsonObject,
            true,
          ),
      },
      {
        name: PI_BROWSER_TAB_CLOSE,
        label: "Close browser tab",
        description:
          "Close a tab in the current session's isolated Browser. Requires one-time user approval.",
        promptSnippet:
          "Use browser_tab_close only for a tab the user has authorized to close.",
        parameters: Type.Object({
          tab_id: Type.String({ minLength: 1, maxLength: 128 }),
        }),
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_BROWSER_TAB_CLOSE, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_MEMORY_SEARCH,
        label: "Search memory",
        description:
          "Search bounded cross-session Melody Markdown memory for prior decisions, conventions, and context.",
        promptSnippet:
          "Search Melody memory before assuming prior project decisions are unknown.",
        parameters: memorySearchParameters,
        executionMode: "parallel",
        execute: async (toolCallId, params) =>
          execute(PI_MEMORY_SEARCH, toolCallId, params as JsonObject),
      },
      {
        name: PI_MEMORY_GET,
        label: "Read memory",
        description:
          "Read a bounded Markdown memory file or line range returned by memory_search.",
        promptSnippet:
          "Read the relevant memory file after memory_search identifies a useful result.",
        parameters: memoryGetParameters,
        executionMode: "parallel",
        execute: async (toolCallId, params) =>
          execute(PI_MEMORY_GET, toolCallId, params as JsonObject),
      },
      {
        name: PI_MEMORY_REMEMBER,
        label: "Remember note",
        description:
          "Append a bounded durable Markdown note to the configured workspace or global Melody memory.",
        promptSnippet:
          "Save a durable project decision or user preference through Melody's permission gateway.",
        parameters: memoryRememberParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_MEMORY_REMEMBER, toolCallId, params as JsonObject, true),
      },
      {
        name: PI_LSP,
        label: "Language server",
        description:
          "Run a bounded read-only language-server query through Melody's Host bridge. Project LSP configuration must explicitly set trusted=true.",
        promptSnippet:
          "Inspect definitions, references, symbols, or hover information through the configured LSP server.",
        parameters: lspParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_LSP, toolCallId, params as JsonObject),
      },
      {
        name: PI_CODEBASE_NAVIGATION,
        label: "Codebase navigation",
        description:
          "Search the bounded Host-owned tree-sitter codebase index for definitions, references, document symbols, or workspace symbols.",
        promptSnippet:
          "Navigate the workspace code graph through Melody's Host-owned index.",
        parameters: codebaseNavigationParameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) =>
          execute(PI_CODEBASE_NAVIGATION, toolCallId, params as JsonObject),
      },
    ];

    if (spawnSubagent) {
      tools.push(
        {
          name: PI_SPAWN_SUBAGENT,
          label: "Spawn subagent",
          description: "Run a focused child Pi session and return its result.",
          promptSnippet: "Delegate an independent task to a child agent.",
          parameters: subagentParameters,
          executionMode: "sequential",
          execute: async (_toolCallId, params) => {
            ensureToolAllowed(PI_SPAWN_SUBAGENT);
            const value = params as Static<typeof subagentParameters>;
            const result = await spawnSubagent({
              task: value.task,
              ...((value.resumeFrom ?? value.resume_from)
                ? {
                    resumeFrom: value.resumeFrom ?? value.resume_from,
                  }
                : {}),
              subagentType: value.subagentType,
              role: value.role,
              persona: value.persona,
              agent: value.agent,
              capabilityMode: value.capabilityMode,
              cwd: value.cwd,
              isolation: value.isolation,
              modelId: value.modelId,
              reasoningEffort: value.reasoningEffort,
              background: false,
              parentSessionId: sessionId(),
            });
            return textResult(
              `${result.output ?? `Subagent ${result.taskId} 已完成。`}${
                result.worktreePath ? `\nworktree: ${result.worktreePath}` : ""
              }`,
              PI_SPAWN_SUBAGENT,
              true,
              result.taskId,
            );
          },
        },
        {
          name: PI_RUN_BACKGROUND_TASK,
          label: "Run background task",
          description:
            "Start a child Pi task that can be awaited or cancelled later.",
          promptSnippet: "Start longer independent work in the background.",
          parameters: backgroundParameters,
          executionMode: "parallel",
          execute: async (_toolCallId, params) => {
            ensureToolAllowed(PI_RUN_BACKGROUND_TASK);
            const value = params as Static<typeof backgroundParameters>;
            const result = await spawnSubagent({
              task: value.task,
              ...((value.resumeFrom ?? value.resume_from)
                ? {
                    resumeFrom: value.resumeFrom ?? value.resume_from,
                  }
                : {}),
              subagentType: value.subagentType,
              role: value.role,
              persona: value.persona,
              agent: value.agent,
              capabilityMode: value.capabilityMode,
              cwd: value.cwd,
              isolation: value.isolation,
              modelId: value.modelId,
              reasoningEffort: value.reasoningEffort,
              background: true,
              parentSessionId: sessionId(),
            });
            return textResult(
              `后台任务 ${result.taskId} 已启动。${
                result.worktreePath ? ` worktree: ${result.worktreePath}` : ""
              }`,
              PI_RUN_BACKGROUND_TASK,
              true,
              result.taskId,
            );
          },
        },
        {
          name: PI_TASK,
          label: "Task (Melody compatibility)",
          description:
            "Compatibility alias for Melody-build's task tool. Supports foreground/background subagents and the original snake_case arguments.",
          promptSnippet:
            "Delegate work with the original Melody task contract when a compatibility skill requires it.",
          parameters: legacyTaskParameters,
          executionMode: "parallel",
          execute: async (_toolCallId, params) => {
            ensureToolAllowed(PI_TASK);
            ensureSubagentCapability(PI_TASK);
            const value = params as Static<typeof legacyTaskParameters>;
            const task = value.prompt ?? value.task;
            if (!task?.trim()) {
              throw gatewayError(
                "pi.task_prompt_missing",
                "task 需要提供 prompt（或 task）参数。",
                false,
                "run",
              );
            }
            const background = value.run_in_background ?? true;
            const result = await spawnSubagent({
              task,
              ...(value.subagent_type
                ? { subagentType: value.subagent_type }
                : {}),
              ...(value.role ? { role: value.role } : {}),
              ...(value.persona ? { persona: value.persona } : {}),
              ...(value.agent ? { agent: value.agent } : {}),
              ...(value.capability_mode
                ? { capabilityMode: value.capability_mode }
                : {}),
              ...(value.resume_from ? { resumeFrom: value.resume_from } : {}),
              ...(value.cwd ? { cwd: value.cwd } : {}),
              ...(value.isolation ? { isolation: value.isolation } : {}),
              ...(value.model ? { modelId: value.model } : {}),
              background,
              parentSessionId: sessionId(),
            });
            return textResult(
              legacyTaskText({
                taskId: result.taskId,
                ...(result.output ? { output: result.output } : {}),
                subagentType: value.subagent_type,
                background,
              }),
              PI_TASK,
              true,
              result.taskId,
            );
          },
        },
      );
    }
    if (taskController) {
      tools.push(
        {
          name: PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
          label: "Get background task output",
          description:
            "Inspect a background command or subagent and optionally wait for a bounded time.",
          promptSnippet:
            "Inspect the current status and output of a background task.",
          parameters: taskOutputParameters,
          executionMode: "sequential",
          execute: async (_toolCallId, params) => {
            ensureToolAllowed(PI_GET_COMMAND_OR_SUBAGENT_OUTPUT);
            const value = params as Static<typeof taskOutputParameters>;
            const snapshots = await taskController.wait({
              taskIds: [value.task_id],
              mode: "wait_any",
              timeoutMs: value.timeout_ms ?? 0,
              parentSessionId: sessionId(),
            });
            return taskSnapshotsResult(
              snapshots,
              PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
            );
          },
        },
        {
          name: PI_WAIT_COMMANDS_OR_SUBAGENTS,
          label: "Wait for background tasks",
          description:
            "Wait for one or more visible background commands or subagents to complete.",
          promptSnippet:
            "Wait for any or all background tasks and inspect their bounded results.",
          parameters: waitTasksParameters,
          executionMode: "sequential",
          execute: async (_toolCallId, params) => {
            ensureToolAllowed(PI_WAIT_COMMANDS_OR_SUBAGENTS);
            const value = params as Static<typeof waitTasksParameters>;
            const snapshots = await taskController.wait({
              taskIds: value.task_ids,
              mode: value.mode,
              timeoutMs: value.timeout_ms ?? BACKGROUND_TASK_DEFAULT_TIMEOUT_MS,
              parentSessionId: sessionId(),
            });
            return taskSnapshotsResult(
              snapshots,
              PI_WAIT_COMMANDS_OR_SUBAGENTS,
            );
          },
        },
        {
          name: PI_KILL_COMMAND_OR_SUBAGENT,
          label: "Kill background task",
          description:
            "Cancel a visible background command or subagent and return its final status.",
          promptSnippet: "Stop a background task that is no longer needed.",
          parameters: killTaskParameters,
          executionMode: "sequential",
          execute: async (_toolCallId, params) => {
            ensureToolAllowed(PI_KILL_COMMAND_OR_SUBAGENT);
            const value = params as Static<typeof killTaskParameters>;
            const snapshot = await taskController.cancel({
              taskId: value.task_id,
              parentSessionId: sessionId(),
            });
            return taskSnapshotResult(snapshot, PI_KILL_COMMAND_OR_SUBAGENT);
          },
        },
        {
          name: PI_GET_TASK_OUTPUT,
          label: "Get task output (Melody compatibility)",
          description:
            "Compatibility alias for Melody-build's get_task_output tool.",
          promptSnippet:
            "Inspect one or more background task or subagent results.",
          parameters: legacyTaskOutputParameters,
          executionMode: "sequential",
          execute: async (_toolCallId, params) => {
            ensureToolAllowed(PI_GET_TASK_OUTPUT);
            ensureSubagentCapability(PI_GET_TASK_OUTPUT);
            const value = params as Static<typeof legacyTaskOutputParameters>;
            const timeoutMs = value.timeout_ms ?? 0;
            const snapshots = await taskController.wait({
              taskIds: value.task_ids,
              mode:
                timeoutMs > 0 && value.task_ids.length > 1
                  ? "wait_all"
                  : "wait_any",
              timeoutMs,
              parentSessionId: sessionId(),
            });
            return taskSnapshotsResult(snapshots, PI_GET_TASK_OUTPUT);
          },
        },
        {
          name: PI_WAIT_TASKS,
          label: "Wait tasks (Melody compatibility)",
          description:
            "Compatibility alias for Melody-build's wait_tasks tool.",
          promptSnippet:
            "Wait for multiple background tasks or subagents to complete.",
          parameters: waitTasksParameters,
          executionMode: "sequential",
          execute: async (_toolCallId, params) => {
            ensureToolAllowed(PI_WAIT_TASKS);
            ensureSubagentCapability(PI_WAIT_TASKS);
            const value = params as Static<typeof waitTasksParameters>;
            const snapshots = await taskController.wait({
              taskIds: value.task_ids,
              mode: value.mode,
              timeoutMs: value.timeout_ms ?? BACKGROUND_TASK_DEFAULT_TIMEOUT_MS,
              parentSessionId: sessionId(),
            });
            return taskSnapshotsResult(snapshots, PI_WAIT_TASKS);
          },
        },
        {
          name: PI_KILL_TASK,
          label: "Kill task (Melody compatibility)",
          description: "Compatibility alias for Melody-build's kill_task tool.",
          promptSnippet: "Stop a background task or subagent by id.",
          parameters: killTaskParameters,
          executionMode: "sequential",
          execute: async (_toolCallId, params) => {
            ensureToolAllowed(PI_KILL_TASK);
            ensureSubagentCapability(PI_KILL_TASK);
            const value = params as Static<typeof killTaskParameters>;
            const snapshot = await taskController.cancel({
              taskId: value.task_id,
              parentSessionId: sessionId(),
            });
            return taskSnapshotResult(snapshot, PI_KILL_TASK);
          },
        },
      );
    }
    return tools.filter((tool) => {
      if (subagentCapabilityAllowsTool(capabilityMode(), tool.name))
        return true;
      return tool.name === PI_MCP_CALL_TOOL && mcpCallAllowed();
    });
  }
}
