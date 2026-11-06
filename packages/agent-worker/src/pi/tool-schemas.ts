/** Pi tool input schemas and shared limits for the worker-to-Host contract. */
import { Type } from "typebox";

export const PI_TERMINAL_MAX_TIMEOUT_MS = 36_000_000;
export const BACKGROUND_TASK_DEFAULT_TIMEOUT_MS = 30_000;
export const BACKGROUND_TASK_MAX_TIMEOUT_MS = 120_000;

export const readFileParameters = Type.Object({
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

export const toolOutputParameters = Type.Object({
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

export const searchParameters = Type.Object({
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

export const listDirectoryParameters = Type.Object({
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

export const writeFileParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative file path." }),
  content: Type.String({ description: "Complete UTF-8 file content." }),
});

export const editParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative file path." }),
  oldText: Type.String({ minLength: 1, description: "Exact text to replace." }),
  newText: Type.String({ description: "Replacement text." }),
  replaceAll: Type.Optional(Type.Boolean()),
});

export const patchParameters = Type.Object({
  patch: Type.String({ minLength: 1, description: "A bounded unified diff." }),
});

export const terminalParameters = Type.Object({
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

export const schedulerCreateParameters = Type.Object({
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

export const schedulerListParameters = Type.Object({});

export const schedulerDeleteParameters = Type.Object({
  task_id: Type.String({
    minLength: 1,
    maxLength: 128,
    description: "Task id returned by scheduler_create.",
  }),
});

export const monitorParameters = Type.Object({
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

export const questionParameters = Type.Object({
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

export const planParameters = Type.Object({
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

export const subagentParameters = Type.Object({
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
export const legacyTaskParameters = Type.Object({
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

export const backgroundParameters = Type.Object({
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
export const legacyTaskOutputParameters = Type.Object({
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

export const taskOutputParameters = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: 512 }),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: BACKGROUND_TASK_MAX_TIMEOUT_MS,
      description: "Optional bounded wait before returning the current output.",
    }),
  ),
});

export const waitTasksParameters = Type.Object({
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

export const killTaskParameters = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: 512 }),
});

export const mcpListParameters = Type.Object({
  server: Type.Optional(
    Type.String({
      maxLength: 128,
      description: "Optional configured MCP server name.",
    }),
  ),
});

export const mcpCallParameters = Type.Object({
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

export const webSearchParameters = Type.Object({
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

export const webFetchParameters = Type.Object({
  url: Type.String({
    minLength: 1,
    maxLength: 4_096,
    description: "HTTP(S) URL to read through Melody's bounded web gateway.",
  }),
});

export const memorySearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 2_048,
    description: "Specific terms to search in cross-session Melody memory.",
  }),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export const memoryGetParameters = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 4_096,
    description: "A Markdown path returned by memory_search.",
  }),
  from: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
});

export const memoryRememberParameters = Type.Object({
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

export const lspParameters = Type.Object({
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

export const codebaseNavigationParameters = Type.Object({
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

export const browserTabsParameters = Type.Object({});

export const browserNavigateParameters = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 4_096 }),
});

export const browserSnapshotParameters = Type.Object({});

export const browserWaitParameters = Type.Object({
  url_contains: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
  text_contains: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 250, maximum: 10_000 })),
});

export const browserScreenshotParameters = Type.Object({});

export const browserClickParameters = Type.Object({
  ref_id: Type.String({ minLength: 2, maxLength: 8 }),
});

export const browserTypeParameters = Type.Object({
  ref_id: Type.String({ minLength: 2, maxLength: 8 }),
  text: Type.String({ maxLength: 2_048 }),
});

export const browserTabOpenParameters = Type.Object({
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
});

export const browserTabSelectParameters = Type.Object({
  tab_id: Type.String({ minLength: 1, maxLength: 128 }),
});

export const browserTabCloseParameters = Type.Object({
  tab_id: Type.String({ minLength: 1, maxLength: 128 }),
});
