import type {
  AgentInteractionKind,
  AgentQuestionTimeoutPolicy,
  JsonObject,
} from "@melody/agent-contract";
import {
  isAgentSessionModeId,
  type AgentSessionModeId,
} from "@melody/agent-contract";
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
  PI_INTERNAL_INSTRUCTION_SCOPE,
  PI_LSP,
  PI_MEMORY_GET,
  PI_MEMORY_REMEMBER,
  PI_MEMORY_SEARCH,
  PI_MCP_CALL_TOOL,
  PI_MCP_LIST_TOOLS,
  PI_MONITOR,
  PI_RUN_TERMINAL_COMMAND,
  PI_SCHEDULER_CREATE,
  PI_SCHEDULER_DELETE,
  PI_SCHEDULER_LIST,
  PI_UPDATE_PLAN,
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
import {
  sessionModeAllowsTool,
  subagentCapabilityAllowsTool,
  type PiSubagentCapabilityMode,
} from "./tool-access-policy.ts";
import {
  browserClickParameters,
  browserNavigateParameters,
  browserScreenshotParameters,
  browserSnapshotParameters,
  browserTabCloseParameters,
  browserTabOpenParameters,
  browserTabSelectParameters,
  browserTabsParameters,
  browserTypeParameters,
  browserWaitParameters,
  readFileParameters,
  toolOutputParameters,
  searchParameters,
  listDirectoryParameters,
  writeFileParameters,
  editParameters,
  patchParameters,
  terminalParameters,
  schedulerCreateParameters,
  schedulerListParameters,
  schedulerDeleteParameters,
  monitorParameters,
  questionParameters,
  planParameters,
  mcpListParameters,
  mcpCallParameters,
  webSearchParameters,
  webFetchParameters,
  memorySearchParameters,
  memoryGetParameters,
  memoryRememberParameters,
  lspParameters,
  codebaseNavigationParameters,
} from "./tool-schemas.ts";
export {
  BACKGROUND_TASK_DEFAULT_TIMEOUT_MS,
  BACKGROUND_TASK_MAX_TIMEOUT_MS,
  PI_TERMINAL_MAX_TIMEOUT_MS,
} from "./tool-schemas.ts";
export * from "./tool-names.ts";
export {
  intersectPiSubagentCapabilityModes,
  sessionModeAllowsTool,
  subagentCapabilityAllowsTool,
} from "./tool-access-policy.ts";
export type { PiSubagentCapabilityMode } from "./tool-access-policy.ts";
export {
  normalizePiSubagentCapabilityMode,
  normalizePiSubagentIsolation,
} from "./subagent-policy-normalization.ts";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { WorkerEmitter } from "../protocol.ts";
import { gatewayError } from "./tool-errors.ts";
import {
  browserScreenshotResult,
  textResult,
  type GatewayToolResultDetails,
} from "./tool-results.ts";
import {
  createSubagentTools,
  createTaskControlTools,
  type PiSubagentSpawner,
  type PiTaskController,
} from "./task-tools.ts";
export type {
  PiSubagentIsolation,
  PiSubagentSpawner,
  PiTaskController,
  PiTaskSnapshot,
  PiTaskStatus,
} from "./task-tools.ts";
import {
  isAllowedPermissionOutcome,
  permissionRawInput,
} from "./tool-permission.ts";
import {
  INTERACTION_TIMEOUT_MS as interactionTimeoutMs,
  PiToolRequestLifecycle,
} from "./tool-request-lifecycle.ts";
export {
  INTERACTION_TIMEOUT_MS,
  TOOL_GATEWAY_TIMEOUT_MS,
} from "./tool-request-lifecycle.ts";
import {
  parsePiInstructionScopeOutput,
  type PiScopedInstructionFile,
} from "./instruction-scope-extension.ts";

/** JavaScript's maximum reliable setTimeout delay. */
export const PI_QUESTION_TIMEOUT_MAX_MS = 2_147_483_647;

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

/** Resolve the timer used for a product question interaction. Permissions and
 * plan confirmations keep the gateway's fixed safety timeout; only the
 * user-question tool follows Melody's configurable policy. `0` means the
 * configured policy intentionally waits forever. */
export const interactionTimeoutMsFor = (
  kind: AgentInteractionKind,
  policy?: AgentQuestionTimeoutPolicy,
): number => {
  if (kind !== "question" || !policy) return interactionTimeoutMs;
  if (!policy.enabled) return 0;
  if (
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1 ||
    policy.timeoutMs > PI_QUESTION_TIMEOUT_MAX_MS
  ) {
    return interactionTimeoutMs;
  }
  return policy.timeoutMs;
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
  private readonly requestLifecycle: PiToolRequestLifecycle;

  public constructor(emit: WorkerEmitter) {
    this.requestLifecycle = new PiToolRequestLifecycle(emit);
  }

  public request(
    input: Parameters<PiToolRequestLifecycle["request"]>[0],
  ): ReturnType<PiToolRequestLifecycle["request"]> {
    return this.requestLifecycle.request(input);
  }

  public requestInteraction(
    input: Parameters<PiToolRequestLifecycle["requestInteraction"]>[0],
  ): ReturnType<PiToolRequestLifecycle["requestInteraction"]> {
    return this.requestLifecycle.requestInteraction(input);
  }

  public resolve(
    command: Parameters<PiToolRequestLifecycle["resolve"]>[0],
  ): void {
    this.requestLifecycle.resolve(command);
  }

  public resolveInteraction(
    command: Parameters<PiToolRequestLifecycle["resolveInteraction"]>[0],
  ): void {
    this.requestLifecycle.resolveInteraction(command);
  }

  public rejectAll(message?: string): void {
    this.requestLifecycle.rejectAll(message);
  }

  public createTools(
    sessionId: () => string,
    runId: () => string | undefined,
    permissionMode: () => "ask" | "auto" | "always-approve",
    cwd: () => string | undefined,
    spawnSubagent?: PiSubagentSpawner,
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
        parameters: browserTabsParameters,
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
        parameters: browserNavigateParameters,
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
        parameters: browserSnapshotParameters,
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
        parameters: browserWaitParameters,
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
        parameters: browserScreenshotParameters,
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
        parameters: browserClickParameters,
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
        parameters: browserTypeParameters,
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
        parameters: browserTabOpenParameters,
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
        parameters: browserTabSelectParameters,
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
        parameters: browserTabCloseParameters,
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
        ...createSubagentTools({
          sessionId,
          spawnSubagent,
          ensureToolAllowed,
          ensureSubagentCapability,
        }),
      );
    }
    if (taskController) {
      tools.push(
        ...createTaskControlTools({
          sessionId,
          taskController,
          ensureToolAllowed,
          ensureSubagentCapability,
        }),
      );
    }
    return tools.filter((tool) => {
      if (subagentCapabilityAllowsTool(capabilityMode(), tool.name))
        return true;
      return tool.name === PI_MCP_CALL_TOOL && mcpCallAllowed();
    });
  }
}
