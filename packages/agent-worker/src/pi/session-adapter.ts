import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  AgentAttachment,
  AgentCommandEnvelope,
  AgentError,
  AgentGoalPolicy,
  AgentQuestionTimeoutPolicy,
  AgentProtocolCapabilities,
  AgentResourceManifest,
  AgentRunConfig,
  AgentSubagentPolicyManifest,
} from "@melody/agent-contract";
import {
  AGENT_SESSION_MODE_IDS,
  containsControlCharacters,
  isAgentSessionModeId,
  type AgentSessionModeId,
} from "@melody/agent-contract";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mapPiEvent, textFromContent } from "./event-mapper.ts";
import {
  mapPiModelCatalog,
  type PiProviderAuthState,
} from "./model-catalog.ts";
import { fingerprintCommand, IdempotencyLedger } from "../idempotency.ts";
import {
  PiToolGateway,
  PI_BACKGROUND_TERMINAL_TASK_PREFIX,
  PI_CREATE_SUBAGENT_WORKTREE,
  PI_GATEWAY_TOOL_NAMES,
  PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
  PI_KILL_COMMAND_OR_SUBAGENT,
  PI_WAIT_COMMANDS_OR_SUBAGENTS,
  intersectPiSubagentCapabilityModes,
  normalizePiSubagentCapabilityMode,
  normalizePiSubagentIsolation,
  type PiTaskController,
  type PiSubagentCapabilityMode,
  type PiSubagentIsolation,
  type PiTaskStatus,
  type PiTaskSnapshot,
} from "./tool-gateway.ts";
import { createTodoExtension, PI_TODO_WRITE } from "./todo-extension.ts";
import { createCompactionExtension } from "./compaction-extension.ts";
import {
  createGoalExtension,
  normalizeGoalPolicy,
  PI_UPDATE_GOAL,
} from "./goal-extension.ts";
import { createPiInstructionScope } from "./instruction-scope-extension.ts";
import { materializePiSessionImport } from "./session-import.ts";
import {
  composePiSubagentPrompt,
  emptyPiSubagentPolicyManifest,
  normalizePiSubagentPolicyManifest,
  resolvePiSubagentPolicy,
  type PiSubagentPolicyResolution,
} from "./subagent-policy.ts";
import type { WorkerEmitter } from "../protocol.ts";

type PiSdk = Pick<
  typeof import("@earendil-works/pi-coding-agent"),
  | "createAgentSession"
  | "ModelRuntime"
  | "SessionManager"
  | "DefaultResourceLoader"
  | "SettingsManager"
>;
type PiSession = Awaited<ReturnType<PiSdk["createAgentSession"]>>["session"];
type PiResourceLoader = InstanceType<PiSdk["DefaultResourceLoader"]>;
type PiModelRuntime = Awaited<ReturnType<PiSdk["ModelRuntime"]["create"]>>;
type TaskCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "task.wait" | "task.cancel" }
>;
type ContinueTaskCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "task.continue" }
>;
type PiThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Keep the SDK entry statically reachable.  The worker is shipped as a
 * self-contained Bun executable in production; `import.meta.resolve()` works
 * in a source checkout but cannot resolve a package from Bun's embedded
 * `/$bunfs` filesystem.  A static package import lets both Node development
 * and the compiled sidecar use exactly the same Pi modules.
 */
const PI_SDK: PiSdk = {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  DefaultResourceLoader,
  SettingsManager,
};

const loadPiSdk = async (): Promise<PiSdk> => PI_SDK;

interface PiSessionContext {
  session: PiSession;
  /**
   * Refresh Host-projected resources before a new prompt. The callback owns
   * the mutable additional-path arrays passed to Pi's resource loader, then
   * rebuilds the session prompt/tool runtime through `session.reload()`.
   */
  refreshResources?: (manifest?: AgentResourceManifest) => Promise<void>;
  /**
   * Apply the latest Host-projected model policy when this session is idle.
   * Active provider turns keep their existing SettingsManager snapshot and
   * invoke this callback before the next fresh prompt.
   */
  refreshModelSettings?: () => Promise<void>;
  nativeSessionId: string;
  rootSessionId: string;
  streamSessionId: string;
  runId?: string;
  promptId?: string;
  runFinished: boolean;
  nextMessage: number;
  offsets: Map<string, number>;
  activeMessageIds: Map<"user" | "assistant", string>;
  eventTail: Promise<void>;
  permissionMode: "ask" | "auto" | "always-approve";
  sessionModeId: AgentSessionModeId;
  /** Effective child tool ceiling; root sessions always use `all`. */
  capabilityMode: PiSubagentCapabilityMode;
  /**
   * Exact `mcp__<server>__<tool>` grants for a bounded child ceiling. Root
   * sessions leave this undefined because their `all` ceiling already covers
   * MCP calls; a bounded child without grants keeps an empty set.
   */
  mcpTools?: ReadonlySet<string>;
  /** Product-facing model identifier used to reopen and audit this session. */
  modelId?: string;
  /** Effective Pi thinking level (after model capability clamping). */
  reasoningEffort: PiThinkingLevel;
  /** Monotonic revision for mutable product session settings. */
  configRevision: number;
  /**
   * A short-lived control transition (currently cancellation) that must
   * settle before a new prompt can be admitted. Long-running model turns are
   * intentionally not stored here, so ToolGateway responses remain concurrent.
   */
  runTransition?: Promise<void>;
}

interface SessionHandle extends PiSessionContext {
  unsubscribe: () => void;
  idempotency: IdempotencyLedger;
}

/**
 * Durable metadata kept beside Pi's native JSONL for completed child
 * sessions. The task id is the lookup key, while the session file and cwd are
 * validated again before a transcript is opened. This makes `resume_from`
 * survive a worker restart without turning a user-provided string into a
 * filesystem path.
 */
export interface PersistedPiSubagent {
  taskId: string;
  rootSessionId: string;
  parentSessionId: string;
  parentTaskId?: string;
  subagentType: PiSubagentType;
  role?: string;
  persona?: string;
  agent?: string;
  capabilityMode: PiSubagentCapabilityMode;
  /** Exact MCP tool grants retained so a resumed child keeps its ceiling. */
  mcpTools?: string[];
  /** Approval mode retained across worker restarts for safe resume. */
  permissionMode?: "ask" | "auto" | "always-approve";
  isolation: PiSubagentIsolation;
  worktreePath?: string;
  resumedFrom?: string;
  sessionFile: string;
  cwd: string;
  modelId?: string;
  reasoningEffort: PiThinkingLevel;
  status: "running" | "completed" | "failed" | "cancelled";
  output?: string;
  updatedAt: number;
}

interface TaskHandle extends PiSessionContext {
  taskId: string;
  parentSessionId: string;
  parentTaskId?: string;
  subagentType: PiSubagentType;
  role?: string;
  persona?: string;
  agent?: string;
  /** Effective filesystem isolation for this child session. */
  isolation: PiSubagentIsolation;
  /** Approval mode clamped by the parent session's mode. */
  permissionMode: "ask" | "auto" | "always-approve";
  /** Host-created detached worktree, when isolation is `worktree`. */
  worktreePath?: string;
  resumedFrom?: string;
  childSessionId: string;
  /** Persisted Pi JSONL path, when the Host supplied a session root. */
  sessionFile?: string;
  promise: Promise<{ output: string }>;
  cancel: () => Promise<void>;
  unsubscribe: () => void;
  output: string;
  status: "running" | "completed" | "failed" | "cancelled";
}

type PiSubagentType = "general-purpose" | "explore" | "plan";

const normalizePiSubagentType = (value: unknown): PiSubagentType => {
  if (value === undefined || value === null || value === "") {
    return "general-purpose";
  }
  if (value === "general-purpose" || value === "explore" || value === "plan") {
    return value;
  }
  throw fail(
    "pi.unsupported_subagent_type",
    `Pi 迁移版暂不支持子代理类型：${String(value)}。可选值为 general-purpose、explore、plan。`,
    "run",
  );
};

const defaultCapabilityForSubagentType = (
  type: PiSubagentType,
): PiSubagentCapabilityMode =>
  type === "general-purpose" ? "all" : "read-only";

const permissionModeRank: Record<"ask" | "auto" | "always-approve", number> = {
  ask: 0,
  auto: 1,
  "always-approve": 2,
};

/** Never let a declarative agent definition bypass its parent's approvals. */
const intersectPiPermissionModes = (
  parent: "ask" | "auto" | "always-approve",
  requested?: "ask" | "auto" | "always-approve",
): "ask" | "auto" | "always-approve" => {
  if (!requested) return parent;
  return permissionModeRank[requested] <= permissionModeRank[parent]
    ? requested
    : parent;
};

/**
 * Normalize the model-facing `resume_from` argument before it can be used as
 * a task-map key. Melody-build treats blank values and common JSON sentinel
 * strings as "not supplied"; keep that compatibility while rejecting control
 * characters and unbounded input that could otherwise make diagnostics or
 * task lookups ambiguous.
 */
export const normalizePiResumeFrom = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw fail("pi.resume_id_invalid", "resume_from 必须是字符串。", "run");
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  const sentinel = normalized.toLowerCase();
  if (sentinel === "null" || sentinel === "none" || sentinel === "undefined") {
    return undefined;
  }
  if (normalized.length > 512 || containsControlCharacters(normalized)) {
    throw fail(
      "pi.resume_id_invalid",
      "resume_from 必须是不超过 512 个字符且不含控制字符的任务 ID。",
      "run",
    );
  }
  return normalized;
};

/**
 * Resolve an optional child working directory without widening the worker's
 * authenticated workspace. Melody-build accepts both absolute and relative
 * paths; relative values are interpreted from the parent session. Canonical
 * resolution happens before the containment check so a symlink cannot point a
 * child outside the workspace while still looking like a descendant.
 */
export const normalizePiSubagentCwd = (
  value: unknown,
  parentCwd: string,
  workspaceRoot: string,
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw fail(
      "pi.subagent_cwd_invalid",
      "子代理 cwd 必须是字符串路径。",
      "run",
    );
  }
  let normalized = value.trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (
    !normalized ||
    ["null", "none", "undefined"].includes(normalized.toLowerCase())
  ) {
    return undefined;
  }
  if (normalized.length > 4_096 || containsControlCharacters(normalized)) {
    throw fail(
      "pi.subagent_cwd_invalid",
      "子代理 cwd 必须是不超过 4096 个字符且不含控制字符的路径。",
      "run",
    );
  }
  const candidate = resolve(parentCwd, normalized);
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = realpathSync(workspaceRoot);
    canonicalCandidate = realpathSync(candidate);
  } catch {
    throw fail(
      "pi.subagent_cwd_invalid",
      `子代理 cwd 不是可用目录：${normalized}。请提供已存在的工作区目录。`,
      "run",
    );
  }
  try {
    if (!lstatSync(canonicalCandidate).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw fail(
      "pi.subagent_cwd_invalid",
      `子代理 cwd 不是目录：${normalized}。`,
      "run",
    );
  }
  if (
    canonicalCandidate !== canonicalRoot &&
    !canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)
  ) {
    throw fail(
      "pi.subagent_cwd_scope_denied",
      "子代理 cwd 必须位于当前项目工作区内。",
      "run",
    );
  }
  return canonicalCandidate;
};

type PiResumeTaskCandidate = {
  taskId: string;
  rootSessionId: string;
  parentSessionId?: string;
  parentTaskId?: string;
  status: PiTaskStatus;
  sessionFile?: string;
  subagentType?: PiSubagentType;
  role?: string;
  persona?: string;
  agent?: string;
};

/**
 * Validate a resume target before opening its JSONL transcript. The task map
 * is intentionally the authority: callers cannot provide an arbitrary path,
 * resume a sibling root, or attach to a still-running session whose append
 * cursor is changing underneath the new AgentSession.
 */
export const assertPiResumeTarget: (
  resumeFrom: string,
  candidate: PiResumeTaskCandidate | undefined,
  rootSessionId: string,
) => asserts candidate is PiResumeTaskCandidate & { sessionFile: string } = (
  resumeFrom,
  candidate,
  rootSessionId,
) => {
  if (!candidate || candidate.taskId !== resumeFrom) {
    throw fail(
      "pi.resume_not_found",
      `找不到可恢复的 Pi 子代理：${resumeFrom}。请使用已完成子代理返回的 task id。`,
      "run",
    );
  }
  if (candidate.rootSessionId !== rootSessionId) {
    throw fail(
      "pi.resume_scope_denied",
      "不能从另一个根会话恢复 Pi 子代理。",
      "run",
    );
  }
  if (candidate.status === "running") {
    throw fail(
      "pi.resume_running",
      "不能恢复仍在运行的 Pi 子代理；请先等待它完成。",
      "run",
    );
  }
  if (candidate.status !== "completed") {
    throw fail(
      "pi.resume_not_completed",
      "只能恢复已完成的 Pi 子代理；失败或取消的任务不能作为新上下文继续。",
      "run",
    );
  }
  if (!candidate.sessionFile) {
    throw fail(
      "pi.resume_unavailable",
      "该 Pi 子代理没有可恢复的持久化会话；请重新启动一个子代理。",
      "run",
    );
  }
};

/**
 * A task id is not sufficient to authorize resume.  Persisted records also
 * carry the parent session/task that created the child; checking that chain
 * prevents a child session from attaching to a sibling after a worker
 * restart, even when both records belong to the same root.
 */
export const assertPiResumeScope = (
  candidate: PiResumeTaskCandidate,
  parentSessionId: string,
  parentTaskId?: string,
): void => {
  if (
    candidate.parentSessionId !== undefined &&
    candidate.parentSessionId !== parentSessionId
  ) {
    throw fail(
      "pi.resume_parent_scope_denied",
      "不能从另一个父会话恢复 Pi 子代理。",
      "run",
    );
  }
  if (
    candidate.parentTaskId !== undefined &&
    candidate.parentTaskId !== parentTaskId
  ) {
    throw fail(
      "pi.resume_parent_scope_denied",
      "不能从另一个父任务恢复 Pi 子代理。",
      "run",
    );
  }
};

/** User-facing child conversations are top-level children of the active root.
 * Nested children remain controlled by their parent agent's resume_from tool. */
export const assertPiInteractiveChildTarget: (
  resumeFrom: string,
  candidate: PiResumeTaskCandidate | undefined,
  rootSessionId: string,
) => asserts candidate is PiResumeTaskCandidate & { sessionFile: string } = (
  resumeFrom: string,
  candidate: PiResumeTaskCandidate | undefined,
  rootSessionId: string,
) => {
  assertPiResumeTarget(resumeFrom, candidate, rootSessionId);
  if (
    candidate.parentSessionId !== rootSessionId ||
    candidate.parentTaskId !== undefined
  ) {
    throw fail(
      "pi.child_continue_scope_denied",
      "当前只允许用户直接打开并继续根会话创建的 Pi 子会话。",
      "run",
    );
  }
  assertPiResumeScope(candidate, rootSessionId);
};

/** Keep explicit resume selectors from silently changing a child identity. */
export const assertPiResumeIdentity = (
  candidate: PiResumeTaskCandidate,
  input: {
    subagentType?: string;
    role?: string;
    persona?: string;
    agent?: string;
  },
): void => {
  const selectors: Array<
    [
      keyof Pick<
        PiResumeTaskCandidate,
        "subagentType" | "role" | "persona" | "agent"
      >,
      string | undefined,
      string,
    ]
  > = [
    ["subagentType", input.subagentType, "pi.resume_type_mismatch"],
    ["role", input.role, "pi.resume_role_mismatch"],
    ["persona", input.persona, "pi.resume_persona_mismatch"],
    ["agent", input.agent, "pi.resume_agent_mismatch"],
  ];
  for (const [key, requested, code] of selectors) {
    if (requested === undefined || requested.trim() === "") continue;
    const source = candidate[key];
    if (source !== undefined && source !== requested.trim()) {
      throw fail(code, `resume_from 不能改变原子代理的 ${key}。`, "run");
    }
  }
};

/**
 * Decode the bounded response returned by the Host worktree bridge. Keep the
 * parser independent from the filesystem so malformed or future-version
 * responses fail closed before they are passed to SessionManager.
 */
export const parsePiWorktreeResponse = (output: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw fail(
      "pi.subagent_worktree_invalid",
      "宿主返回的子代理 worktree 响应不是有效 JSON。",
      "run",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail(
      "pi.subagent_worktree_invalid",
      "宿主返回的子代理 worktree 响应格式无效。",
      "run",
    );
  }
  const record = value as Record<string, unknown>;
  const path =
    typeof record.worktree_path === "string"
      ? record.worktree_path
      : typeof record.worktreePath === "string"
        ? record.worktreePath
        : undefined;
  const normalized = path?.trim();
  if (
    !normalized ||
    normalized.length > 4_096 ||
    containsControlCharacters(normalized)
  ) {
    throw fail(
      "pi.subagent_worktree_invalid",
      "宿主返回的子代理 worktree 路径无效。",
      "run",
    );
  }
  return normalized;
};

const asError = (
  error: unknown,
  scope: AgentError["scope"] = "runtime",
): AgentError => ({
  code: "pi.worker_error",
  message: error instanceof Error ? error.message : String(error),
  retriable: false,
  scope,
});

const fail = (
  code: string,
  message: string,
  scope: AgentError["scope"],
): Error & {
  agentError: AgentError;
} => {
  const error = new Error(message) as Error & { agentError: AgentError };
  error.agentError = { code, message, retriable: false, scope };
  return error;
};

const hostTaskStatus = (
  value: unknown,
): PiTaskSnapshot["status"] | undefined =>
  value === "running" ||
  value === "completed" ||
  value === "failed" ||
  value === "cancelled"
    ? value
    : undefined;

/**
 * Decode the small JSON snapshots returned by the Rust Host task registry.
 * Host-owned terminal ids use snake_case because they are part of the
 * persisted tool protocol; Pi's in-process task controller remains camelCase.
 * Keep this parser strict so a malformed or cross-version response cannot be
 * mistaken for a completed task.
 */
export const parseHostTaskSnapshots = (output: string): PiTaskSnapshot[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw fail(
      "pi.host_task_response_invalid",
      "宿主返回的后台终端任务结果不是有效 JSON。",
      "run",
    );
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw fail(
        "pi.host_task_response_invalid",
        "宿主返回的后台终端任务结果格式无效。",
        "run",
      );
    }
    const record = value as Record<string, unknown>;
    const taskId =
      typeof record.task_id === "string"
        ? record.task_id
        : typeof record.taskId === "string"
          ? record.taskId
          : "";
    const status = hostTaskStatus(record.status);
    if (!taskId || !status) {
      throw fail(
        "pi.host_task_response_invalid",
        "宿主返回的后台终端任务缺少有效 task_id 或 status。",
        "run",
      );
    }
    const snapshot: PiTaskSnapshot = { taskId, status };
    if (typeof record.output === "string") snapshot.output = record.output;
    return snapshot;
  });
};

const thinkingLevels = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const normalizeThinkingLevel = (
  value: string | undefined,
): PiThinkingLevel | undefined => {
  if (value === undefined) return undefined;
  const candidate = value as PiThinkingLevel;
  if (!thinkingLevels.has(candidate)) {
    throw fail(
      "pi.unsupported_thinking_level",
      `Pi 不支持思考强度：${value}。`,
      "session",
    );
  }
  return candidate;
};

const modelIdForSession = (
  session: PiSession,
  requestedModelId?: string,
): string | undefined =>
  requestedModelId ??
  (session.model ? `${session.model.provider}/${session.model.id}` : undefined);

const effectiveThinkingLevelForSession = (
  session: PiSession,
  requestedThinkingLevel?: PiThinkingLevel,
): PiThinkingLevel =>
  normalizeThinkingLevel(session.thinkingLevel) ??
  requestedThinkingLevel ??
  "medium";

const normalizeSessionModeId = (
  value: string | undefined,
): AgentSessionModeId => {
  const mode = value ?? "default";
  if (!isAgentSessionModeId(mode)) {
    throw fail(
      "pi.unsupported_session_mode",
      `Pi 不支持会话模式：${mode}。可用模式：${AGENT_SESSION_MODE_IDS.join("、")}。`,
      "session",
    );
  }
  return mode;
};

const configSnapshotMismatch = (
  field: string,
  submitted: unknown,
  authoritative: unknown,
): Error & { agentError: AgentError } =>
  fail(
    "pi.config_snapshot_mismatch",
    `Pi 会话的 ${field} 配置已变化（当前值：${String(authoritative ?? "未设置")}；提交值：${String(submitted ?? "未设置")}），请刷新后重试。`,
    "session",
  );

/**
 * Validate the configuration snapshot carried by a turn against the
 * worker-owned session handle. `configRevision` protects the update order,
 * but it does not by itself prove that a renderer used the values that were
 * acknowledged at that revision. A stale composer can otherwise submit an
 * old permission/mode/model while the Pi session is already configured for a
 * different value. Omitted optional fields mean "use the current value" and
 * are therefore not treated as a mismatch.
 */
export const validateTurnConfigSnapshot = (
  config: AgentRunConfig,
  authoritative: Pick<
    PiSessionContext,
    "modelId" | "reasoningEffort" | "sessionModeId" | "permissionMode"
  >,
): { sessionModeId: AgentSessionModeId } => {
  if (
    config.modelId !== undefined &&
    config.modelId !== authoritative.modelId
  ) {
    throw configSnapshotMismatch("模型", config.modelId, authoritative.modelId);
  }

  const submittedThinkingLevel = normalizeThinkingLevel(config.reasoningEffort);
  if (
    submittedThinkingLevel !== undefined &&
    submittedThinkingLevel !== authoritative.reasoningEffort
  ) {
    throw configSnapshotMismatch(
      "思考强度",
      submittedThinkingLevel,
      authoritative.reasoningEffort,
    );
  }

  const submittedSessionModeId = normalizeSessionModeId(config.sessionModeId);
  if (
    config.sessionModeId !== undefined &&
    submittedSessionModeId !== authoritative.sessionModeId
  ) {
    throw configSnapshotMismatch(
      "会话模式",
      submittedSessionModeId,
      authoritative.sessionModeId,
    );
  }

  if (config.permissionMode !== authoritative.permissionMode) {
    throw configSnapshotMismatch(
      "权限模式",
      config.permissionMode,
      authoritative.permissionMode,
    );
  }

  return {
    sessionModeId: authoritative.sessionModeId,
  };
};

/**
 * Reject a steer/follow-up that targets anything other than the currently
 * streaming Pi run. The renderer can have an old composer event in flight
 * when a run finishes and a new prompt starts; forwarding that event to Pi
 * would otherwise steer the new run with stale text.
 */
export const assertActivePiRun = (input: {
  expectedRunId: string;
  activeRunId?: string;
  runFinished: boolean;
  isStreaming: boolean;
}): void => {
  if (!input.activeRunId || input.runFinished) {
    throw fail(
      "pi.run_not_active",
      "目标 Pi 运行已经结束或尚未开始，请刷新后重试。",
      "run",
    );
  }
  if (input.activeRunId !== input.expectedRunId) {
    throw fail(
      "pi.run_mismatch",
      `目标 Pi 运行已变更（当前运行：${input.activeRunId}；提交运行：${input.expectedRunId}），请刷新后重试。`,
      "run",
    );
  }
  if (!input.isStreaming) {
    throw fail(
      "pi.run_not_streaming",
      "目标 Pi 运行当前不在流式处理中，不能 steer 或 follow-up。",
      "run",
    );
  }
};

/**
 * Keep cancellation idempotent while still rejecting a stale cancellation
 * that could accidentally stop a newer run after a rapid submit/retry.
 */
export const assertPiCancelTarget = (input: {
  expectedRunId?: string;
  expectedPromptId?: string;
  activeRunId?: string;
  activePromptId?: string;
}): void => {
  if (
    input.expectedRunId !== undefined &&
    input.expectedRunId !== input.activeRunId
  ) {
    throw fail(
      "pi.run_mismatch",
      `取消请求指向的运行已变更（当前运行：${input.activeRunId ?? "无"}；提交运行：${input.expectedRunId}），已忽略以避免误取消。`,
      "run",
    );
  }
  if (
    input.expectedPromptId !== undefined &&
    input.expectedPromptId !== input.activePromptId
  ) {
    throw fail(
      "pi.prompt_mismatch",
      `取消请求指向的提示已变更（当前提示：${input.activePromptId ?? "无"}；提交提示：${input.expectedPromptId}），已忽略以避免误取消。`,
      "run",
    );
  }
};

const sessionError = (message: string): Error & { agentError: AgentError } =>
  fail("pi.session_not_found", message, "session");

const modelError = (modelId: string): Error & { agentError: AgentError } =>
  fail("pi.model_not_found", `Pi 找不到模型：${modelId}。`, "session");

const MAX_TASK_OUTPUT_CHARS = 1_000_000;

const appendTaskOutput = (current: string, next: string): string => {
  if (!next) return current;
  const combined = `${current}${next}`;
  return combined.length <= MAX_TASK_OUTPUT_CHARS
    ? combined
    : combined.slice(combined.length - MAX_TASK_OUTPUT_CHARS);
};

export const MAX_PI_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_PI_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;

export interface DecodedPiAttachment {
  byteLength: number;
  image?: { type: "image"; data: string; mimeType: string };
  text?: string;
}

/**
 * Return whether a Pi model can receive a given content modality.  Pi's
 * built-in catalog always has an explicit `input` array; the optional shape
 * keeps this helper safe for legacy/default sessions whose model metadata is
 * unavailable. Unknown capability is allowed so an older provider catalog is
 * not rejected merely because it omitted the field.
 */
export const modelSupportsInput = (
  model: { input?: readonly unknown[] } | undefined,
  input: "text" | "image",
): boolean => {
  if (input === "text" || !model || !Array.isArray(model.input)) {
    return true;
  }
  return model.input.includes("image");
};

export const assertModelSupportsAttachments = (
  model: { input?: readonly unknown[] } | undefined,
  attachments: readonly Pick<AgentAttachment, "mediaType">[],
): void => {
  const hasImages = attachments.some((attachment) =>
    attachment.mediaType.trim().toLowerCase().startsWith("image/"),
  );
  if (hasImages && !modelSupportsInput(model, "image")) {
    throw fail(
      "pi.model_input_unsupported",
      "当前 Pi 模型不支持图片输入，请移除图片或切换到支持视觉的模型。",
      "run",
    );
  }
};

/** Decode one data URL while keeping Pi input memory explicitly bounded. */
export const decodeAttachment = (
  url: string,
  mediaType: string,
): DecodedPiAttachment => {
  if (!url.startsWith("data:")) {
    throw fail(
      "pi.unsupported_attachment",
      "Pi worker 目前只接受 data URL 附件。",
      "run",
    );
  }
  const comma = url.indexOf(",");
  if (comma < 0) {
    throw fail("pi.invalid_attachment", "附件 data URL 缺少内容。", "run");
  }
  const header = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const base64 = header.endsWith(";base64");
  let bytes: Buffer;
  try {
    bytes = base64
      ? Buffer.from(body, "base64")
      : Buffer.from(decodeURIComponent(body), "utf8");
  } catch (error) {
    throw fail(
      "pi.invalid_attachment",
      `附件 data URL 无法解码：${error instanceof Error ? error.message : String(error)}`,
      "run",
    );
  }
  if (bytes.byteLength > MAX_PI_ATTACHMENT_BYTES) {
    throw fail(
      "pi.attachment_too_large",
      `单个附件不能超过 ${MAX_PI_ATTACHMENT_BYTES / (1024 * 1024)} MiB。`,
      "run",
    );
  }
  if (mediaType.startsWith("image/")) {
    return {
      byteLength: bytes.byteLength,
      image: {
        type: "image",
        data: bytes.toString("base64"),
        mimeType: mediaType,
      },
    };
  }
  return { byteLength: bytes.byteLength, text: bytes.toString("utf8") };
};

const parseModelId = (
  modelId: string,
): { provider: string; id: string } | undefined => {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  return { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
};

/**
 * The Host keeps Melody's config alias as the product-facing model id, while
 * Pi needs the provider/model pair from the generated catalog.  Keep this
 * resolver local to the Pi adapter so the renderer does not need to know
 * about generated provider names.  The suffix is an ordinal added by the
 * Host to make aliases that sanitize to the same provider id deterministic.
 */
const customProviderPrefix = (modelId: string): string => {
  let alias = "";
  for (const character of modelId) {
    if (/^[a-zA-Z0-9_-]$/.test(character)) alias += character.toLowerCase();
    else alias += "-";
    // Keep this in lock-step with the Host's stable provider_id sanitizer.
    // The remaining suffix is a deterministic hash, so matching only this
    // prefix still works when aliases contain Unicode or punctuation.
    if (alias.length >= 48) break;
  }
  return `melody-${alias || "model"}-`;
};

const PI_SESSION_ROOT_ENV = "MELODY_PI_SESSION_ROOT";
const PI_SUBAGENT_RECORD_DIRECTORY = "subagent-tasks";
const PI_AUTH_PATH_ENV = "MELODY_PI_AUTH_PATH";
const PI_MODELS_PATH_ENV = "MELODY_PI_MODELS_PATH";
const PI_MODEL_POLICIES_PATH_ENV = "MELODY_PI_MODEL_POLICIES_PATH";
const PI_AUTO_COMPACT_THRESHOLD_ENV = "MELODY_AUTO_COMPACT_THRESHOLD_PERCENT";
const PI_RESPECT_GITIGNORE_ENV = "MELODY_RESPECT_GITIGNORE";
const PI_QUESTION_TIMEOUT_POLICY_ENV = "MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON";
const PI_GOAL_POLICY_ENV = "MELODY_PI_GOAL_POLICY_JSON";
const PI_SUBAGENT_POLICIES_ENV = "MELODY_PI_SUBAGENT_POLICIES_JSON";
const PI_SKILL_PATHS_ENV = "MELODY_PI_SKILL_PATHS_JSON";
const PI_SKILL_ROOTS_ENV = "MELODY_PI_SKILL_ROOTS_JSON";
const PI_PROMPT_PATHS_ENV = "MELODY_PI_PROMPT_PATHS_JSON";
const PI_PROMPT_ROOTS_ENV = "MELODY_PI_PROMPT_ROOTS_JSON";
const PI_MODEL_NETWORK_ENV = "MELODY_PI_ALLOW_MODEL_NETWORK";
const PI_CATALOG_BASE_URL_ENV = "MELODY_PI_CATALOG_BASE_URL";
export const MAX_PI_SKILL_PATHS = 256;
/** Mirrors the Host's `MAX_PI_SKILL_IGNORE_PATHS` bound. */
export const MAX_PI_SKILL_IGNORE_PATHS = 64;
export const MAX_PI_SKILL_DEPTH = 6;
export const MAX_PI_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_PI_SKILL_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_PI_PROMPT_PATHS = 512;
const MAX_PI_PROMPT_FILE_BYTES = 1024 * 1024;
const MAX_PI_PROMPT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PI_MODEL_POLICIES = 1024;
const MAX_PI_POLICY_FILE_BYTES = 1024 * 1024;
const MAX_PI_POLICY_RETRIES = 10_000;
const MAX_PI_POLICY_TIMEOUT_MS = 2_147_483_647;
export const MAX_PI_COMPACTION_THRESHOLD_PERCENT = 100;
export const DEFAULT_PI_AUTO_COMPACT_THRESHOLD_PERCENT = 85;

const parseBooleanEnvironment = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

const parseQuestionTimeoutPolicyEnvironment = (
  value: string | undefined,
): AgentQuestionTimeoutPolicy | undefined => {
  if (!value?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.enabled !== "boolean" ||
      typeof record.timeoutMs !== "number" ||
      !Number.isSafeInteger(record.timeoutMs) ||
      record.timeoutMs < 1 ||
      record.timeoutMs > 2_147_483_647
    ) {
      return undefined;
    }
    return { enabled: record.enabled, timeoutMs: record.timeoutMs };
  } catch {
    return undefined;
  }
};

const parseGoalPolicyEnvironment = (
  value: string | undefined,
): AgentGoalPolicy | undefined => {
  if (!value?.trim()) return undefined;
  try {
    return normalizeGoalPolicy(JSON.parse(value));
  } catch {
    // Direct worker launches fail closed for malformed policy snapshots. A
    // Host refresh will replace this value with the authoritative manifest.
    return undefined;
  }
};

const disabledPiSubagentPolicyManifest = (): AgentSubagentPolicyManifest => ({
  enabled: false,
  models: {},
  toggle: {},
  roles: [],
  personas: [],
  agents: [],
});

const parseSubagentPolicyEnvironment = (
  value: string | undefined,
): AgentSubagentPolicyManifest => {
  if (!value?.trim()) return emptyPiSubagentPolicyManifest();
  try {
    return normalizePiSubagentPolicyManifest(JSON.parse(value));
  } catch {
    // A malformed Host projection must never silently restore all custom
    // subagent capabilities. Disable delegation until the next authoritative
    // resource refresh replaces the snapshot.
    return disabledPiSubagentPolicyManifest();
  }
};

export interface PiModelPolicy {
  maxRetries?: number;
  inferenceIdleTimeoutMs?: number;
  autoCompactThresholdPercent?: number;
}

export interface PiModelPolicySnapshot {
  defaultPolicy?: PiModelPolicy;
  models: ReadonlyMap<string, PiModelPolicy>;
}

type PiModelIdentity = Pick<
  NonNullable<PiSession["model"]>,
  "provider" | "id"
> & {
  contextWindow?: number;
};

export type PiSettingsOverrides = {
  retry?: { provider?: { maxRetries?: number } };
  httpIdleTimeoutMs?: number;
  compaction?: { reserveTokens?: number };
};

type PiSettingsManagerWithOverrides = {
  applyOverrides: (overrides: PiSettingsOverrides) => void;
};

/**
 * Replace the three policy fields that Melody owns instead of deep-merging them
 * into the previous snapshot.  Pi's SettingsManager intentionally implements
 * applyOverrides as a deep merge, which would otherwise leave a removed
 * provider retry/idle-timeout policy active forever in a long-lived session.
 * The manager is created in-memory by this adapter, so deleting only these
 * Host-owned fields cannot discard Pi's own session settings.
 */
export const applyModelPolicyOverrides = (
  settingsManager: PiSettingsManagerWithOverrides,
  overrides: PiSettingsOverrides,
): void => {
  const mutableManager = settingsManager as PiSettingsManagerWithOverrides & {
    settings?: Record<string, unknown>;
  };
  const settings = mutableManager.settings;
  if (settings) {
    const retry = settings.retry;
    if (retry && typeof retry === "object" && !Array.isArray(retry)) {
      const provider = (retry as Record<string, unknown>).provider;
      if (
        provider &&
        typeof provider === "object" &&
        !Array.isArray(provider)
      ) {
        delete (provider as Record<string, unknown>).maxRetries;
        if (Object.keys(provider as Record<string, unknown>).length === 0) {
          delete (retry as Record<string, unknown>).provider;
        }
      }
      if (Object.keys(retry as Record<string, unknown>).length === 0) {
        delete settings.retry;
      }
    }
    delete settings.httpIdleTimeoutMs;
    const compaction = settings.compaction;
    if (
      compaction &&
      typeof compaction === "object" &&
      !Array.isArray(compaction)
    ) {
      delete (compaction as Record<string, unknown>).reserveTokens;
      if (Object.keys(compaction as Record<string, unknown>).length === 0) {
        delete settings.compaction;
      }
    }
  }
  mutableManager.applyOverrides(overrides);
};

const piModelPolicyKey = (model: PiModelIdentity): string =>
  `${model.provider}/${model.id}`;

const normalizedPolicyNumber = (
  value: unknown,
  field: string,
  key: string,
  maximum: number,
  allowZero: boolean,
): number | undefined => {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maximum
  ) {
    throw new Error(
      `Pi model policy ${key}.${field} must be an integer between ${allowZero ? 0 : 1} and ${maximum}`,
    );
  }
  return value;
};

const normalizedModelPolicy = (value: unknown, key: string): PiModelPolicy => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Pi model policy ${key} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const maxRetries = normalizedPolicyNumber(
    record.maxRetries,
    "maxRetries",
    key,
    MAX_PI_POLICY_RETRIES,
    true,
  );
  const inferenceIdleTimeoutMs = normalizedPolicyNumber(
    record.inferenceIdleTimeoutMs,
    "inferenceIdleTimeoutMs",
    key,
    MAX_PI_POLICY_TIMEOUT_MS,
    false,
  );
  const autoCompactThresholdPercent = normalizedPolicyNumber(
    record.autoCompactThresholdPercent,
    "autoCompactThresholdPercent",
    key,
    MAX_PI_COMPACTION_THRESHOLD_PERCENT,
    true,
  );
  if (
    maxRetries === undefined &&
    inferenceIdleTimeoutMs === undefined &&
    autoCompactThresholdPercent === undefined
  ) {
    throw new Error(`Pi model policy ${key} is empty`);
  }
  return {
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(inferenceIdleTimeoutMs !== undefined ? { inferenceIdleTimeoutMs } : {}),
    ...(autoCompactThresholdPercent !== undefined
      ? { autoCompactThresholdPercent }
      : {}),
  };
};

/**
 * Load the Host-generated policy snapshot.  The file is separate from
 * `models.json` so Pi's strict catalog schema never sees product-only fields;
 * managed/development catalogs without a policy file use Melody's compatible
 * 85% threshold and Pi defaults for the remaining policy fields.
 */
export const loadPiModelPolicies = async (): Promise<PiModelPolicySnapshot> => {
  const path = process.env[PI_MODEL_POLICIES_PATH_ENV]?.trim();
  if (!path) {
    return {
      defaultPolicy: {
        autoCompactThresholdPercent: DEFAULT_PI_AUTO_COMPACT_THRESHOLD_PERCENT,
      },
      models: new Map(),
    };
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "ENOENT") {
      return {
        defaultPolicy: {
          autoCompactThresholdPercent:
            DEFAULT_PI_AUTO_COMPACT_THRESHOLD_PERCENT,
        },
        models: new Map(),
      };
    }
    throw new Error(
      `无法读取 Pi 模型策略文件：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Buffer.byteLength(content, "utf8") > MAX_PI_POLICY_FILE_BYTES) {
    throw new Error("Pi 模型策略文件超过 1 MiB 限制");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Pi 模型策略文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pi 模型策略文件根节点必须是对象");
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1) {
    throw new Error("Pi 模型策略文件 version 必须为 1");
  }
  let defaultPolicy: PiModelPolicy | undefined;
  if (root.default !== undefined) {
    defaultPolicy = normalizedModelPolicy(root.default, "default");
  }
  const models = root.models;
  if (models === null || typeof models !== "object" || Array.isArray(models)) {
    throw new Error("Pi 模型策略文件缺少 models 对象");
  }
  const entries = Object.entries(models as Record<string, unknown>);
  if (entries.length > MAX_PI_MODEL_POLICIES) {
    throw new Error(`Pi 模型策略数量不能超过 ${MAX_PI_MODEL_POLICIES}`);
  }
  const result = new Map<string, PiModelPolicy>();
  for (const [key, value] of entries) {
    if (!key.trim() || key.length > 512) {
      throw new Error("Pi 模型策略键无效");
    }
    result.set(key, normalizedModelPolicy(value, key));
  }
  defaultPolicy = {
    ...(defaultPolicy ?? {}),
    autoCompactThresholdPercent:
      defaultPolicy?.autoCompactThresholdPercent ??
      DEFAULT_PI_AUTO_COMPACT_THRESHOLD_PERCENT,
  };
  for (const [key, policy] of result) {
    result.set(key, {
      ...policy,
      autoCompactThresholdPercent:
        policy.autoCompactThresholdPercent ??
        defaultPolicy.autoCompactThresholdPercent,
    });
  }
  const rawEnvironmentThreshold =
    process.env[PI_AUTO_COMPACT_THRESHOLD_ENV]?.trim();
  const environmentThreshold =
    rawEnvironmentThreshold && /^\d+$/u.test(rawEnvironmentThreshold)
      ? Number(rawEnvironmentThreshold)
      : undefined;
  const validEnvironmentThreshold =
    environmentThreshold !== undefined &&
    Number.isSafeInteger(environmentThreshold) &&
    environmentThreshold >= 0 &&
    environmentThreshold <= MAX_PI_COMPACTION_THRESHOLD_PERCENT
      ? environmentThreshold
      : undefined;
  if (validEnvironmentThreshold !== undefined) {
    defaultPolicy = {
      ...(defaultPolicy ?? {}),
      autoCompactThresholdPercent: validEnvironmentThreshold,
    };
    for (const [key, policy] of result) {
      result.set(key, {
        ...policy,
        autoCompactThresholdPercent: validEnvironmentThreshold,
      });
    }
  }
  return {
    ...(defaultPolicy ? { defaultPolicy } : {}),
    models: result,
  };
};

export const settingsOverridesForModel = (
  model: PiModelIdentity | undefined,
  policies: PiModelPolicySnapshot,
): PiSettingsOverrides => {
  if (!model) return {};
  const policy =
    policies.models.get(piModelPolicyKey(model)) ?? policies.defaultPolicy;
  if (!policy) return {};
  const reserveTokens = compactionReserveTokensForThreshold(
    model.contextWindow,
    policy.autoCompactThresholdPercent,
  );
  return {
    ...(policy.maxRetries !== undefined
      ? { retry: { provider: { maxRetries: policy.maxRetries } } }
      : {}),
    ...(policy.inferenceIdleTimeoutMs !== undefined
      ? { httpIdleTimeoutMs: policy.inferenceIdleTimeoutMs }
      : {}),
    ...(reserveTokens !== undefined ? { compaction: { reserveTokens } } : {}),
  };
};

/**
 * Convert Melody's inclusive percentage trigger into Pi's reserve-token
 * setting. Melody starts compaction once `used * 100 >= window * percent`,
 * while Pi starts when `used > window - reserve`. Using the first integer
 * token at or above the percentage keeps both triggers aligned, including
 * non-divisible context windows.
 */
export const compactionReserveTokensForThreshold = (
  contextWindow: number | undefined,
  thresholdPercent: number | undefined,
): number | undefined => {
  if (
    contextWindow === undefined ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    thresholdPercent === undefined
  ) {
    return undefined;
  }
  const firstTriggerToken = Math.ceil((contextWindow * thresholdPercent) / 100);
  // Pi does not need more than the whole context window reserved.  This
  // clamps the 0% edge to a practical first-token trigger while preserving
  // exact mapping for all positive thresholds.
  return Math.min(
    contextWindow,
    Math.max(0, contextWindow - firstTriggerToken + 1),
  );
};

const isWithinRoot = (path: string, root: string): boolean => {
  const relativePath = relative(root, path);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${sep}`) &&
    relativePath !== ".." &&
    !relativePath.startsWith(sep)
  );
};

const isDirectChild = (path: string, root: string): boolean => {
  const relativePath = relative(root, path);
  return (
    isWithinRoot(path, root) &&
    !relativePath.includes(sep) &&
    dirname(path) === root
  );
};

const skillProjectRootNames = [
  ".melody",
  ".agents",
  ".claude",
  ".cursor",
] as const;

const externalSkillRootNames = [".agents", ".claude", ".cursor"] as const;

const pluginMarkerFiles = [
  "plugin.json",
  join(".melody-plugin", "plugin.json"),
  join(".claude-plugin", "plugin.json"),
] as const;
const pluginMarkerDirectories = [
  "skills",
  "commands",
  "agents",
  "hooks",
  ".mcp.json",
  ".lsp.json",
] as const;

const isPluginRoot = (path: string): boolean => {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
    return [...pluginMarkerFiles, ...pluginMarkerDirectories].some((name) => {
      try {
        return !lstatSync(join(path, name)).isSymbolicLink();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

const discoverPluginRoots = (containers: string[]): string[] => {
  const roots: string[] = [];
  const stack = containers.map((path) => ({ path: resolve(path), depth: 0 }));
  let visited = 0;
  while (stack.length > 0 && roots.length < 128 && visited < 4096) {
    const current = stack.pop();
    if (!current || current.depth > 5) continue;
    if (isPluginRoot(current.path)) {
      roots.push(current.path);
      continue;
    }
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
    } catch {
      continue;
    }
    for (const entry of entries.reverse()) {
      visited += 1;
      if (
        visited >= 4096 ||
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "target" ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        continue;
      }
      stack.push({
        path: join(current.path, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return [...new Set(roots)];
};

const projectPluginContainersFor = (cwd: string): string[] => {
  const containers: string[] = [];
  let current = resolve(cwd);
  let foundRepositoryMarker = false;
  while (true) {
    containers.push(resolve(current, ".melody", "plugins"));
    containers.push(resolve(current, ".claude", "plugins"));
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false })) {
      foundRepositoryMarker = true;
      break;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return foundRepositoryMarker ? containers : containers.slice(0, 2);
};

const pluginRootsFor = (
  cwd: string,
  additionalRoots: string[] = [],
): string[] => {
  const configuredRoot = process.env.MELODY_HOME?.trim();
  const melodyRoot = resolve(configuredRoot || join(tmpdir(), "melody"));
  const homeRoot =
    process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || undefined;
  const containers = [
    ...projectPluginContainersFor(cwd),
    resolve(melodyRoot, "installed-plugins"),
    resolve(melodyRoot, "plugins"),
    ...(homeRoot ? [resolve(homeRoot, ".claude", "plugins")] : []),
  ];
  return [
    ...new Set([
      ...discoverPluginRoots(containers),
      ...additionalRoots.filter(isPluginRoot).map((root) => resolve(root)),
    ]),
  ].slice(0, 128);
};

const pluginRootsFromResourceSpecs = (
  specs: Array<{ path: string }> | undefined,
): string[] =>
  (specs ?? [])
    .map((spec) => resolve(spec.path))
    .filter((path) => ["skills", "commands"].includes(basename(path)))
    .map((path) => dirname(path));

const skillRootsFor = (
  cwd: string,
  additionalPluginRoots: string[] = [],
): string[] => {
  const projectRoot = resolve(cwd);
  const projectRoots: string[] = [];
  let current = projectRoot;
  let foundRepositoryMarker = false;
  while (true) {
    for (const name of skillProjectRootNames) {
      projectRoots.push(resolve(current, name, "skills"));
    }
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false })) {
      foundRepositoryMarker = true;
      break;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  if (!foundRepositoryMarker) {
    projectRoots.splice(skillProjectRootNames.length);
  }

  const configuredRoot = process.env.MELODY_HOME?.trim();
  const melodyRoot = resolve(
    configuredRoot || join(tmpdir(), "melody"),
    "skills",
  );
  const homeRoot =
    process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || undefined;
  const roots = [
    ...projectRoots,
    melodyRoot,
    ...(homeRoot
      ? externalSkillRootNames.map((name) => resolve(homeRoot, name, "skills"))
      : []),
    ...pluginRootsFor(cwd, additionalPluginRoots).map((root) =>
      resolve(root, "skills"),
    ),
  ];
  return [...new Set(roots)];
};

const promptRootsFor = (
  cwd: string,
  additionalPluginRoots: string[] = [],
): string[] => {
  const projectRoot = resolve(cwd);
  const projectRoots: string[] = [];
  let current = projectRoot;
  let foundRepositoryMarker = false;
  while (true) {
    for (const name of skillProjectRootNames) {
      projectRoots.push(resolve(current, name, "commands"));
    }
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false })) {
      foundRepositoryMarker = true;
      break;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  if (!foundRepositoryMarker) {
    projectRoots.splice(skillProjectRootNames.length);
  }

  const configuredRoot = process.env.MELODY_HOME?.trim();
  const homeRoot =
    process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || undefined;
  return [
    ...projectRoots,
    ...(configuredRoot
      ? [resolve(configuredRoot, "commands")]
      : [resolve(tmpdir(), "melody", "commands")]),
    ...(homeRoot
      ? externalSkillRootNames.map((name) =>
          resolve(homeRoot, name, "commands"),
        )
      : []),
    ...pluginRootsFor(cwd, additionalPluginRoots).map((root) =>
      resolve(root, "commands"),
    ),
  ];
};

interface PiSkillRootSpec {
  path: string;
  disabled: Set<string>;
  /**
   * Canonical path prefixes Melody's `[skills].ignore` hides, already resolved
   * by the Host. They apply to native roots only, matching the engine, which
   * filters `ignore` before plugin skills are merged.
   */
  ignorePaths: string[];
}

interface PiPromptRootSpec {
  path: string;
  disabled: Set<string>;
  /** Prompt templates have no ignore list; kept for a uniform spec shape. */
  ignorePaths: string[];
}

const parseRootSpecs = <T extends { path: string; disabled: Set<string> }>(
  raw: string | undefined,
  parse: (value: Record<string, unknown>) => T | undefined,
): T[] | undefined => {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return undefined;
    return value.slice(0, MAX_PI_SKILL_PATHS).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const parsed = parse(entry as Record<string, unknown>);
      return parsed ? [parsed] : [];
    });
  } catch {
    return undefined;
  }
};

const parseDisabledNames = (value: unknown): Set<string> => {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .slice(0, MAX_PI_SKILL_PATHS)
      .filter(
        (name): name is string =>
          typeof name === "string" && name.length > 0 && name.length <= 255,
      ),
  );
};

/**
 * Ignore prefixes are Host-resolved absolute paths. A relative or traversing
 * entry is dropped rather than resolved against the worker's cwd, because a
 * prefix that escapes its intended root would hide unrelated Skills.
 */
const parseIgnorePaths = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const prefixes = new Set<string>();
  for (const entry of value.slice(0, MAX_PI_SKILL_IGNORE_PATHS)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 4096 || !isAbsolute(trimmed)) continue;
    const resolved = resolve(trimmed);
    if (resolved.split(sep).includes("..")) continue;
    prefixes.add(canonicalPathForBoundary(resolved));
  }
  return [...prefixes].sort();
};

/** True when a canonical path is one of the ignore prefixes or below it. */
const isIgnoredPath = (candidate: string, prefixes: string[]): boolean =>
  prefixes.some(
    (prefix) => candidate === prefix || isWithinRoot(candidate, prefix),
  );

const canonicalRootPaths = (roots: string[]): string[] =>
  roots.flatMap((root) => {
    try {
      const metadata = lstatSync(root);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return [];
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });

const boundaryRootPaths = (roots: string[]): string[] =>
  roots.map((root) => canonicalPathForBoundary(root));

const rootSpecFor = <
  T extends { path: string; disabled: Set<string>; ignorePaths?: string[] },
>(
  spec: T,
  trustedRoots: Set<string>,
):
  | { path: string; disabled: Set<string>; ignorePaths: string[] }
  | undefined => {
  if (!spec.path || spec.path.length > 4096) return undefined;
  try {
    const resolved = resolve(spec.path);
    const canonical = canonicalPathForBoundary(resolved);
    // A Host-projected root is trusted when it is a known root or a directory
    // inside one. Plugin manifests name concrete skill directories
    // (`skills/<group>/<name>`), which the Host already validated against the
    // plugin package; requiring exact equality would reject them.
    const trusted =
      trustedRoots.has(canonical) ||
      [...trustedRoots].some((root) => isWithinRoot(canonical, root));
    if (!trusted) return undefined;
    // A root may not exist when the worker starts and be created later. If it
    // does exist, reject symlinks/non-directories now; scanSkillRoot repeats
    // this check on every refresh to close a replacement race.
    try {
      const metadata = lstatSync(resolved);
      if (metadata.isSymbolicLink() || !metadata.isDirectory())
        return undefined;
    } catch {
      // Missing roots are retained so a newly-created standard root can be
      // discovered by the next prompt refresh.
    }
    const ignorePaths = spec.ignorePaths ?? [];
    if (lstatSync(resolved, { throwIfNoEntry: false })) {
      try {
        return {
          path: realpathSync(resolved),
          disabled: spec.disabled,
          ignorePaths,
        };
      } catch {
        return undefined;
      }
    }
    return { path: resolved, disabled: spec.disabled, ignorePaths };
  } catch {
    return undefined;
  }
};

const readSkillRootSpecs = (cwd: string): PiSkillRootSpec[] | undefined => {
  const parsed = parseRootSpecs(process.env[PI_SKILL_ROOTS_ENV], (entry) => {
    if (typeof entry.path !== "string") return undefined;
    return {
      path: entry.path,
      disabled: parseDisabledNames(entry.disabled),
      ignorePaths: parseIgnorePaths(entry.ignorePaths),
    };
  });
  if (!parsed) return undefined;
  const trustedRoots = new Set(
    boundaryRootPaths(skillRootsFor(cwd, pluginRootsFromResourceSpecs(parsed))),
  );
  return parsed.flatMap((spec) => {
    const trusted = rootSpecFor(spec, trustedRoots);
    return trusted ? [trusted] : [];
  });
};

const readPromptRootSpecs = (cwd: string): PiPromptRootSpec[] | undefined => {
  const parsed = parseRootSpecs(process.env[PI_PROMPT_ROOTS_ENV], (entry) => {
    if (typeof entry.path !== "string") return undefined;
    return {
      path: entry.path,
      disabled: parseDisabledNames(entry.disabled),
    };
  });
  if (!parsed) return undefined;
  const trustedRoots = new Set(
    boundaryRootPaths(
      promptRootsFor(cwd, pluginRootsFromResourceSpecs(parsed)),
    ),
  );
  return parsed.flatMap((spec) => {
    const trusted = rootSpecFor(spec, trustedRoots);
    return trusted ? [trusted] : [];
  });
};

/**
 * Normalize a manifest sent by the Host before it is used to refresh a live
 * resource loader. The command is structurally validated at the protocol
 * boundary, but root membership and symlink checks must happen here as well
 * because this is the last process boundary before Pi sees the paths.
 */
const resourceRootSpecsFor = (
  cwd: string,
  manifest: AgentResourceManifest,
): {
  skillRoots: PiSkillRootSpec[];
  promptRoots: PiPromptRootSpec[];
  respectGitignore: boolean;
  questionTimeoutPolicy?: AgentQuestionTimeoutPolicy;
  subagentPolicies: AgentSubagentPolicyManifest;
  goalPolicy?: AgentGoalPolicy;
} => {
  if (resolve(manifest.cwd) !== resolve(cwd)) {
    throw fail(
      "pi.resource_cwd_mismatch",
      "Pi 资源清单的工作区必须与当前 worker 一致。",
      "session",
    );
  }
  const pluginRoots = [
    ...pluginRootsFromResourceSpecs(manifest.skillRoots),
    ...pluginRootsFromResourceSpecs(manifest.promptRoots),
  ];
  const trustedSkillRoots = new Set(
    boundaryRootPaths(skillRootsFor(cwd, pluginRoots)),
  );
  const skillRoots = manifest.skillRoots.flatMap((entry) => {
    const normalized = rootSpecFor(
      {
        path: entry.path,
        disabled: new Set(entry.disabled),
        ignorePaths: parseIgnorePaths(entry.ignorePaths),
      },
      trustedSkillRoots,
    );
    return normalized ? [normalized] : [];
  });
  if (skillRoots.length !== manifest.skillRoots.length) {
    throw fail(
      "pi.resource_root_invalid",
      "Pi 资源清单包含不属于受信工作区的 Skill 根目录。",
      "session",
    );
  }
  const trustedPromptRoots = new Set(
    boundaryRootPaths(promptRootsFor(cwd, pluginRoots)),
  );
  const promptRoots = manifest.promptRoots.flatMap((entry) => {
    const normalized = rootSpecFor(
      {
        path: entry.path,
        disabled: new Set(entry.disabled),
      },
      trustedPromptRoots,
    );
    return normalized ? [normalized] : [];
  });
  if (promptRoots.length !== manifest.promptRoots.length) {
    throw fail(
      "pi.resource_root_invalid",
      "Pi 资源清单包含不属于受信工作区的命令根目录。",
      "session",
    );
  }
  const respectGitignore =
    manifest.respectGitignore === undefined
      ? parseBooleanEnvironment(process.env[PI_RESPECT_GITIGNORE_ENV])
      : manifest.respectGitignore;
  if (typeof respectGitignore !== "boolean") {
    throw fail(
      "pi.resource_manifest_invalid",
      "Pi 资源清单的 respectGitignore 必须是布尔值。",
      "session",
    );
  }
  // A Host refresh is authoritative. If the Host omits the optional policy,
  // clear the previous snapshot instead of falling back to a stale startup
  // environment value. The environment fallback is applied once by the
  // adapter field for direct worker launches.
  const questionTimeoutPolicy = manifest.questionTimeoutPolicy;
  if (
    questionTimeoutPolicy !== undefined &&
    (typeof questionTimeoutPolicy !== "object" ||
      questionTimeoutPolicy === null ||
      typeof questionTimeoutPolicy.enabled !== "boolean" ||
      !Number.isSafeInteger(questionTimeoutPolicy.timeoutMs) ||
      questionTimeoutPolicy.timeoutMs < 1 ||
      questionTimeoutPolicy.timeoutMs > 2_147_483_647)
  ) {
    throw fail(
      "pi.resource_manifest_invalid",
      "Pi 资源清单的 questionTimeoutPolicy 无效。",
      "session",
    );
  }
  let goalPolicy: AgentGoalPolicy | undefined;
  if (manifest.goalPolicy !== undefined) {
    goalPolicy = normalizeGoalPolicy(manifest.goalPolicy);
    if (!goalPolicy) {
      throw fail(
        "pi.goal_policy_invalid",
        "Pi 资源清单的 goalPolicy 无效。",
        "session",
      );
    }
  }
  let subagentPolicies: AgentSubagentPolicyManifest;
  try {
    subagentPolicies = normalizePiSubagentPolicyManifest(
      manifest.subagentPolicies,
    );
  } catch (error) {
    throw fail(
      "pi.subagent_policy_invalid",
      error instanceof Error ? error.message : String(error),
      "session",
    );
  }
  return {
    skillRoots,
    promptRoots,
    respectGitignore,
    questionTimeoutPolicy,
    subagentPolicies,
    goalPolicy,
  };
};

const parseExplicitPaths = (raw: string | undefined): string[] => {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is string =>
            typeof entry === "string" &&
            entry.length > 0 &&
            entry.length <= 4096,
        )
      : [];
  } catch {
    return [];
  }
};

const addSkillCandidate = (
  candidate: string,
  matchingRoot: string,
  disabled: Set<string>,
  ignorePaths: string[],
  allowed: string[],
  seen: Set<string>,
  totalBytes: { value: number },
): void => {
  if (allowed.length >= MAX_PI_SKILL_PATHS || seen.has(candidate)) return;
  if (isIgnoredPath(candidate, ignorePaths)) return;
  const relativePath = relative(matchingRoot, candidate);
  const depth = relativePath ? relativePath.split(sep).length : 0;
  if (depth > MAX_PI_SKILL_DEPTH) return;
  const name = candidate.slice(candidate.lastIndexOf(sep) + 1);
  if (name.startsWith(".") || disabled.has(name)) return;
  try {
    const skillFileMetadata = lstatSync(join(candidate, "SKILL.md"));
    if (
      skillFileMetadata.isSymbolicLink() ||
      !skillFileMetadata.isFile() ||
      skillFileMetadata.size > MAX_PI_SKILL_FILE_BYTES ||
      totalBytes.value + skillFileMetadata.size > MAX_PI_SKILL_TOTAL_BYTES
    )
      return;
    seen.add(candidate);
    allowed.push(candidate);
    totalBytes.value += skillFileMetadata.size;
  } catch {
    // A stale path is a compatibility diagnostic, not a session failure.
  }
};

const scanSkillRoot = (root: PiSkillRootSpec): string[] => {
  const candidates: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [
    { path: root.path, depth: 0 },
  ];
  while (stack.length > 0 && candidates.length < MAX_PI_SKILL_PATHS) {
    const current = stack.pop();
    if (!current || current.depth > MAX_PI_SKILL_DEPTH) continue;
    let metadata;
    try {
      metadata = lstatSync(current.path);
    } catch {
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    // An ignored subtree is skipped before it is walked, so a hidden Skill also
    // cannot resurface as a candidate below it.
    if (
      root.ignorePaths.length > 0 &&
      isIgnoredPath(canonicalPathForBoundary(current.path), root.ignorePaths)
    ) {
      continue;
    }
    if (current.depth > 0 || root.path === current.path) {
      try {
        const skillFile = lstatSync(join(current.path, "SKILL.md"));
        if (
          !skillFile.isSymbolicLink() &&
          skillFile.isFile() &&
          skillFile.size <= MAX_PI_SKILL_FILE_BYTES
        ) {
          const canonical = realpathSync(current.path);
          // A declared plugin Skill directory is the Skill itself, while a
          // container root still only contributes its descendants.
          if (
            isWithinRoot(canonical, root.path) ||
            canonical === canonicalPathForBoundary(root.path)
          ) {
            candidates.push(canonical);
          }
          // A directory with SKILL.md is a leaf, matching Pi discovery.
          continue;
        }
      } catch {
        // Continue walking when the marker is absent or stale.
      }
    }
    if (current.depth >= MAX_PI_SKILL_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
    } catch {
      continue;
    }
    for (const entry of entries.reverse()) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        continue;
      stack.push({
        path: join(current.path, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return candidates;
};

/**
 * Parse the Host's allow-listed Skill directories. The concrete path list is
 * retained for backwards-compatible direct workers; a Host-provided root
 * manifest additionally permits safe discovery of new/removed Skills on the
 * next prompt without enabling Pi's ambient scanner.
 */
export const piSkillPathsFor = (
  cwd: string,
  rootSpecsOverride?: PiSkillRootSpec[],
): string[] => {
  const explicit = parseExplicitPaths(process.env[PI_SKILL_PATHS_ENV]);
  const rootSpecs = rootSpecsOverride ?? readSkillRootSpecs(cwd);
  const trustedRoots = canonicalRootPaths(
    skillRootsFor(cwd, pluginRootsFromResourceSpecs(rootSpecs)),
  );
  const allowed: string[] = [];
  const seen = new Set<string>();
  const totalBytes = { value: 0 };
  const explicitByRoot = new Map<string, string[]>();
  for (const value of explicit.slice(0, MAX_PI_SKILL_PATHS * 2)) {
    try {
      const metadata = lstatSync(resolve(value));
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      const canonical = realpathSync(resolve(value));
      const matchingRoot = trustedRoots.find((root) =>
        isWithinRoot(canonical, root),
      );
      if (matchingRoot) {
        const values = explicitByRoot.get(matchingRoot) ?? [];
        values.push(canonical);
        explicitByRoot.set(matchingRoot, values);
      }
    } catch {
      // A stale path is a compatibility diagnostic, not a session failure.
    }
  }
  if (rootSpecs) {
    for (const root of rootSpecs) {
      for (const candidate of explicitByRoot.get(root.path) ??
        // A spec may be a declared Skill directory below a trusted root, so the
        // concrete path is keyed by the root that actually contains it.
        [...explicitByRoot.entries()]
          .filter(([trusted]) => isWithinRoot(root.path, trusted))
          .flatMap(([, values]) =>
            values.filter((value) => isWithinRoot(value, root.path)),
          )) {
        addSkillCandidate(
          candidate,
          root.path,
          root.disabled,
          root.ignorePaths,
          allowed,
          seen,
          totalBytes,
        );
      }
      for (const candidate of scanSkillRoot(root)) {
        addSkillCandidate(
          candidate,
          root.path,
          root.disabled,
          root.ignorePaths,
          allowed,
          seen,
          totalBytes,
        );
      }
    }
  } else {
    // Direct worker compatibility: no root manifest means only the concrete
    // Host paths are accepted, preserving the previous non-widening contract.
    for (const candidate of explicit) {
      try {
        const canonical = realpathSync(resolve(candidate));
        const matchingRoot = trustedRoots.find((root) =>
          isWithinRoot(canonical, root),
        );
        if (matchingRoot) {
          addSkillCandidate(
            canonical,
            matchingRoot,
            new Set(),
            [],
            allowed,
            seen,
            totalBytes,
          );
        }
      } catch {
        // Ignore stale entries.
      }
    }
  }
  return allowed.slice(0, MAX_PI_SKILL_PATHS);
};

const canonicalPathForBoundary = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const addPromptCandidate = (
  candidate: string,
  root: PiPromptRootSpec,
  allowed: string[],
  seen: Set<string>,
  totalBytes: { value: number },
): void => {
  if (allowed.length >= MAX_PI_PROMPT_PATHS || seen.has(candidate)) return;
  if (!isDirectChild(candidate, root.path)) return;
  const name = candidate.slice(candidate.lastIndexOf(sep) + 1);
  const stem = name.slice(0, -3);
  if (!name.toLowerCase().endsWith(".md") || root.disabled.has(stem)) return;
  try {
    const metadata = lstatSync(candidate);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_PI_PROMPT_FILE_BYTES ||
      totalBytes.value + metadata.size > MAX_PI_PROMPT_TOTAL_BYTES
    )
      return;
    seen.add(candidate);
    allowed.push(candidate);
    totalBytes.value += metadata.size;
  } catch {
    // A stale path is a compatibility diagnostic, not a session failure.
  }
};

const scanPromptRoot = (
  root: PiPromptRootSpec,
  allowed: string[],
  seen: Set<string>,
  totalBytes: { value: number },
): void => {
  let entries;
  try {
    entries = readdirSync(root.path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch {
    return;
  }
  for (const entry of entries) {
    if (allowed.length >= MAX_PI_PROMPT_PATHS) break;
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    addPromptCandidate(
      join(root.path, entry.name),
      root,
      allowed,
      seen,
      totalBytes,
    );
  }
};

/**
 * Parse Host-provided Markdown command paths. The concrete path list remains
 * accepted for direct workers; a Host-provided root manifest additionally
 * permits safe discovery of new/removed flat command templates on refresh.
 */
export const piPromptPathsFor = (
  cwd: string,
  rootSpecsOverride?: PiPromptRootSpec[],
): string[] => {
  const explicit = parseExplicitPaths(process.env[PI_PROMPT_PATHS_ENV]);
  const rootSpecs = rootSpecsOverride ?? readPromptRootSpecs(cwd);
  const trustedRoots = boundaryRootPaths(
    promptRootsFor(cwd, pluginRootsFromResourceSpecs(rootSpecs)),
  );
  const allowed: string[] = [];
  const seen = new Set<string>();
  const totalBytes = { value: 0 };
  const explicitByRoot = new Map<string, string[]>();
  for (const value of explicit.slice(0, MAX_PI_PROMPT_PATHS * 2)) {
    try {
      const candidate = resolve(value);
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
      const canonical = canonicalPathForBoundary(candidate);
      const matchingRoot = trustedRoots.find((root) =>
        isDirectChild(canonical, root),
      );
      if (!matchingRoot) continue;
      const values = explicitByRoot.get(matchingRoot) ?? [];
      values.push(canonical);
      explicitByRoot.set(matchingRoot, values);
    } catch {
      // Ignore stale entries.
    }
  }
  if (rootSpecs) {
    for (const root of rootSpecs) {
      for (const candidate of explicitByRoot.get(
        canonicalPathForBoundary(root.path),
      ) ?? []) {
        addPromptCandidate(candidate, root, allowed, seen, totalBytes);
      }
      scanPromptRoot(root, allowed, seen, totalBytes);
    }
  } else {
    // Direct worker compatibility: no root manifest means concrete paths only.
    for (const candidate of explicit) {
      try {
        const canonical = canonicalPathForBoundary(resolve(candidate));
        const matchingRoot = trustedRoots.find((root) =>
          isDirectChild(canonical, root),
        );
        if (matchingRoot) {
          addPromptCandidate(
            canonical,
            { path: matchingRoot, disabled: new Set(), ignorePaths: [] },
            allowed,
            seen,
            totalBytes,
          );
        }
      } catch {
        // Ignore stale entries.
      }
    }
  }
  return allowed.slice(0, MAX_PI_PROMPT_PATHS);
};

/**
 * Resolve the worker-owned Pi data files without inheriting Pi's ambient
 * ~/.pi/agent directory.  The Host normally supplies MELODY_HOME; a direct
 * worker invocation uses a disposable temp directory for local smoke tests.
 * Explicit paths remain an opt-in escape hatch for development and managed
 * credential stores.
 */
const piRuntimePaths = (): { authPath: string; modelsPath: string } => {
  const configuredRoot = process.env.MELODY_HOME?.trim();
  const dataRoot = configuredRoot
    ? join(configuredRoot, "pi")
    : join(tmpdir(), "melody-pi");
  mkdirSync(dataRoot, { recursive: true });
  return {
    authPath:
      process.env[PI_AUTH_PATH_ENV]?.trim() || join(dataRoot, "auth.json"),
    modelsPath:
      process.env[PI_MODELS_PATH_ENV]?.trim() || join(dataRoot, "models.json"),
  };
};

/**
 * Derive a stable, opaque native-session filename from the product identity.
 *
 * Product IDs are intentionally not used as filenames: they may contain
 * characters meaningful to a filesystem and may reveal project/session
 * metadata in a diagnostic path. Including cwd prevents an accidentally
 * reused product ID from joining two workspaces' native histories.
 */
export const piSessionFileFor = (
  sessionRoot: string,
  cwd: string,
  productSessionId: string,
): string => {
  const key = createHash("sha256")
    .update(cwd)
    .update("\0")
    .update(productSessionId)
    .digest("hex");
  return join(sessionRoot, `session-${key}.jsonl`);
};

/** Validate an interrupted fork artifact before reopening it on retry. */
export const assertPiForkTargetMatches = (
  targetManager: Pick<
    ReturnType<typeof SessionManager.open>,
    "getHeader" | "getLeafId" | "getEntry"
  >,
  sourcePath: string,
  anchorEntryId: string,
): void => {
  const header = targetManager.getHeader();
  if (
    header?.parentSession !== sourcePath ||
    targetManager.getLeafId() !== anchorEntryId ||
    !targetManager.getEntry(anchorEntryId)
  ) {
    throw fail(
      "pi.fork_target_mismatch",
      "已有 Pi 分支文件与记录的源会话或锚点不一致，拒绝覆盖或打开。",
      "session",
    );
  }
};

/**
 * Derive the sidecar filename used for durable child-task metadata. Task IDs
 * never become path components; hashing also keeps the registry portable when
 * a product session id contains punctuation or non-ASCII text.
 */
export const piSubagentRecordFileFor = (
  sessionRoot: string,
  taskId: string,
): string => {
  const key = createHash("sha256").update(taskId).digest("hex");
  return join(sessionRoot, PI_SUBAGENT_RECORD_DIRECTORY, `task-${key}.json`);
};

const piThinkingLevels = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const piSubagentTypes = new Set<PiSubagentType>([
  "general-purpose",
  "explore",
  "plan",
]);

const piSubagentCapabilities = new Set<PiSubagentCapabilityMode>([
  "read-only",
  "read-write",
  "read-write-execute",
  "execute",
  "all",
]);

const piSubagentIsolations = new Set<PiSubagentIsolation>(["none", "worktree"]);
/** Mirrors the policy-side bound so a resumed child keeps the same ceiling. */
const MAX_PERSISTED_MCP_TOOLS = 64;
const PI_MCP_TOOL_PATTERN =
  /^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,96}$/u;
const piPermissionModes = new Set<"ask" | "auto" | "always-approve">([
  "ask",
  "auto",
  "always-approve",
]);

const persistedString = (
  source: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number } = {},
): string | undefined => {
  const value = source[key];
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`missing ${key}`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`invalid ${key}`);
  }
  const normalized = value.trim();
  if (
    normalized.length > (options.maxLength ?? 4_096) ||
    containsControlCharacters(normalized)
  ) {
    throw new Error(`invalid ${key}`);
  }
  return normalized;
};

const requiredPersistedString = (
  source: Record<string, unknown>,
  key: string,
  maxLength = 4_096,
): string => {
  const value = persistedString(source, key, { required: true, maxLength });
  if (!value) throw new Error(`missing ${key}`);
  return value;
};

/**
 * Validate a sidecar loaded by a new worker before the Pi SDK opens its JSONL.
 * This is exported as a small pure seam so restart/recovery tests can exercise
 * the same path-boundary checks without constructing a provider session.
 */
export const parsePersistedPiSubagentRecord = (
  value: unknown,
  expectedTaskId: string,
  sessionRoot: string,
): PersistedPiSubagent => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record must be an object");
  }
  const record = value as Record<string, unknown>;
  const taskId = requiredPersistedString(record, "taskId", 512);
  if (taskId !== expectedTaskId) throw new Error("task id mismatch");
  const rootSessionId = requiredPersistedString(record, "rootSessionId", 512);
  const parentSessionId = requiredPersistedString(
    record,
    "parentSessionId",
    512,
  );
  const subagentType = requiredPersistedString(record, "subagentType", 64);
  if (!piSubagentTypes.has(subagentType as PiSubagentType)) {
    throw new Error("invalid subagent type");
  }
  const capabilityMode = requiredPersistedString(record, "capabilityMode", 32);
  if (!piSubagentCapabilities.has(capabilityMode as PiSubagentCapabilityMode)) {
    throw new Error("invalid capability mode");
  }
  const persistedMcpTools = record.mcpTools;
  if (
    persistedMcpTools !== undefined &&
    (!Array.isArray(persistedMcpTools) ||
      persistedMcpTools.length > MAX_PERSISTED_MCP_TOOLS ||
      persistedMcpTools.some(
        (entry) =>
          typeof entry !== "string" ||
          entry.length > 128 ||
          !PI_MCP_TOOL_PATTERN.test(entry),
      ))
  ) {
    throw new Error("invalid MCP tool grants");
  }
  const isolation = requiredPersistedString(record, "isolation", 32);
  if (!piSubagentIsolations.has(isolation as PiSubagentIsolation)) {
    throw new Error("invalid isolation");
  }
  const sessionFile = requiredPersistedString(record, "sessionFile");
  const cwd = requiredPersistedString(record, "cwd");
  const reasoningEffort = requiredPersistedString(
    record,
    "reasoningEffort",
    32,
  );
  if (!piThinkingLevels.has(reasoningEffort as PiThinkingLevel)) {
    throw new Error("invalid reasoning effort");
  }
  const status = requiredPersistedString(record, "status", 32);
  if (!new Set(["running", "completed", "failed", "cancelled"]).has(status)) {
    throw new Error("invalid status");
  }
  const updatedAt = record.updatedAt;
  if (
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0
  ) {
    throw new Error("invalid updatedAt");
  }
  const canonicalRoot = realpathSync(sessionRoot);
  const canonicalSessionFile = realpathSync(sessionFile);
  if (
    !canonicalSessionFile.startsWith(`${canonicalRoot}${sep}`) ||
    !lstatSync(canonicalSessionFile).isFile()
  ) {
    throw new Error("session file is outside the Pi session root");
  }
  const optional = (key: string, maxLength = 4_096) =>
    persistedString(record, key, { maxLength });
  const parentTaskId = optional("parentTaskId", 512);
  const role = optional("role", 128);
  const persona = optional("persona", 128);
  const agent = optional("agent", 128);
  const worktreePath = optional("worktreePath");
  const resumedFrom = optional("resumedFrom", 512);
  const modelId = optional("modelId", 256);
  const permissionMode = optional("permissionMode", 32);
  if (
    permissionMode &&
    !piPermissionModes.has(permissionMode as "ask" | "auto" | "always-approve")
  ) {
    throw new Error("invalid permission mode");
  }
  const output = optional("output", 64 * 1024);
  return {
    taskId,
    rootSessionId,
    parentSessionId,
    ...(parentTaskId ? { parentTaskId } : {}),
    subagentType: subagentType as PiSubagentType,
    ...(role ? { role } : {}),
    ...(persona ? { persona } : {}),
    ...(agent ? { agent } : {}),
    capabilityMode: capabilityMode as PiSubagentCapabilityMode,
    ...(persistedMcpTools
      ? { mcpTools: [...(persistedMcpTools as string[])] }
      : {}),
    isolation: isolation as PiSubagentIsolation,
    ...(worktreePath ? { worktreePath } : {}),
    ...(resumedFrom ? { resumedFrom } : {}),
    sessionFile: canonicalSessionFile,
    cwd,
    ...(modelId ? { modelId } : {}),
    ...(permissionMode
      ? {
          permissionMode: permissionMode as "ask" | "auto" | "always-approve",
        }
      : {}),
    reasoningEffort: reasoningEffort as PiThinkingLevel,
    status: status as PersistedPiSubagent["status"],
    ...(output ? { output } : {}),
    updatedAt,
  };
};

export const PI_CAPABILITIES: AgentProtocolCapabilities = {
  engine: "pi",
  engineVersion: "1.0.1",
  protocolVersion: 1,
  authentication: true,
  modelCatalog: true,
  // Derived from the gateway's own name list plus the in-process extension
  // tools: the announcement, the event mapper's gateway set and tool
  // registration must never disagree about which tools exist.
  tools: [...PI_GATEWAY_TOOL_NAMES, PI_TODO_WRITE, PI_UPDATE_GOAL],
  sessionTree: true,
  compaction: true,
  plans: true,
  questions: true,
  permissions: true,
  subagents: true,
  backgroundTasks: true,
  // MCP is exposed through the Rust Host's bounded local/remote bridge. The
  // worker never starts a server or opens a transport itself.
  mcp: true,
  sessionModes: [...AGENT_SESSION_MODE_IDS],
  media: ["image-input"],
  limitations: [
    "Pi is the only Agent runtime. Unsupported or unsafe configured surfaces are diagnosed as unavailable or block opening Pi; no capability gap switches a session to ACP.",
    "MCP local stdio and bounded HTTP/SSE servers use the Host bridge; provider-specific transports are unavailable in Pi and reported as a degradation.",
    "Melody/Claude plugin JavaScript/HTTP extensions are not loaded; trusted JSON command hooks run in the Host (PreToolUse can block, post/session/compaction/subagent hooks are observational, and unsupported Stop blocking semantics are unavailable).",
    "Read-only LSP definition, reference, hover, implementation, document-symbol, and workspace-symbol queries use the Host stdio bridge; project servers require trusted=true, while unsupported transports are unavailable in Pi.",
    "Host-owned codebase_navigation provides bounded tree-sitter definitions, references, document/workspace symbols, incremental refresh and Melody codebase_indexing boolean/glob policy for Rust, TypeScript/JavaScript, Python, and Go; strict cross-file graph semantics and unsupported languages are unavailable in Pi.",
    "Host-owned web_search and web_fetch are available in Pi with bounded URL, response-size, redirect, and domain policies; provider-specific search APIs still use their configured model credentials.",
    "Host-owned browser_navigate, browser_tabs, browser_snapshot, browser_wait, browser_screenshot, browser_click, browser_type, and browser_tab_* tools use an embedded workspace Webview and per-product-session profiles (Windows/Linux use persistent directories, macOS 14+ a persistent WebKit store, and older macOS an ephemeral store). Each product session supports up to 8 tabs, bounded untrusted snapshots/waits, and per-call approval for navigation/DOM actions. Local preview is explicit and loopback-only; public HTTPS login popups require opt-in. Desktop screenshots crop to the embedded viewport but can fail on Linux Wayland or when OS/display capture is unavailable. Password inputs are neither exposed nor typed.",
    "Custom Melody model catalogs are fetched and cached by the Host, then projected into Pi providers; when no custom endpoint is configured Pi keeps its signed native catalog.",
    "The Host evaluates a workspace .envrc through direnv export json with an empty environment and bounded names/values; arbitrary shell environment inheritance is not enabled.",
    "Host-owned memory_search, memory_get, and memory_remember read/write the existing global/workspace/session Markdown layout with bounded BM25-style ranking and guarded durable-note writes; the Host maintains a versioned SQLite lexical sidecar and uses Markdown when sidecar validation fails. The Host also performs first-turn injection and deterministic session-end snapshots. Pi's compaction extension adds a bounded first-pass memory-flush note and exposes /flush before native compaction; embedding/vector ranking and dream consolidation are unavailable in Pi.",
    "Headless OAuth login is not exposed; configure provider API keys in Melody settings.",
    "Background task output, wait-any/wait-all, and cancellation are exposed through the Melody-compatible task tools; Pi child tasks and Host-owned terminal tasks share the same scoped controls.",
    "Pi owns the bounded two-pass compaction/memory-flush extension, basic update_goal state persistence, and deterministic token-budget/stall/blocked-attempt safeguards. Configured advanced goal orchestration, model pins, external-auth commands, and dynamic plugin tools are unavailable in Pi. Pi supports general-purpose/explore/plan roles and read-only/read-write/execute/all capability ceilings with parent-child intersection. Custom auto-compaction thresholds map to Pi's native reserve-token setting, while the Host ToolGateway applies terminal, question-timeout, web, `.envrc`, and `.gitignore` visibility policies.",
    "Pi Host path checks are not a kernel sandbox. An unrepresentable configured isolation profile blocks opening Pi; platforms with no sandbox implementation show an explicit warning and run without OS sandboxing. Neither case switches to ACP.",
  ],
  diagnostics: [
    {
      code: "pi.plugins_unavailable",
      capability: "plugins",
      severity: "warning",
      message:
        "Pi 不会加载 Melody/Claude 插件的动态扩展、命令或代理；相关表面在本次会话中不可用，静态 Markdown Skill/命令资源仍可由 Host 受控投影。",
    },
    {
      code: "pi.hooks_unavailable",
      capability: "hooks",
      severity: "warning",
      message:
        "Pi 通过 Host 执行受限 JSON command Hook（PreToolUse 可阻断，post/session/compaction/subagent 为观察）；动态 JS/HTTP、未知事件及未映射 Stop 阻断语义在本次会话中不可用。",
    },
    {
      code: "pi.lsp_unavailable",
      capability: "lsp",
      severity: "warning",
      message:
        "Pi 通过 Host 只读 stdio 桥接接管受信任的 LSP；插件 LSP、非 stdio 传输或未显式 trusted=true 的项目配置在本次会话中不可用。",
    },
    {
      code: "pi.memory_semantic_index_unavailable",
      capability: "memory",
      severity: "warning",
      message:
        "Pi 已接管基础 Markdown 记忆检索、受控 memory_remember 写入、首轮注入、会话保存和两阶段 memory flush（含 /flush）；embedding/vector index 或 dream consolidation 在本次会话中不可用。",
    },
    {
      code: "pi.external_auth_unavailable",
      capability: "external-auth-provider",
      severity: "warning",
      message:
        "Pi 迁移版只支持 Host 管理的 API key，不执行外部认证提供程序命令。",
    },
    {
      code: "pi.oidc_unavailable",
      capability: "oidc-authentication",
      severity: "warning",
      message: "Pi 迁移版不提供浏览器/PKCE OIDC 登录流程。",
    },
    {
      code: "pi.subagent_policy_unavailable",
      capability: "subagent-policy",
      severity: "warning",
      message:
        "Pi 已支持声明式 agent 的提示、模型、权限和隔离；当前定义包含动态工具、Hook、MCP 或完成门禁时，该定义在本次会话中不可用。",
    },
    {
      code: "pi.goal_orchestration_unavailable",
      capability: "goal-orchestration",
      severity: "warning",
      message:
        "Pi 已支持基础 goal 状态、update_goal，以及有界的 token budget、停滞检测和阻塞次数护栏；Melody 的分类器、规划/验证器、重试编排或角色模型策略在本次会话中不可用。",
    },
    {
      code: "pi.terminal_policy_unavailable",
      capability: "terminal-policy",
      severity: "warning",
      message:
        "Melody 的终端超时或输出上限配置无法安全解析；该配置不会应用，本次会话使用 Host 默认上限。",
    },
    {
      code: "pi.question_timeout_policy_unavailable",
      capability: "question-timeout-policy",
      severity: "warning",
      message:
        "Pi 不应用无法安全解析的 Melody 自定义提问等待策略，本次会话使用默认行为。",
    },
    {
      code: "pi.sandbox_unavailable",
      capability: "sandbox",
      severity: "warning",
      message:
        "Pi Host 路径检查不等同于 OS 级沙箱；无法表达的隔离配置会阻止 Pi 会话，平台不支持沙箱时明确警告并以无沙箱方式运行。",
    },
  ],
};

/**
 * Isolated Pi SDK adapter. Every exposed tool is a Host-owned ToolGateway
 * proxy; the worker never receives an ambient filesystem or shell
 * implementation. The desktop product uses Pi as its only Agent runtime;
 * browser preview fixtures are deliberately not a native Pi session.
 */
export class PiSessionAdapter {
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly tasks = new Map<string, TaskHandle>();
  private readonly continuingTasks = new Set<string>();
  /**
   * Open/import/close/configure are lifecycle mutations. The worker dispatches
   * stdin frames concurrently so tool resolutions can unblock a running turn,
   * so these operations need a smaller per-session queue of their own to
   * prevent duplicate native sessions, close/import races, or a configuration
   * update mutating a handle after it has been disposed. Long-running turns
   * stay outside this queue so tool/approval responses remain concurrent.
   */
  private readonly lifecycleTails = new Map<string, Promise<unknown>>();
  private modelRuntimePromise?: Promise<PiModelRuntime>;
  private modelCatalogRevision = 0;
  /** Serialize catalog reloads so a fast settings save cannot publish an
   * older projection after a newer one. */
  private modelCatalogTail: Promise<unknown> = Promise.resolve();
  private readonly emit: WorkerEmitter;
  private readonly toolGateway: PiToolGateway;
  private readonly taskController: PiTaskController;
  private modelPoliciesPromise?: Promise<PiModelPolicySnapshot>;
  /** Host-resolved workspace file visibility policy shared by root/child sessions. */
  private respectGitignore = parseBooleanEnvironment(
    process.env[PI_RESPECT_GITIGNORE_ENV],
  );
  /** Host-resolved wait policy for user-question interactions. */
  private questionTimeoutPolicy = parseQuestionTimeoutPolicyEnvironment(
    process.env[PI_QUESTION_TIMEOUT_POLICY_ENV],
  );
  /** Host-resolved deterministic goal safeguards shared by root/child sessions. */
  private goalPolicy = parseGoalPolicyEnvironment(
    process.env[PI_GOAL_POLICY_ENV],
  );
  /** Host-resolved role/persona defaults shared by root and child sessions. */
  private subagentPolicies = parseSubagentPolicyEnvironment(
    process.env[PI_SUBAGENT_POLICIES_ENV],
  );

  public constructor(emit: WorkerEmitter) {
    this.emit = emit;
    this.toolGateway = new PiToolGateway(emit);
    this.taskController = {
      wait: (input) => this.waitTasksForSession(input),
      cancel: (input) => this.cancelTaskForSession(input),
    };
  }

  private async enqueueLifecycle<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.lifecycleTails.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.lifecycleTails.get(sessionId) === current) {
        this.lifecycleTails.delete(sessionId);
      }
    }
  }

  private async enqueueModelCatalog<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.modelCatalogTail;
    const current = previous.catch(() => undefined).then(operation);
    this.modelCatalogTail = current;
    try {
      return await current;
    } finally {
      if (this.modelCatalogTail === current) {
        this.modelCatalogTail = Promise.resolve();
      }
    }
  }

  /** Resolve a root or nested child session without treating the worker's
   * root-session map as the only source of truth. Tool callbacks use the
   * child stream identity, while Host commands continue to use the product
   * root identity for authorization and persistence. */
  private contextForSession(
    sessionId: string,
  ):
    | { handle: SessionHandle; task?: undefined }
    | { handle: TaskHandle; task: TaskHandle }
    | undefined {
    const root = this.sessions.get(sessionId);
    if (root) return { handle: root };
    for (const task of this.tasks.values()) {
      if (task.childSessionId === sessionId) return { handle: task, task };
    }
    return undefined;
  }

  private eventContextFor(context: {
    handle: PiSessionContext;
    task?: TaskHandle;
  }): {
    sessionId: string;
    streamSessionId?: string;
    runId?: string;
  } {
    return {
      sessionId: context.handle.rootSessionId,
      ...(context.handle.streamSessionId !== context.handle.rootSessionId
        ? { streamSessionId: context.handle.streamSessionId }
        : {}),
      ...(context.handle.runId ? { runId: context.handle.runId } : {}),
    };
  }

  public health(): AgentProtocolCapabilities {
    return PI_CAPABILITIES;
  }

  /**
   * Pi's OAuth login flow is intentionally not driven from this headless
   * worker. API-key providers are fully supported and credentials stay in the
   * Host-created auth file; status is exposed through the normal model event.
   */
  public async authenticate(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "runtime.authenticate" }
    >,
    requestId: string | number,
  ): Promise<void> {
    const runtime = await this.getModelRuntime();
    const providerId = command.providerId?.trim() || command.methodId.trim();
    const action = command.action ?? "status";
    try {
      if (action === "setApiKey") {
        if (!command.apiKey) {
          throw fail(
            "pi.auth_key_missing",
            "设置 API key 时必须提供 apiKey。",
            "runtime",
          );
        }
        await runtime.setRuntimeApiKey(providerId, command.apiKey);
      } else if (action === "removeApiKey") {
        await runtime.removeRuntimeApiKey(providerId);
      } else {
        await runtime.checkAuth(providerId);
      }
      await this.emit({
        requestId,
        event: {
          type: "runtime.warning",
          error: {
            code: "pi.authentication.updated",
            message:
              action === "status"
                ? `已检查 ${providerId} 的认证状态。`
                : `${providerId} 的认证信息已更新。`,
            retriable: false,
            scope: "runtime",
            details: { providerId, action },
          },
        },
      });
      await this.listModels(requestId, true);
    } catch (error) {
      throw Object.assign(
        fail(
          "pi.authentication_failed",
          error instanceof Error ? error.message : String(error),
          "runtime",
        ),
        { cause: error },
      );
    }
  }

  private async listModelsInternal(
    requestId: string | number,
    refresh = false,
  ): Promise<void> {
    const runtime = await this.getModelRuntime();
    const refreshErrors: Record<string, string> = {};
    if (refresh) {
      const result = await runtime.refresh({
        allowNetwork: parseBooleanEnvironment(
          process.env[PI_MODEL_NETWORK_ENV],
        ),
        force: true,
      });
      for (const [provider, error] of result.errors) {
        refreshErrors[`refresh:${provider}`] = error.message;
      }
    }

    const models = runtime.getModels();
    let availableModels = models;
    try {
      availableModels = await runtime.getAvailable();
    } catch (error) {
      availableModels = [];
      refreshErrors["availability"] =
        error instanceof Error ? error.message : String(error);
    }

    const providerAuth = new Map<string, PiProviderAuthState>();
    await Promise.all(
      runtime.getProviders().map(async (provider) => {
        try {
          const auth = await runtime.checkAuth(provider.id);
          providerAuth.set(
            provider.id,
            auth
              ? {
                  status: "configured",
                  ...(auth.source ? { source: auth.source } : {}),
                }
              : { status: "missing" },
          );
        } catch (error) {
          providerAuth.set(provider.id, { status: "unknown" });
          refreshErrors[`auth:${provider.id}`] =
            error instanceof Error ? error.message : String(error);
        }
      }),
    );

    await this.emit({
      requestId,
      event: {
        type: "runtime.models",
        revision: ++this.modelCatalogRevision,
        models: mapPiModelCatalog(models, availableModels, providerAuth),
        ...(Object.keys(refreshErrors).length > 0 ? { refreshErrors } : {}),
      },
    });
  }

  public async listModels(
    requestId: string | number,
    refresh = false,
  ): Promise<void> {
    return this.enqueueModelCatalog(() =>
      this.listModelsInternal(requestId, refresh),
    );
  }

  /**
   * Replace the generated model catalog and its short-lived environment
   * references without restarting the worker. The Host always sends the
   * complete snapshot, so removed models and credentials disappear together.
   */
  public async syncModels(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "runtime.models.sync" }
    >,
    requestId: string | number,
  ): Promise<void> {
    return this.enqueueModelCatalog(async () => {
      const runtime = await this.getModelRuntime();
      const previousPoliciesPromise = this.modelPoliciesPromise;
      const generatedPrefix = "MELODY_PI_MODEL_";
      const previousEnvironment = new Map<string, string>();
      for (const name of Object.keys(process.env)) {
        if (name.startsWith(generatedPrefix)) {
          const value = process.env[name];
          if (value !== undefined) previousEnvironment.set(name, value);
          delete process.env[name];
        }
      }
      for (const credential of command.credentials) {
        process.env[credential.name] = credential.value;
      }

      try {
        // A configured model key can otherwise be shadowed by an old
        // runtime.authenticate override. Remove only Host-generated provider
        // ids; built-in providers and user-authenticated providers remain
        // untouched.
        await Promise.all(
          command.providerIds.map((providerId) =>
            runtime.removeRuntimeApiKey(providerId),
          ),
        );
        // The policy file is part of the same Host projection as the model
        // catalog. Refresh the cached snapshot before applying it to idle
        // sessions; otherwise a settings save would update new sessions only.
        const policies = await loadPiModelPolicies();
        this.modelPoliciesPromise = Promise.resolve(policies);
        await this.listModelsInternal(requestId, true);
        await this.refreshModelSettingsForLiveSessions();
      } catch (error) {
        // Keep the process usable if a future SDK rejects a catalog reload.
        // Restoring the previous generated variables is best effort; the
        // Host will resend the authoritative snapshot on the next save.
        for (const name of Object.keys(process.env)) {
          if (name.startsWith(generatedPrefix)) delete process.env[name];
        }
        for (const [name, value] of previousEnvironment) {
          process.env[name] = value;
        }
        this.modelPoliciesPromise = previousPoliciesPromise;
        throw error;
      }
    });
  }

  private async refreshModelSettingsForLiveSessions(): Promise<void> {
    const roots = [...this.sessions.entries()];
    const tasks = [...this.tasks.values()].filter(
      (task) => task.status === "running",
    );
    await Promise.all([
      ...roots.map(([sessionId, handle]) =>
        this.enqueueLifecycle(sessionId, async () => {
          if (this.sessions.get(sessionId) !== handle) return;
          // A Pi run can be waiting for a tool/permission response while
          // `session.isStreaming` is false.  Keep the old policy snapshot for
          // that whole run; submit() applies the new one at the next boundary.
          if (!handle.runFinished) return;
          await handle.refreshModelSettings?.();
        }),
      ),
      ...tasks
        .filter((task) => task.status === "running" && task.runFinished)
        .map((task) => task.refreshModelSettings?.()),
    ]);
  }

  /**
   * Apply a fresh Host-owned resource manifest to every live root/child
   * session. A running provider turn keeps its current prompt/tool runtime;
   * the per-turn callback retains the new manifest and reloads it before the
   * next top-level or child prompt. Idle sessions reload immediately so a
   * settings toggle is reflected without restarting the worker.
   */
  public async refreshResources(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "session.resources.refresh" }
    >,
    requestId: string | number,
  ): Promise<void> {
    // Validate the workspace and every root once before touching any live
    // session. Individual resource bindings repeat the same checks because
    // their loader owns the final path arrays.
    const cwd = command.manifest.cwd;
    const normalizedManifest = resourceRootSpecsFor(cwd, command.manifest);
    this.respectGitignore = normalizedManifest.respectGitignore;
    this.questionTimeoutPolicy = normalizedManifest.questionTimeoutPolicy;
    this.goalPolicy = normalizedManifest.goalPolicy;
    this.subagentPolicies = normalizedManifest.subagentPolicies;
    const rootHandles = [...this.sessions.entries()];
    const taskHandles = [...this.tasks.values()];
    const failures: string[] = [];
    await Promise.all([
      ...rootHandles.map(([sessionId, handle]) =>
        this.enqueueLifecycle(sessionId, async () => {
          try {
            // `isStreaming` is not a complete activity signal: Pi may be
            // paused on a host interaction between provider requests.  The
            // worker-owned run state keeps resource reloads out of that run.
            if (!handle.runFinished) return;
            await handle.refreshResources?.(command.manifest);
          } catch (error) {
            failures.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
      ),
      ...taskHandles
        .filter((task) => task.status === "running" && task.runFinished)
        .map(async (task) => {
          try {
            await task.refreshResources?.(command.manifest);
          } catch (error) {
            failures.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
    ]);
    if (failures.length > 0) {
      throw fail(
        "pi.resource_refresh_failed",
        `Pi 资源刷新失败：${failures[0]}`,
        "session",
      );
    }
    await this.emit({
      requestId,
      event: {
        type: "runtime.warning",
        error: {
          code: "pi.resources_refreshed",
          message: `Pi 已刷新受控 Skill/命令资源（${cwd}）。`,
          retriable: false,
          scope: "runtime",
          details: {
            sessionCount: rootHandles.length,
            taskCount: taskHandles.length,
          },
        },
      },
    });
  }

  public async closeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.entries()].map(async ([sessionId]) => {
        try {
          await this.close(sessionId, undefined, "shutdown");
        } catch {
          // Shutdown should be best effort; the supervisor owns process exit.
        }
      }),
    );
    // A child task can outlive its parent handle briefly while an in-flight
    // provider request unwinds. It is normally cancelled by closeInternal,
    // but closeAll also has to cover an orphaned task when shutdown races
    // with session creation or a previous cleanup failed. Wait for every
    // task's terminal promise before clearing the registry so no child Pi
    // session or Host tool waiter survives worker shutdown.
    const remainingTasks = [...this.tasks.values()];
    await Promise.all(
      remainingTasks.map(async (task) => {
        if (task.status === "running") {
          await task.cancel().catch(() => undefined);
        }
        await task.promise.catch(() => undefined);
      }),
    );
    this.tasks.clear();
    this.toolGateway.rejectAll();
  }

  public resolveTool(
    command: Extract<AgentCommandEnvelope["command"], { type: "tool.resolve" }>,
  ): void {
    this.toolGateway.resolve(command);
  }

  public resolveInteraction(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "interaction.resolve" }
    >,
  ): void {
    this.toolGateway.resolveInteraction(command);
  }

  public async importSession(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "session.import" }
    >,
    requestId: string | number,
  ): Promise<void> {
    return this.enqueueLifecycle(command.sessionId, () =>
      this.importSessionInternal(command, requestId),
    );
  }

  private async importSessionInternal(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "session.import" }
    >,
    requestId: string | number,
  ): Promise<void> {
    const handle = this.sessions.get(command.sessionId);
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    if (!sessionRoot) {
      throw fail(
        "pi.import_storage_unavailable",
        "Pi 原生会话目录尚未由 Host 配置，不能安全导入。",
        "session",
      );
    }
    const cwd = command.cwd.trim();
    if (handle && handle.session.sessionManager.getCwd() !== cwd) {
      throw fail(
        "pi.import_cwd_mismatch",
        "导入会话的工作区必须与当前 Pi 会话一致。",
        "session",
      );
    }
    const path = piSessionFileFor(sessionRoot, cwd, command.sessionId);
    const permissionMode =
      command.permissionMode ?? handle?.permissionMode ?? "ask";
    const sessionModeId = normalizeSessionModeId(
      command.sessionModeId ?? handle?.sessionModeId,
    );
    // Validate the persisted thinking level before replacing any native
    // session. The command boundary performs the same shape check, while the
    // worker owns the Pi-specific allowed values.
    const reasoningEffort = normalizeThinkingLevel(command.reasoningEffort);
    // A migration may be requested before this worker has opened the product
    // session (the normal case after switching engines). When a handle does
    // exist, close it without publishing `session.closed`: the Host still has
    // the legacy binding at this point and would correctly reject a Pi event
    // before the import event switches ownership.
    if (handle)
      await this.closeInternal(
        command.sessionId,
        requestId,
        "session_closed",
        false,
      );
    const materialized = materializePiSessionImport(command.plan, {
      path,
      cwd,
      // Reusing an existing native id would append the imported records to a
      // live Pi history. Generate a fresh id for every explicit replacement;
      // the pre-import file remains recoverable through the optional backup.
      nativeSessionId: undefined,
      // The contract and Host journal require an explicit choice. Do not
      // silently turn malformed/direct worker invocations into a backup.
      backup: command.backup,
    });
    await this.openInternal(
      {
        type: "session.open",
        sessionId: command.sessionId,
        productSessionId: command.sessionId,
        cwd,
        permissionMode,
        modelId: command.modelId,
        reasoningEffort,
        sessionModeId,
      },
      requestId,
      false,
    );
    const importedHandle = this.sessions.get(command.sessionId);
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "session.imported",
        nativeSessionId: materialized.nativeSessionId,
        importedRecords: materialized.records,
        migrationId: command.migrationId,
        ...(materialized.backupPath
          ? { backupPath: materialized.backupPath }
          : {}),
        revision: importedHandle?.configRevision ?? 0,
        ...(importedHandle?.modelId ? { modelId: importedHandle.modelId } : {}),
        ...(importedHandle?.reasoningEffort
          ? { reasoningEffort: importedHandle.reasoningEffort }
          : {}),
        sessionModeId: importedHandle?.sessionModeId ?? "default",
        permissionMode: importedHandle?.permissionMode ?? permissionMode,
      },
    });
    // Emit the normal acknowledgement after the migration event so the Host
    // can atomically change the database binding before it sees any other Pi
    // lifecycle event for this session.
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "session.opened",
        nativeSessionId: materialized.nativeSessionId,
        revision: importedHandle?.configRevision ?? 0,
        ...(importedHandle?.modelId ? { modelId: importedHandle.modelId } : {}),
        ...(importedHandle?.reasoningEffort
          ? { reasoningEffort: importedHandle.reasoningEffort }
          : {}),
        sessionModeId: importedHandle?.sessionModeId ?? "default",
        permissionMode: importedHandle?.permissionMode ?? permissionMode,
      },
    });
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "runtime.warning",
        error: {
          code: "pi.builtin_tools_disabled",
          message:
            "Pi worker 已禁用 Pi 内置工具，仅通过 Melody ToolGateway 提供受控的文件、终端和交互工具。",
          retriable: false,
          scope: "runtime",
        },
      },
    });
  }

  public async open(
    command: Extract<AgentCommandEnvelope["command"], { type: "session.open" }>,
    requestId: string | number,
  ): Promise<void> {
    const lifecycleKey = command.productSessionId ?? command.sessionId;
    if (lifecycleKey) {
      return this.enqueueLifecycle(lifecycleKey, () =>
        this.openInternal(command, requestId, true),
      );
    }
    await this.openInternal(command, requestId, true);
  }

  /**
   * Extract a verified assistant entry into a separate native Pi session.
   * The source manager is opened independently so createBranchedSession can
   * never move the active source session's in-memory leaf.
   */
  public async fork(
    command: Extract<AgentCommandEnvelope["command"], { type: "session.fork" }>,
    requestId: string | number,
  ): Promise<void> {
    return this.enqueueLifecycle(command.sessionId, async () => {
      const source = this.sessions.get(command.sessionId);
      if (!source) {
        throw fail(
          "pi.fork_source_not_open",
          "请先打开要探索的 Pi 会话，再从已完成回复创建分支。",
          "session",
        );
      }
      if (!source.runFinished) {
        throw fail(
          "pi.fork_source_running",
          "会话仍在运行，暂时不能从中创建探索分支。",
          "session",
        );
      }
      if (
        command.sessionId === command.targetSessionId ||
        source.session.sessionManager.getCwd() !== command.cwd
      ) {
        throw fail(
          "pi.fork_scope_mismatch",
          "探索分支必须使用新的产品会话，并与源会话处于同一工作区。",
          "session",
        );
      }
      const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
      if (!sessionRoot) {
        throw fail(
          "pi.fork_storage_unavailable",
          "Pi 原生会话目录尚未由 Host 配置，不能创建持久分支。",
          "session",
        );
      }

      const sourcePath = piSessionFileFor(
        sessionRoot,
        command.cwd,
        command.sessionId,
      );
      const targetPath = piSessionFileFor(
        sessionRoot,
        command.cwd,
        command.targetSessionId,
      );
      let sourceMetadata;
      try {
        sourceMetadata = lstatSync(sourcePath);
      } catch {
        throw fail(
          "pi.fork_source_missing",
          "找不到源会话的 Pi 原生记录，无法安全创建分支。",
          "session",
        );
      }
      if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
        throw fail(
          "pi.fork_source_invalid",
          "源会话的 Pi 原生记录不是受信任的普通文件。",
          "session",
        );
      }
      let existingTarget = false;
      try {
        const targetMetadata = lstatSync(targetPath);
        if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
          throw fail(
            "pi.fork_target_invalid",
            "目标会话原生记录不是受信任的普通文件。",
            "session",
          );
        }
        existingTarget = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const sourceManager = SessionManager.open(
        sourcePath,
        sessionRoot,
        command.cwd,
      );
      const anchor = sourceManager.getEntry(command.nativeEntryId);
      const anchorMessage =
        anchor?.type === "message" && anchor.message.role === "assistant"
          ? anchor.message
          : undefined;
      const anchorText = anchorMessage
        ? textFromContent(anchorMessage.content)
        : undefined;
      const anchorHasToolCall =
        Array.isArray(anchorMessage?.content) &&
        anchorMessage.content.some(
          (part) =>
            part !== null &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "toolCall",
        );
      if (
        !anchor ||
        !anchorMessage ||
        !anchorText?.trim() ||
        anchorHasToolCall
      ) {
        throw fail(
          "pi.fork_anchor_invalid",
          "只能从可验证的纯文本 assistant 回复创建探索分支。",
          "session",
        );
      }

      if (existingTarget) {
        const existingManager = SessionManager.open(
          targetPath,
          sessionRoot,
          command.cwd,
        );
        assertPiForkTargetMatches(existingManager, sourcePath, anchor.id);
      } else {
        const temporaryPath = sourceManager.createBranchedSession(anchor.id);
        if (!temporaryPath) {
          throw fail(
            "pi.fork_not_persistent",
            "Pi SDK 没有生成持久分支记录。",
            "session",
          );
        }
        try {
          // COPYFILE_EXCL prevents a raced or pre-created target from being
          // overwritten. The SDK artifact is always removed afterward.
          copyFileSync(temporaryPath, targetPath, fsConstants.COPYFILE_EXCL);
        } finally {
          try {
            unlinkSync(temporaryPath);
          } catch {
            // Preserve the primary fork error; an orphaned SDK temp file is not
            // addressable as a product session and can be safely ignored.
          }
        }
      }

      await this.openInternal(
        {
          type: "session.open",
          sessionId: command.targetSessionId,
          productSessionId: command.targetSessionId,
          cwd: command.cwd,
          permissionMode: source.permissionMode,
          ...(source.modelId ? { modelId: source.modelId } : {}),
          reasoningEffort: source.reasoningEffort,
          sessionModeId: source.sessionModeId,
        },
        requestId,
        true,
      );
    });
  }

  private async openInternal(
    command: Extract<AgentCommandEnvelope["command"], { type: "session.open" }>,
    requestId: string | number,
    emitLifecycle: boolean,
  ): Promise<void> {
    const productSessionId = command.productSessionId ?? command.sessionId;
    const requestedSessionModeId = normalizeSessionModeId(
      command.sessionModeId,
    );
    const requestedThinkingLevel = normalizeThinkingLevel(
      command.reasoningEffort,
    );
    if (productSessionId) {
      const existing = this.sessions.get(productSessionId);
      if (existing) {
        const existingCwd = existing.session.sessionManager.getCwd();
        if (existingCwd !== command.cwd) {
          throw fail(
            "pi.session_cwd_mismatch",
            `Pi 会话 ${productSessionId} 已绑定到另一个工作区。`,
            "session",
          );
        }
        // Opening an already-live product session is intentionally
        // idempotent. The renderer can reconnect after a view switch without
        // creating a second native session or losing the current revision.
        if (emitLifecycle) {
          await this.emit({
            requestId,
            sessionId: productSessionId,
            event: {
              type: "session.opened",
              nativeSessionId: existing.nativeSessionId,
              revision: existing.configRevision,
              ...(existing.modelId ? { modelId: existing.modelId } : {}),
              ...(existing.reasoningEffort
                ? { reasoningEffort: existing.reasoningEffort }
                : {}),
              sessionModeId: existing.sessionModeId,
              permissionMode: existing.permissionMode,
            },
          });
        }
        return;
      }
    }
    const pi = await loadPiSdk();
    const modelRuntime = await this.getModelRuntime();
    let sessionIdRef = productSessionId ?? "";
    const resourceBinding = await this.createResourceLoader(
      pi,
      command.cwd,
      () =>
        this.contextForSession(sessionIdRef)?.handle.sessionModeId ??
        requestedSessionModeId,
      () => "all",
      () =>
        this.contextForSession(sessionIdRef)?.handle.session.getSessionStats()
          .tokens.total,
    );
    const resourceLoader = resourceBinding.loader;
    const model = command.modelId
      ? this.resolveModel(modelRuntime, command.modelId)
      : undefined;
    const settingsManager = pi.SettingsManager.inMemory(
      await this.settingsOverridesForModel(model),
    );
    // `productSessionId` is the stable product-session key. Pi owns a
    // separate native UUID; keeping both lets the host persist a binding and
    // reopen the same native JSONL without conflating it with ACP IDs.
    const sessionManager = this.createSessionManager(
      pi,
      command.cwd,
      productSessionId,
    );
    const { session } = await pi.createAgentSession({
      cwd: command.cwd,
      model,
      ...(requestedThinkingLevel
        ? { thinkingLevel: requestedThinkingLevel }
        : {}),
      modelRuntime,
      customTools: this.toolGateway.createTools(
        () => sessionIdRef,
        () => this.contextForSession(sessionIdRef)?.handle.runId,
        () =>
          this.contextForSession(sessionIdRef)?.handle.permissionMode ??
          command.permissionMode,
        () =>
          this.contextForSession(
            sessionIdRef,
          )?.handle.session.sessionManager.getCwd() ?? command.cwd,
        (input) => this.spawnSubagent(input),
        () =>
          this.contextForSession(sessionIdRef)?.handle.rootSessionId ??
          sessionIdRef,
        () =>
          this.contextForSession(sessionIdRef)?.handle.sessionModeId ??
          "default",
        this.taskController,
        () => this.respectGitignore,
        () => this.questionTimeoutPolicy,
        undefined,
        undefined,
        resourceBinding.activateScopedInstructions,
      ),
      sessionManager,
      resourceLoader,
      settingsManager,
      // Disable Pi's built-in shell/read/write tools while keeping Melody's
      // explicit custom ToolGateway tools available to the session.
      noTools: "builtin",
      tools: PI_CAPABILITIES.tools,
    });
    const nativeSessionId = session.sessionId;
    const sessionId = productSessionId ?? nativeSessionId;
    sessionIdRef = sessionId;
    const handle: SessionHandle = {
      session,
      refreshResources: async (manifest) => {
        resourceBinding.refreshPaths(manifest);
        // Updating an active session's loader is safe, but rebuilding its
        // system prompt in the middle of a provider stream is not. The next
        // fresh turn will call this callback again and perform the reload.
        if (!session.isStreaming) await session.reload();
      },
      refreshModelSettings: async () => {
        if (session.isStreaming) return;
        applyModelPolicyOverrides(
          session.settingsManager,
          await this.settingsOverridesForModel(session.model),
        );
      },
      nativeSessionId,
      runFinished: true,
      nextMessage: 0,
      offsets: new Map(),
      activeMessageIds: new Map(),
      eventTail: Promise.resolve(),
      idempotency: new IdempotencyLedger(),
      unsubscribe: () => undefined,
      permissionMode: command.permissionMode,
      sessionModeId: requestedSessionModeId,
      capabilityMode: "all",
      ...(modelIdForSession(session, command.modelId)
        ? { modelId: modelIdForSession(session, command.modelId) }
        : {}),
      reasoningEffort: effectiveThinkingLevelForSession(
        session,
        requestedThinkingLevel,
      ),
      configRevision: 0,
      rootSessionId: sessionId,
      streamSessionId: sessionId,
    };
    this.sessions.set(sessionId, handle);
    handle.unsubscribe = session.subscribe((event) => {
      handle.eventTail = handle.eventTail
        .then(() => this.onPiEvent(sessionId, event))
        .catch(async (error) => {
          const runId = handle.runId;
          const shouldFinish = Boolean(runId && !handle.runFinished);
          if (shouldFinish) handle.runFinished = true;
          await this.emit({
            sessionId,
            event: { type: "runtime.error", error: asError(error) },
          });
          if (shouldFinish && runId) {
            await this.emit({
              sessionId,
              runId,
              event: {
                type: "run.finished",
                ...(handle.promptId ? { promptId: handle.promptId } : {}),
                status: "failed",
                stopReason: "pi_event_error",
                error: asError(error, "run"),
              },
            });
          }
        });
    });
    if (emitLifecycle) {
      await this.emit({
        requestId,
        sessionId,
        event: {
          type: "session.opened",
          nativeSessionId,
          revision: handle.configRevision,
          ...(handle.modelId ? { modelId: handle.modelId } : {}),
          reasoningEffort: handle.reasoningEffort,
          sessionModeId: handle.sessionModeId,
          permissionMode: handle.permissionMode,
        },
      });
      await this.emit({
        requestId,
        sessionId,
        event: {
          type: "runtime.warning",
          error: {
            code: "pi.builtin_tools_disabled",
            message:
              "Pi worker 已禁用 Pi 内置工具，仅通过 Melody ToolGateway 提供受控的文件、终端和交互工具。",
            retriable: false,
            scope: "runtime",
          },
        },
      });
    }
  }

  public async close(
    sessionId: string,
    requestId?: string | number,
    stopReason: "session_closed" | "shutdown" = "session_closed",
    emitLifecycle = true,
  ): Promise<void> {
    return this.enqueueLifecycle(sessionId, () =>
      this.closeInternal(sessionId, requestId, stopReason, emitLifecycle),
    );
  }

  private async closeInternal(
    sessionId: string,
    requestId?: string | number,
    stopReason: "session_closed" | "shutdown" = "session_closed",
    emitLifecycle = true,
  ): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) throw sessionError(`Pi session 不存在：${sessionId}。`);
    const runId = handle.runId;
    const childTasks = [...this.tasks.values()].filter(
      (task) => task.rootSessionId === sessionId,
    );
    await Promise.all(childTasks.map((task) => task.cancel()));
    const wasRunning = Boolean(runId && !handle.runFinished);
    // Mark the run before aborting. Pi may synchronously emit agent_settled
    // while abort unwinds; that event must not turn a user stop into a false
    // successful completion.
    if (wasRunning) handle.runFinished = true;
    handle.session.clearQueue();
    if (handle.session.isStreaming) {
      try {
        await handle.session.abort();
      } catch {
        // Disposal below is still required when an in-flight provider rejects
        // its abort request.
      }
    }
    handle.unsubscribe();
    handle.session.dispose();
    handle.idempotency.clear();
    this.sessions.delete(sessionId);
    if (wasRunning && runId) {
      await this.emit({
        requestId,
        sessionId,
        runId,
        event: {
          type: "run.finished",
          ...(handle.promptId ? { promptId: handle.promptId } : {}),
          status: "cancelled",
          stopReason,
        },
      });
    }
    if (emitLifecycle) {
      await this.emit({
        requestId,
        sessionId,
        event: { type: "session.closed" },
      });
    }
  }

  public async submit(
    command: Extract<AgentCommandEnvelope["command"], { type: "turn.submit" }>,
    requestId: string | number,
    idempotencyKey?: string,
  ): Promise<void> {
    const handle = this.sessions.get(command.sessionId);
    if (!handle)
      throw sessionError(`Pi session 不存在：${command.sessionId}。`);
    // `cancel()` marks the old run finished before awaiting Pi.abort(). Do not
    // start a replacement prompt in that small window: Pi may still be
    // unwinding the provider request and would otherwise receive overlapping
    // prompt/abort calls. The cancellation transition also emits its terminal
    // event before this admission resumes.
    if (handle.runTransition) {
      await handle.runTransition;
      if (this.sessions.get(command.sessionId) !== handle) {
        throw sessionError(`Pi 会话已关闭：${command.sessionId}。`);
      }
    }
    if (command.config.configRevision !== handle.configRevision) {
      throw fail(
        "pi.config_revision_conflict",
        `Pi 会话配置已更新（当前 revision ${handle.configRevision}），请刷新后重试。`,
        "session",
      );
    }
    // `session.isStreaming` can remain false for a short window after Pi
    // accepts the first prompt. Use the worker-owned run state as the
    // admission guard as well; otherwise two concurrent stdin dispatches can
    // both call prompt() before the SDK flips its streaming flag and the
    // second run would overwrite the first run's event identity.
    const activeRun = Boolean(handle.runId && !handle.runFinished);
    if (activeRun && command.streamingBehavior === undefined) {
      throw fail(
        "pi.streaming_behavior_required",
        "Pi 会话正在流式运行；请指定 steer 或 followUp 后再提交。",
        "run",
      );
    }
    if (activeRun && !handle.session.isStreaming) {
      throw fail(
        "pi.run_not_streaming",
        "Pi 会话正在启动上一回合，暂时不能 steer 或 follow-up，请稍后重试。",
        "run",
      );
    }
    // Revision checks order configuration updates, while this snapshot check
    // prevents a renderer with stale values from changing permission/mode
    // semantics at the turn boundary. Do it before decoding attachments or
    // claiming idempotency so an invalid turn has no observable side effect.
    const { sessionModeId: nextSessionModeId } = validateTurnConfigSnapshot(
      command.config,
      handle,
    );
    const runId = `${command.sessionId}:${command.promptId}`;
    assertModelSupportsAttachments(handle.session.model, command.attachments);
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    const textAttachments: string[] = [];
    let attachmentBytes = 0;
    for (const attachment of command.attachments) {
      const decoded = decodeAttachment(attachment.url, attachment.mediaType);
      attachmentBytes += decoded.byteLength;
      if (attachmentBytes > MAX_PI_ATTACHMENT_TOTAL_BYTES) {
        throw fail(
          "pi.attachments_too_large",
          `本次请求的附件总大小不能超过 ${MAX_PI_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MiB。`,
          "run",
        );
      }
      if (decoded.image) {
        images.push(decoded.image);
      } else {
        textAttachments.push(
          `[附件 ${attachment.filename ?? attachment.mediaType}]\n${decoded.text ?? ""}`,
        );
      }
    }
    const content = textAttachments.length
      ? `${command.content}\n\n${textAttachments.join("\n\n")}`
      : command.content;
    if (idempotencyKey?.trim()) {
      const claim = handle.idempotency.claim(
        idempotencyKey,
        fingerprintCommand(command),
        runId,
      );
      if (claim.kind === "duplicate") return;
      if (claim.kind === "conflict") {
        throw fail(
          "pi.idempotency_conflict",
          `幂等键 ${idempotencyKey.trim()} 已用于另一条请求。`,
          "run",
        );
      }
    }
    handle.runId = runId;
    handle.promptId = command.promptId;
    handle.sessionModeId = nextSessionModeId;
    handle.runFinished = false;
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      runId,
      event: { type: "run.accepted", promptId: command.promptId },
    });
    // Cancel may have arrived while the acceptance event was waiting on the
    // worker writer. Re-check the identity before invoking Pi so a prompt
    // cancelled in that narrow window is never started after the UI has
    // already received its terminal cancellation event.
    if (
      handle.runFinished ||
      handle.runId !== runId ||
      this.sessions.get(command.sessionId) !== handle
    ) {
      return;
    }
    try {
      // Refresh the explicit Host-projected resources only for a fresh turn.
      // Steering/follow-up messages share an already-running Pi turn and must
      // not rebuild its runtime underneath the provider request.
      if (!activeRun) await handle.refreshResources?.();
      if (!activeRun) await handle.refreshModelSettings?.();
      if (
        handle.runFinished ||
        handle.runId !== runId ||
        this.sessions.get(command.sessionId) !== handle
      ) {
        return;
      }
      if (activeRun && command.streamingBehavior === "steer") {
        await handle.session.steer(content, images);
      } else if (activeRun && command.streamingBehavior === "followUp") {
        await handle.session.followUp(content, images);
      } else {
        await handle.session.prompt(content, {
          images,
          streamingBehavior: command.streamingBehavior,
        });
      }
      await handle.eventTail;
      if (!handle.runFinished) {
        handle.runFinished = true;
        await this.emit({
          requestId,
          sessionId: command.sessionId,
          runId,
          event: {
            type: "run.finished",
            promptId: command.promptId,
            status: "completed",
            stopReason: "pi_idle",
          },
        });
      }
    } catch (error) {
      // Cancellation/close can abort Pi's prompt asynchronously. The abort
      // then rejects this await, but close()/cancel() already emitted the
      // single cancelled terminal event. Do not append a second failed
      // terminal event (or let a newly reopened session inherit it).
      const shouldEmitFailure =
        !handle.runFinished && this.sessions.get(command.sessionId) === handle;
      handle.runFinished = true;
      const agentError =
        (error as { agentError?: AgentError }).agentError ??
        asError(error, "run");
      if (shouldEmitFailure) {
        await this.emit({
          requestId,
          sessionId: command.sessionId,
          runId,
          event: {
            type: "run.finished",
            promptId: command.promptId,
            status: "failed",
            error: agentError,
          },
        });
      }
      throw error;
    }
  }

  public async steer(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "turn.steer" | "turn.follow_up" }
    >,
    requestId: string | number,
  ): Promise<void> {
    const handle = this.sessions.get(command.sessionId);
    if (!handle)
      throw sessionError(`Pi session 不存在：${command.sessionId}。`);
    assertActivePiRun({
      expectedRunId: command.runId,
      activeRunId: handle.runId,
      runFinished: handle.runFinished,
      isStreaming: handle.session.isStreaming,
    });
    if (command.type === "turn.steer")
      await handle.session.steer(command.content);
    else await handle.session.followUp(command.content);
    // The run may have been cancelled, closed, or replaced while the SDK
    // awaited the steer/follow-up call. Never publish an acknowledgement for
    // that stale command; the terminal event belongs to the newer owner.
    if (
      handle.runFinished ||
      handle.runId !== command.runId ||
      this.sessions.get(command.sessionId) !== handle
    ) {
      return;
    }
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      runId: command.runId,
      event: {
        type: "run.accepted",
        ...(handle.promptId ? { promptId: handle.promptId } : {}),
      },
    });
  }

  public async cancel(
    command: Extract<AgentCommandEnvelope["command"], { type: "turn.cancel" }>,
    requestId: string | number,
  ): Promise<void> {
    const handle = this.sessions.get(command.sessionId);
    if (!handle)
      throw sessionError(`Pi session 不存在：${command.sessionId}。`);
    assertPiCancelTarget({
      expectedRunId: command.runId,
      expectedPromptId: command.promptId,
      activeRunId: handle.runId,
      activePromptId: handle.promptId,
    });
    // Multiple UI paths can issue the same cancel while the provider is
    // unwinding. Reuse the first transition instead of starting a second
    // concurrent abort (which can reject or race the terminal event).
    if (handle.runTransition) {
      await handle.runTransition;
      return;
    }
    const runId = handle.runId;
    const wasRunning = Boolean(runId && !handle.runFinished);
    if (wasRunning) handle.runFinished = true;
    // Keep cancellation as one short-lived transition. A concurrent submit
    // waits for this promise and therefore cannot overlap Pi.abort() or race
    // the old terminal event with a new run.
    const transition = (async () => {
      handle.session.clearQueue();
      // Pi throws when abort() is called while the session is idle. A cancel
      // command can legitimately race the final event, so only abort an
      // active stream and keep cancellation idempotent.
      if (handle.session.isStreaming) {
        await handle.session.abort().catch(() => undefined);
      }
      if (command.cancelSubagents) {
        await Promise.all(
          [...this.tasks.values()]
            .filter((task) => task.rootSessionId === command.sessionId)
            .map((task) => task.cancel()),
        );
      }
      // Close/reopen can remove this handle while abort is pending. A new
      // run may also own the same product id after a lifecycle replacement;
      // only the original handle/run may receive this terminal event.
      const stillOwnsRun =
        wasRunning &&
        Boolean(runId) &&
        this.sessions.get(command.sessionId) === handle &&
        handle.runId === runId;
      if (stillOwnsRun && runId) {
        await this.emit({
          requestId,
          sessionId: command.sessionId,
          runId,
          event: {
            type: "run.finished",
            ...(handle.promptId ? { promptId: handle.promptId } : {}),
            status: "cancelled",
            stopReason: command.reason,
          },
        });
      }
    })();
    handle.runTransition = transition;
    try {
      await transition;
    } finally {
      if (handle.runTransition === transition) {
        handle.runTransition = undefined;
      }
    }
  }

  private taskSnapshot(task: TaskHandle): PiTaskSnapshot {
    return {
      taskId: task.taskId,
      status: task.status,
      ...(task.output ? { output: task.output } : {}),
      childSessionId: task.childSessionId,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      ...(task.role ? { role: task.role } : {}),
      ...(task.persona ? { persona: task.persona } : {}),
      ...(task.agent ? { agent: task.agent } : {}),
      ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
      isolation: task.isolation,
      ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
    };
  }

  private async loadPersistedSubagent(
    taskId: string,
  ): Promise<PersistedPiSubagent | undefined> {
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    if (!sessionRoot) return undefined;
    const path = piSubagentRecordFileFor(sessionRoot, taskId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw fail(
        "pi.resume_record_unavailable",
        `读取 Pi 子代理恢复记录失败：${error instanceof Error ? error.message : String(error)}`,
        "run",
      );
    }
    try {
      return parsePersistedPiSubagentRecord(
        JSON.parse(text),
        taskId,
        sessionRoot,
      );
    } catch (error) {
      throw fail(
        "pi.resume_record_invalid",
        `Pi 子代理恢复记录无效：${error instanceof Error ? error.message : String(error)}`,
        "run",
      );
    }
  }

  private async persistSubagentRecord(task: TaskHandle): Promise<void> {
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    const sessionFile = task.sessionFile;
    if (!sessionRoot || !sessionFile) return;
    // SessionManager allocates a path before the first assistant message is
    // flushed. Do not publish a resumable record until there is a real JSONL
    // transcript to open after a worker restart.
    try {
      if (!lstatSync(sessionFile).isFile()) return;
    } catch {
      return;
    }
    const record: PersistedPiSubagent = {
      taskId: task.taskId,
      rootSessionId: task.rootSessionId,
      parentSessionId: task.parentSessionId,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      subagentType: task.subagentType,
      ...(task.role ? { role: task.role } : {}),
      ...(task.persona ? { persona: task.persona } : {}),
      ...(task.agent ? { agent: task.agent } : {}),
      capabilityMode: task.capabilityMode,
      permissionMode: task.permissionMode,
      isolation: task.isolation,
      ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
      ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
      sessionFile,
      cwd: task.session.sessionManager.getCwd(),
      ...(task.modelId ? { modelId: task.modelId } : {}),
      reasoningEffort: task.reasoningEffort,
      status: task.status,
      ...(task.output ? { output: task.output.slice(-64 * 1024) } : {}),
      updatedAt: Date.now(),
    };
    const directory = join(sessionRoot, PI_SUBAGENT_RECORD_DIRECTORY);
    await mkdir(directory, { recursive: true });
    const path = piSubagentRecordFileFor(sessionRoot, task.taskId);
    const temporary = join(
      directory,
      `.${task.taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-32)}-${randomUUID()}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(record)}\n`, "utf8");
    await rename(temporary, path);
  }

  /**
   * A root session may inspect all of its descendants. A child session may
   * only inspect itself or tasks nested below it; this prevents a model from
   * using an otherwise valid task id to observe a sibling session.
   */
  private taskVisibleToSession(task: TaskHandle, sessionId: string): boolean {
    const context = this.contextForSession(sessionId);
    if (!context || task.rootSessionId !== context.handle.rootSessionId) {
      return false;
    }
    if (!context.task) return true;
    let current: TaskHandle | undefined = task;
    while (current) {
      if (current.taskId === context.task.taskId) return true;
      current = current.parentTaskId
        ? this.tasks.get(current.parentTaskId)
        : undefined;
    }
    return false;
  }

  private taskForController(taskId: string, sessionId: string): TaskHandle {
    const normalized = taskId.trim();
    const task = normalized ? this.tasks.get(normalized) : undefined;
    if (!task || !this.taskVisibleToSession(task, sessionId)) {
      throw fail(
        "pi.task_not_found",
        `找不到可由当前会话访问的后台任务：${taskId}。`,
        "run",
      );
    }
    return task;
  }

  private taskListForController(
    taskIds: readonly string[],
    sessionId: string,
  ): TaskHandle[] {
    const normalized = [...new Set(taskIds.map((taskId) => taskId.trim()))];
    if (normalized.length === 0 || normalized.some((taskId) => !taskId)) {
      throw fail("pi.task_ids_invalid", "后台任务 ID 列表不能为空。", "run");
    }
    if (normalized.length > 20) {
      throw fail("pi.task_ids_too_many", "一次最多等待 20 个后台任务。", "run");
    }
    return normalized.map((taskId) =>
      this.taskForController(taskId, sessionId),
    );
  }

  private async waitTasksForSession(input: {
    taskIds: string[];
    mode: "wait_any" | "wait_all";
    timeoutMs: number;
    parentSessionId: string;
  }): Promise<readonly PiTaskSnapshot[]> {
    if (input.mode !== "wait_any" && input.mode !== "wait_all") {
      throw fail(
        "pi.task_wait_mode_invalid",
        `不支持的后台任务等待模式：${input.mode}。`,
        "run",
      );
    }
    const normalized = [
      ...new Set(input.taskIds.map((taskId) => taskId.trim())),
    ];
    if (normalized.length === 0 || normalized.some((taskId) => !taskId)) {
      throw fail("pi.task_ids_invalid", "后台任务 ID 列表不能为空。", "run");
    }
    if (normalized.length > 20) {
      throw fail("pi.task_ids_too_many", "一次最多等待 20 个后台任务。", "run");
    }
    const timeoutMs = Math.max(
      0,
      Math.min(
        120_000,
        Number.isFinite(input.timeoutMs) ? Math.trunc(input.timeoutMs) : 0,
      ),
    );
    const hostTasks = normalized.filter((taskId) =>
      this.isHostBackgroundTaskId(taskId),
    );
    if (hostTasks.length > 0) {
      if (hostTasks.length !== normalized.length) {
        throw fail(
          "pi.task_scope_mixed",
          "一次等待不能混合 Host 终端任务和 Pi 子代理任务。",
          "run",
        );
      }
      return this.hostBackgroundTaskControl(
        input.parentSessionId,
        PI_WAIT_COMMANDS_OR_SUBAGENTS,
        {
          task_ids: normalized,
          mode: input.mode,
          timeout_ms: timeoutMs,
        },
      );
    }
    const tasks = this.taskListForController(normalized, input.parentSessionId);
    if (timeoutMs > 0 && tasks.some((task) => task.status === "running")) {
      const completion = tasks.map((task) =>
        task.promise.catch(() => ({ output: task.output })),
      );
      const target =
        input.mode === "wait_all"
          ? Promise.all(completion)
          : Promise.race(completion);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          target,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return tasks.map((task) => this.taskSnapshot(task));
  }

  private async cancelTaskForSession(input: {
    taskId: string;
    parentSessionId: string;
  }): Promise<PiTaskSnapshot> {
    if (this.isHostBackgroundTaskId(input.taskId)) {
      const snapshots = await this.hostBackgroundTaskControl(
        input.parentSessionId,
        PI_KILL_COMMAND_OR_SUBAGENT,
        { task_id: input.taskId.trim() },
      );
      const snapshot = snapshots[0];
      if (!snapshot) {
        throw fail(
          "pi.host_task_response_invalid",
          "宿主没有返回被取消的后台终端任务。",
          "run",
        );
      }
      return snapshot;
    }
    const task = this.taskForController(input.taskId, input.parentSessionId);
    await task.cancel();
    await task.promise.catch(() => undefined);
    return this.taskSnapshot(task);
  }

  public async waitTask(
    command: TaskCommand,
    requestId: string | number,
  ): Promise<void> {
    const task = this.tasks.get(command.taskId);
    if (!task || task.rootSessionId !== command.sessionId) {
      throw fail(
        "pi.task_not_found",
        `找不到后台任务：${command.taskId}。`,
        "run",
      );
    }
    await task.promise;
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "task.changed",
        taskId: task.taskId,
        status: task.status,
        childSessionId: task.childSessionId,
        payload: {
          output: task.output,
          subagentType: task.subagentType,
          ...(task.role ? { role: task.role } : {}),
          ...(task.persona ? { persona: task.persona } : {}),
          ...(task.agent ? { agent: task.agent } : {}),
          capabilityMode: task.capabilityMode,
          permissionMode: task.permissionMode,
          isolation: task.isolation,
        },
      },
    });
  }

  public async cancelTask(
    command: TaskCommand,
    requestId: string | number,
  ): Promise<void> {
    const task = this.tasks.get(command.taskId);
    if (!task || task.rootSessionId !== command.sessionId) {
      throw fail(
        "pi.task_not_found",
        `找不到后台任务：${command.taskId}。`,
        "run",
      );
    }
    await task.cancel();
    await task.promise.catch(() => undefined);
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "task.changed",
        taskId: task.taskId,
        status: task.status,
        childSessionId: task.childSessionId,
        payload: {
          output: task.output,
          subagentType: task.subagentType,
          ...(task.role ? { role: task.role } : {}),
          ...(task.persona ? { persona: task.persona } : {}),
          ...(task.agent ? { agent: task.agent } : {}),
          capabilityMode: task.capabilityMode,
          permissionMode: task.permissionMode,
          isolation: task.isolation,
        },
      },
    });
  }

  public async continueTask(
    command: ContinueTaskCommand,
    _requestId: string | number,
  ): Promise<void> {
    if (this.continuingTasks.has(command.taskId)) {
      throw fail(
        "pi.child_continue_running",
        "该 Pi 子会话正在启动续接请求，请稍后再试。",
        "run",
      );
    }
    if (!this.sessions.has(command.sessionId)) {
      throw fail(
        "pi.session_not_found",
        `Pi 根会话不存在：${command.sessionId}。`,
        "session",
      );
    }
    this.continuingTasks.add(command.taskId);
    try {
      const candidate =
        this.tasks.get(command.taskId) ??
        (await this.loadPersistedSubagent(command.taskId));
      assertPiInteractiveChildTarget(
        command.taskId,
        candidate,
        command.sessionId,
      );
      await this.spawnSubagent({
        task: command.content,
        resumeFrom: command.taskId,
        parentSessionId: command.sessionId,
        background: true,
        continueExisting: true,
      });
    } finally {
      this.continuingTasks.delete(command.taskId);
    }
  }

  private isHostBackgroundTaskId(taskId: string): boolean {
    return taskId.trim().startsWith(PI_BACKGROUND_TERMINAL_TASK_PREFIX);
  }

  /**
   * Ask the Host to inspect one of its background terminal processes. The
   * request deliberately carries the current root/session identity so the
   * Rust registry can enforce workspace and ownership boundaries; no process
   * handle or shell implementation crosses into this worker.
   */
  private async hostBackgroundTaskControl(
    parentSessionId: string,
    toolName:
      | typeof PI_GET_COMMAND_OR_SUBAGENT_OUTPUT
      | typeof PI_WAIT_COMMANDS_OR_SUBAGENTS
      | typeof PI_KILL_COMMAND_OR_SUBAGENT,
    requestArguments: Record<string, unknown>,
  ): Promise<PiTaskSnapshot[]> {
    const context = this.contextForSession(parentSessionId);
    if (!context) {
      throw fail(
        "pi.session_not_found",
        `Pi session 不存在：${parentSessionId}。`,
        "session",
      );
    }
    const handle = context.handle;
    const resolution = await this.toolGateway.request({
      sessionId: parentSessionId,
      rootSessionId: handle.rootSessionId,
      runId: handle.runId,
      cwd: handle.session.sessionManager.getCwd(),
      toolCallId: `pi-host-task:${randomUUID()}`,
      toolName,
      arguments: requestArguments as Parameters<
        PiToolGateway["request"]
      >[0]["arguments"],
      // Task controls only inspect/cancel an already-authorized Host task.
      // `approved` still makes replayed Host requests explicit and keeps the
      // normal permission boundary deterministic.
      permissionMode: handle.permissionMode,
      approved: true,
    });
    if (resolution.status !== "completed") {
      throw fail(
        resolution.error?.code ?? "pi.host_task_control_failed",
        resolution.error?.message ?? "宿主无法处理后台终端任务请求。",
        resolution.error?.scope ?? "run",
      );
    }
    return parseHostTaskSnapshots(resolution.output ?? "");
  }

  private async spawnSubagent(input: {
    task: string;
    continueExisting?: boolean;
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
  }): Promise<{ taskId: string; output?: string; worktreePath?: string }> {
    const parentContext = this.contextForSession(input.parentSessionId);
    if (!parentContext) {
      throw fail(
        "pi.session_not_found",
        `Pi session 不存在：${input.parentSessionId}。`,
        "session",
      );
    }
    const parent = parentContext.handle;
    const parentTaskId = parentContext.task?.taskId;
    const rootSessionId = parent.rootSessionId;
    const resumeFrom = normalizePiResumeFrom(input.resumeFrom);
    const inMemoryResumeTask = resumeFrom
      ? this.tasks.get(resumeFrom)
      : undefined;
    const resumeTask =
      inMemoryResumeTask ??
      (resumeFrom ? await this.loadPersistedSubagent(resumeFrom) : undefined);
    if (resumeFrom) {
      assertPiResumeTarget(resumeFrom, resumeTask, rootSessionId);
      assertPiResumeScope(resumeTask, input.parentSessionId, parentTaskId);
      assertPiResumeIdentity(resumeTask, input);
      if (this.continuingTasks.has(resumeFrom) && !input.continueExisting) {
        throw fail(
          "pi.resume_running",
          "该 Pi 子会话正在接受用户续接请求，请等待本轮完成。",
          "run",
        );
      }
    }
    let subagentType: PiSubagentType;
    let requestedRole = input.role;
    let requestedAgent = input.agent;
    // A custom role may be supplied through the original subagent_type field
    // by Melody-build skills. Treat it as a general-purpose Pi child while
    // retaining the named declarative policy, rather than rejecting a
    // compatible task before the policy resolver can see it.
    if (resumeTask) {
      subagentType = resumeTask.subagentType ?? "general-purpose";
    } else if (
      input.subagentType &&
      !piSubagentTypes.has(input.subagentType as PiSubagentType) &&
      (this.subagentPolicies.agents.some(
        (candidate) => candidate.name === input.subagentType?.trim(),
      ) ||
        this.subagentPolicies.roles.some(
          (candidate) => candidate.name === input.subagentType?.trim(),
        ))
    ) {
      subagentType = "general-purpose";
      const named = input.subagentType.trim();
      if (
        this.subagentPolicies.agents.some(
          (candidate) => candidate.name === named,
        )
      ) {
        requestedAgent ??= named;
      } else {
        requestedRole ??= named;
      }
    } else {
      subagentType = normalizePiSubagentType(input.subagentType);
    }
    const policyResolution: PiSubagentPolicyResolution | undefined = resumeTask
      ? undefined
      : resolvePiSubagentPolicy(this.subagentPolicies, {
          subagentType,
          role: requestedRole,
          persona: input.persona,
          agent: requestedAgent,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          isolation: normalizePiSubagentIsolation(input.isolation),
          capabilityMode: normalizePiSubagentCapabilityMode(
            input.capabilityMode,
          ),
        });
    const requestedIsolation = resumeTask
      ? normalizePiSubagentIsolation(input.isolation)
      : policyResolution?.isolation;
    // A resumed transcript owns its original filesystem boundary. Never let a
    // caller turn a shared-workspace transcript into a new worktree (or vice
    // versa) while continuing the same context.
    const isolation: PiSubagentIsolation = resumeTask
      ? (normalizePiSubagentIsolation(resumeTask.isolation) ?? "none")
      : (requestedIsolation ?? "none");
    const requestedCapabilityMode = resumeTask
      ? normalizePiSubagentCapabilityMode(
          input.capabilityMode ?? resumeTask.capabilityMode,
        )
      : policyResolution?.capabilityMode;
    const capabilityMode =
      intersectPiSubagentCapabilityModes(
        requestedCapabilityMode,
        intersectPiSubagentCapabilityModes(
          defaultCapabilityForSubagentType(subagentType),
          parent.capabilityMode,
        ),
      ) ?? "read-only";
    // A bounded child may call only the MCP tools its definition named, and
    // only while the parent can reach MCP at all: otherwise spawning would be a
    // way to gain a capability the parent itself does not have.
    const requestedMcpTools: string[] = resumeTask
      ? Array.from(resumeTask.mcpTools ?? [])
      : (policyResolution?.mcpTools ?? []);
    const parentMcpTools =
      parent.capabilityMode === "all" ? undefined : parent.mcpTools;
    const mcpTools =
      capabilityMode === "all"
        ? undefined
        : new Set<string>(
            (requestedMcpTools ?? []).filter((tool: string) =>
              parent.capabilityMode === "all"
                ? true
                : (parentMcpTools?.has(tool) ?? false),
            ),
          );
    const permissionMode = intersectPiPermissionModes(
      parent.permissionMode,
      resumeTask?.permissionMode ?? policyResolution?.permissionMode,
    );
    const runningTasks = [...this.tasks.values()].filter(
      (task) => task.status === "running",
    ).length;
    if (runningTasks >= 16) {
      throw fail(
        "pi.task_limit",
        "同时运行的 Pi 子任务不能超过 16 个。",
        "run",
      );
    }
    // Completed task handles remain addressable until the UI calls wait/cancel,
    // but must not grow without bound during a long-lived desktop session.
    for (const [id, task] of this.tasks) {
      if (task.status !== "running" && this.tasks.size > 64) {
        this.tasks.delete(id);
      }
    }
    const pi = await loadPiSdk();
    const taskId =
      input.continueExisting && resumeTask
        ? resumeTask.taskId
        : `${rootSessionId}:task:${randomUUID()}`;
    const childSessionId = `${taskId}:session`;
    const promptId = input.continueExisting
      ? `${taskId}:continue:${randomUUID()}`
      : taskId;
    const runId = input.continueExisting ? `${promptId}:run` : `${taskId}:run`;
    const runtime = await this.getModelRuntime();
    const parentCwd = parent.session.sessionManager.getCwd();
    const rootHandle = this.sessions.get(rootSessionId);
    const workspaceRoot =
      rootHandle?.session.sessionManager.getCwd() ?? parentCwd;
    // A resumed child keeps the source session's cwd/worktree. For a fresh
    // child, an explicit cwd is allowed only inside the authenticated root;
    // omitting it preserves the parent's current directory.
    const resumeCwd = resumeTask
      ? "session" in resumeTask
        ? resumeTask.session.sessionManager.getCwd()
        : resumeTask.cwd
      : undefined;
    let cwd = resumeCwd
      ? (normalizePiSubagentCwd(resumeCwd, parentCwd, workspaceRoot) ??
        parentCwd)
      : (normalizePiSubagentCwd(input.cwd, parentCwd, workspaceRoot) ??
        parentCwd);
    let worktreePath = resumeTask?.worktreePath;
    if (!resumeTask && isolation === "worktree") {
      const resolution = await this.toolGateway.request({
        sessionId: input.parentSessionId,
        rootSessionId,
        runId: parent.runId,
        cwd: parentCwd,
        toolCallId: `pi-worktree:${randomUUID()}`,
        toolName: PI_CREATE_SUBAGENT_WORKTREE,
        arguments: { task_id: taskId },
        permissionMode: parent.permissionMode,
        // The user explicitly selected isolation on the model-facing tool;
        // Host still validates the workspace and keeps the operation off the
        // generic shell/file gateway.
        approved: true,
      });
      if (resolution.status !== "completed") {
        throw fail(
          resolution.error?.code ?? "pi.subagent_worktree_failed",
          resolution.error?.message ?? "宿主无法创建 Pi 子代理 worktree。",
          resolution.error?.scope ?? "run",
        );
      }
      worktreePath = parsePiWorktreeResponse(resolution.output ?? "");
      cwd =
        normalizePiSubagentCwd(worktreePath, parentCwd, workspaceRoot) ??
        (() => {
          throw fail(
            "pi.subagent_worktree_scope_denied",
            "宿主返回的子代理 worktree 不在当前项目工作区内。",
            "run",
          );
        })();
    }
    // Resuming pins the source model and reasoning level. This mirrors
    // Melody-build and prevents a caller from silently changing provider
    // state while continuing the child's own transcript.
    const role = resumeTask?.role ?? policyResolution?.role?.name;
    const persona = resumeTask?.persona ?? policyResolution?.persona?.name;
    const agent = resumeTask?.agent ?? policyResolution?.agent?.name;
    const requestedModelId =
      resumeTask?.modelId ??
      policyResolution?.modelId ??
      input.modelId ??
      parent.modelId;
    const model = resumeTask
      ? resumeTask.modelId
        ? this.resolveModel(runtime, resumeTask.modelId)
        : "session" in resumeTask
          ? (resumeTask.session.model ?? undefined)
          : undefined
      : requestedModelId
        ? this.resolveModel(runtime, requestedModelId)
        : (parent.session.model ?? undefined);
    const requestedThinkingLevel = normalizeThinkingLevel(
      resumeTask?.reasoningEffort ??
        policyResolution?.reasoningEffort ??
        input.reasoningEffort ??
        parent.reasoningEffort,
    );
    const resourceBinding = await this.createResourceLoader(
      pi,
      cwd,
      () =>
        this.contextForSession(childSessionId)?.handle.sessionModeId ??
        parent.sessionModeId,
      () =>
        this.contextForSession(childSessionId)?.handle.capabilityMode ??
        capabilityMode,
      () =>
        this.contextForSession(childSessionId)?.handle.session.getSessionStats()
          .tokens.total,
    );
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    // Keep the property check adjacent to the open call. TypeScript cannot
    // carry an assertion-function refinement through the conditional task
    // lookup, while this explicit guard documents the same invariant for the
    // runtime as well.
    if (resumeFrom && !resumeTask?.sessionFile) {
      throw fail(
        "pi.resume_unavailable",
        "该 Pi 子代理没有可恢复的持久化会话；请重新启动一个子代理。",
        "run",
      );
    }
    const sessionManager = resumeTask?.sessionFile
      ? pi.SessionManager.open(
          resumeTask.sessionFile,
          sessionRoot ?? dirname(resumeTask.sessionFile),
          cwd,
        )
      : sessionRoot
        ? pi.SessionManager.create(cwd, sessionRoot, {
            id: childSessionId,
            parentSession:
              parent.session.sessionManager.getSessionFile() ??
              parent.nativeSessionId,
          })
        : pi.SessionManager.inMemory(cwd, {
            id: childSessionId,
            parentSession: parent.nativeSessionId,
          });
    const { session } = await pi.createAgentSession({
      cwd,
      model,
      modelRuntime: runtime,
      resourceLoader: resourceBinding.loader,
      settingsManager: pi.SettingsManager.inMemory(
        await this.settingsOverridesForModel(model),
      ),
      ...(requestedThinkingLevel
        ? { thinkingLevel: requestedThinkingLevel }
        : {}),
      sessionManager,
      customTools: this.toolGateway.createTools(
        () => childSessionId,
        () => this.contextForSession(childSessionId)?.handle.runId,
        () =>
          this.contextForSession(childSessionId)?.handle.permissionMode ??
          parent.permissionMode,
        () =>
          this.contextForSession(
            childSessionId,
          )?.handle.session.sessionManager.getCwd() ?? cwd,
        (nested) => this.spawnSubagent(nested),
        () => rootSessionId,
        () =>
          this.contextForSession(childSessionId)?.handle.sessionModeId ??
          parent.sessionModeId,
        this.taskController,
        () => this.respectGitignore,
        () => this.questionTimeoutPolicy,
        () => capabilityMode,
        () =>
          this.contextForSession(childSessionId)?.handle.mcpTools ?? mcpTools,
        resourceBinding.activateScopedInstructions,
      ),
      noTools: "builtin",
      tools: PI_CAPABILITIES.tools,
    });
    const task: TaskHandle = {
      taskId,
      parentSessionId: input.parentSessionId,
      ...(parentTaskId ? { parentTaskId } : {}),
      subagentType,
      ...(role ? { role } : {}),
      ...(persona ? { persona } : {}),
      ...(agent ? { agent } : {}),
      isolation,
      permissionMode,
      ...(worktreePath ? { worktreePath } : {}),
      ...(resumeFrom ? { resumedFrom: resumeFrom } : {}),
      childSessionId,
      ...(session.sessionManager.getSessionFile()
        ? { sessionFile: session.sessionManager.getSessionFile() }
        : {}),
      session,
      refreshResources: async (manifest) => {
        resourceBinding.refreshPaths(manifest);
        if (!session.isStreaming) await session.reload();
      },
      refreshModelSettings: async () => {
        if (session.isStreaming) return;
        applyModelPolicyOverrides(
          session.settingsManager,
          await this.settingsOverridesForModel(session.model),
        );
      },
      nativeSessionId: session.sessionId,
      rootSessionId,
      streamSessionId: childSessionId,
      runId,
      promptId,
      runFinished: false,
      nextMessage: 0,
      offsets: new Map(),
      activeMessageIds: new Map(),
      eventTail: Promise.resolve(),
      sessionModeId: parent.sessionModeId,
      capabilityMode,
      ...(mcpTools ? { mcpTools } : {}),
      ...(modelIdForSession(session, requestedModelId)
        ? { modelId: modelIdForSession(session, requestedModelId) }
        : {}),
      reasoningEffort: effectiveThinkingLevelForSession(
        session,
        requestedThinkingLevel,
      ),
      configRevision: 0,
      promise: Promise.resolve({ output: "" }),
      unsubscribe: () => undefined,
      cancel: async () => {
        if (task.status !== "running") return;
        const wasRunning = !task.runFinished;
        task.status = "cancelled";
        task.runFinished = true;
        session.clearQueue();
        if (session.isStreaming) await session.abort().catch(() => undefined);
        if (wasRunning && task.runId) {
          await this.emit({
            sessionId: rootSessionId,
            streamSessionId: childSessionId,
            runId: task.runId,
            event: {
              type: "run.finished",
              promptId: task.promptId,
              status: "cancelled",
              stopReason: "parent_cancelled",
            },
          });
        }
      },
      output: "",
      status: "running",
    };
    this.tasks.set(taskId, task);
    task.unsubscribe = session.subscribe((event) => {
      task.eventTail = task.eventTail
        .then(() => this.onPiEvent(childSessionId, event))
        .catch(async (error) => {
          task.runFinished = true;
          task.status = "failed";
          await this.emit({
            sessionId: rootSessionId,
            streamSessionId: childSessionId,
            runId: task.runId,
            event: { type: "runtime.error", error: asError(error) },
          });
          await this.emit({
            sessionId: rootSessionId,
            streamSessionId: childSessionId,
            runId: task.runId,
            event: {
              type: "run.finished",
              promptId: task.promptId,
              status: "failed",
              stopReason: "pi_event_error",
              error: asError(error, "run"),
            },
          });
        });
    });
    task.promise = (async () => {
      try {
        await this.emit({
          sessionId: rootSessionId,
          event: {
            type: "subagent.changed",
            taskId,
            status: "running",
            ...(parentTaskId ? { parentTaskId } : {}),
            childSessionId,
            payload: {
              prompt: input.task,
              parentSessionId: rootSessionId,
              subagentType,
              ...(role ? { role } : {}),
              ...(persona ? { persona } : {}),
              ...(agent ? { agent } : {}),
              capabilityMode,
              permissionMode,
              isolation,
              ...(worktreePath ? { worktreePath } : {}),
              ...(resumeFrom ? { resumedFrom: resumeFrom } : {}),
              ...(parentTaskId ? { parentTaskId } : {}),
              ...(task.modelId ? { modelId: task.modelId } : {}),
              reasoningEffort: task.reasoningEffort,
            },
          },
        });
        // A cancellation can arrive while the initial status event is being
        // delivered. Do not start a provider request after that cancellation
        // has already marked the task terminal.
        if (task.status !== "running") return { output: task.output };
        await this.emit({
          sessionId: rootSessionId,
          streamSessionId: childSessionId,
          runId: task.runId,
          event: { type: "run.accepted", promptId: task.promptId },
        });
        if (task.status !== "running") return { output: task.output };
        await task.refreshResources?.();
        await task.refreshModelSettings?.();
        if (task.status !== "running") return { output: task.output };
        const childPrompt = resumeTask
          ? input.task
          : composePiSubagentPrompt(policyResolution!, input.task);
        await session.prompt(childPrompt);
        await task.eventTail;
        if (task.status === "running") task.status = "completed";
        if (!task.runFinished && task.runId) {
          task.runFinished = true;
          await this.emit({
            sessionId: rootSessionId,
            streamSessionId: childSessionId,
            runId: task.runId,
            event: {
              type: "run.finished",
              promptId: task.promptId,
              status: "completed",
              stopReason: "pi_idle",
            },
          });
        }
      } catch (error) {
        if (task.status === "running") task.status = "failed";
        if (!task.runFinished && task.runId) {
          task.runFinished = true;
          // When the writer itself fails, the terminal event cannot be
          // delivered either. Keep cleanup deterministic and preserve the
          // original failure instead of leaking a live task handle.
          try {
            await this.emit({
              sessionId: rootSessionId,
              streamSessionId: childSessionId,
              runId: task.runId,
              event: {
                type: "run.finished",
                promptId: task.promptId,
                status: "failed",
                stopReason: "pi_prompt_error",
                error: asError(error, "run"),
              },
            });
          } catch {
            // A failed writer cannot accept the terminal event; cleanup below
            // is still required so the task does not remain live in memory.
          }
        }
        if (!task.output)
          task.output = error instanceof Error ? error.message : String(error);
      } finally {
        try {
          task.unsubscribe();
        } catch {
          // Cleanup must continue even if a replacement session already
          // removed the subscription.
        }
        try {
          session.dispose();
        } catch {
          // Pi dispose is best effort after abort/provider failure.
        }
        try {
          await this.persistSubagentRecord(task);
        } catch (error) {
          // A completed child remains usable in this worker even if the
          // sidecar write fails. Surface the durability loss explicitly so a
          // restart cannot look like a successful resumable handoff.
          try {
            await this.emit({
              sessionId: rootSessionId,
              event: {
                type: "runtime.warning",
                error: {
                  ...asError(error, "runtime"),
                  code: "pi.resume_persist_failed",
                  message: `Pi 子代理恢复记录保存失败：${
                    error instanceof Error ? error.message : String(error)
                  }`,
                },
              },
            });
          } catch {
            // Preserve terminal task cleanup when the event writer is down.
          }
        }
        try {
          await this.emit({
            sessionId: rootSessionId,
            event: {
              type: "subagent.changed",
              taskId,
              status: task.status,
              ...(parentTaskId ? { parentTaskId } : {}),
              childSessionId,
              payload: {
                output: task.output,
                parentSessionId: rootSessionId,
                subagentType,
                ...(agent ? { agent } : {}),
                capabilityMode,
                permissionMode,
                isolation,
                ...(worktreePath ? { worktreePath } : {}),
                ...(resumeFrom ? { resumedFrom: resumeFrom } : {}),
                ...(parentTaskId ? { parentTaskId } : {}),
                ...(task.modelId ? { modelId: task.modelId } : {}),
                reasoningEffort: task.reasoningEffort,
              },
            },
          });
        } catch {
          // The status was already updated locally; an unavailable writer is
          // handled by the worker supervisor rather than by cleanup.
        }
        try {
          await this.emit({
            sessionId: rootSessionId,
            event: {
              type: "task.changed",
              taskId,
              status: task.status,
              childSessionId,
              payload: {
                output: task.output,
                parentSessionId: rootSessionId,
                subagentType,
                ...(role ? { role } : {}),
                ...(persona ? { persona } : {}),
                ...(agent ? { agent } : {}),
                capabilityMode,
                permissionMode,
                isolation,
                ...(worktreePath ? { worktreePath } : {}),
                ...(resumeFrom ? { resumedFrom: resumeFrom } : {}),
              },
            },
          });
        } catch {
          // See the cleanup note above.
        }
      }
      return { output: task.output };
    })();
    // Background work must never become an unhandled rejection after the
    // parent tool has returned.
    void task.promise.catch(() => undefined);
    if (input.background) {
      return { taskId, ...(worktreePath ? { worktreePath } : {}) };
    }
    const result = await task.promise;
    return {
      taskId,
      output: result.output,
      ...(worktreePath ? { worktreePath } : {}),
    };
  }

  public async configure(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "session.configure" }
    >,
    requestId: string | number,
  ): Promise<void> {
    return this.enqueueLifecycle(command.sessionId, () =>
      this.configureInternal(command, requestId),
    );
  }

  private async configureInternal(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "session.configure" }
    >,
    requestId: string | number,
  ): Promise<void> {
    const handle = this.sessions.get(command.sessionId);
    if (!handle)
      throw sessionError(`Pi session 不存在：${command.sessionId}。`);
    if (
      command.expectedRevision !== undefined &&
      command.expectedRevision !== handle.configRevision
    ) {
      throw fail(
        "pi.config_revision_conflict",
        `Pi 会话配置已更新（当前 revision ${handle.configRevision}），请刷新后重试。`,
        "session",
      );
    }

    const changed =
      command.modelId !== undefined ||
      command.reasoningEffort !== undefined ||
      command.sessionModeId !== undefined ||
      command.permissionMode !== undefined;
    if (!changed) {
      throw fail(
        "pi.config_change_missing",
        "Pi 会话配置没有可应用的变更。",
        "session",
      );
    }

    // Resolve every potentially failing value before mutating either the
    // product-side handle or the Pi session. In particular, an invalid
    // reasoning level must not leave a successfully switched model behind;
    // callers use the revision as the atomic commit marker.
    const nextThinkingLevel =
      command.reasoningEffort !== undefined
        ? normalizeThinkingLevel(command.reasoningEffort)
        : undefined;
    const nextSessionModeId =
      command.sessionModeId !== undefined
        ? normalizeSessionModeId(command.sessionModeId)
        : undefined;
    const nextModel =
      command.modelId !== undefined
        ? this.resolveModel(await this.getModelRuntime(), command.modelId)
        : undefined;

    if (nextModel) {
      await handle.session.setModel(nextModel);
      applyModelPolicyOverrides(
        handle.session.settingsManager,
        await this.settingsOverridesForModel(nextModel),
      );
    }
    if (nextThinkingLevel) {
      handle.session.setThinkingLevel(nextThinkingLevel);
    }

    // Only publish the local configuration after the Pi mutation succeeds.
    // `setThinkingLevel` is synchronous and clamps to the model's supported
    // levels; normalization above guarantees the input is a valid protocol
    // value before it reaches Pi.
    if (nextSessionModeId !== undefined) {
      handle.sessionModeId = nextSessionModeId;
    }
    if (command.permissionMode !== undefined) {
      handle.permissionMode = command.permissionMode;
    }
    if (command.modelId !== undefined) {
      handle.modelId = modelIdForSession(handle.session, command.modelId);
    }
    if (
      command.modelId !== undefined ||
      command.reasoningEffort !== undefined
    ) {
      handle.reasoningEffort = effectiveThinkingLevelForSession(
        handle.session,
        nextThinkingLevel,
      );
    }
    handle.configRevision += 1;
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "session.configured",
        revision: handle.configRevision,
        ...(command.modelId !== undefined && handle.modelId
          ? { modelId: handle.modelId }
          : {}),
        ...(command.modelId !== undefined ||
        command.reasoningEffort !== undefined
          ? { reasoningEffort: handle.reasoningEffort }
          : {}),
        ...(command.sessionModeId
          ? { sessionModeId: command.sessionModeId }
          : {}),
        ...(command.permissionMode
          ? { permissionMode: command.permissionMode }
          : {}),
      },
    });
  }

  private async onPiEvent(sessionId: string, event: unknown): Promise<void> {
    const context = this.contextForSession(sessionId);
    if (!context) return;
    const handle = context.handle;
    const eventContext = this.eventContextFor({
      handle,
      ...(context.task ? { task: context.task } : {}),
    });
    const mapped = mapPiEvent(event, {
      sessionId,
      runId: handle.runId,
      promptId: handle.promptId,
      offsets: handle.offsets,
      activeMessageIds: handle.activeMessageIds,
      gatewayToolNames: new Set(PI_GATEWAY_TOOL_NAMES),
      nextMessageId: () => String(++handle.nextMessage),
    });
    for (const item of mapped) {
      let mappedEvent = item.event;
      if (
        mappedEvent.type === "message.completed" &&
        mappedEvent.role === "assistant" &&
        mappedEvent.content?.trim()
      ) {
        const leaf = handle.session.sessionManager.getLeafEntry();
        const leafMessage =
          leaf?.type === "message" && leaf.message.role === "assistant"
            ? leaf.message
            : undefined;
        const leafContent = leafMessage
          ? textFromContent(leafMessage.content)
          : undefined;
        const hasToolCall =
          Array.isArray(leafMessage?.content) &&
          leafMessage.content.some(
            (part) =>
              part !== null &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "toolCall",
          );
        // Renderer ids are projection ids, not Pi tree ids. Publish an anchor
        // only when the current native leaf is the same plain assistant answer;
        // tool-call messages are not safe Explorer fork points.
        if (
          leaf?.type === "message" &&
          leafMessage &&
          !hasToolCall &&
          leafContent === mappedEvent.content
        ) {
          mappedEvent = { ...mappedEvent, nativeEntryId: leaf.id };
        }
      }
      if (context.task) {
        if (mappedEvent.type === "message.delta") {
          context.task.output = appendTaskOutput(
            context.task.output,
            mappedEvent.text,
          );
        } else if (
          mappedEvent.type === "message.completed" &&
          mappedEvent.role === "assistant" &&
          mappedEvent.content
        ) {
          context.task.output = appendTaskOutput("", mappedEvent.content);
        }
      }
      await this.emit({
        ...eventContext,
        event: mappedEvent,
      });
    }
    const type = (event as { type?: unknown } | undefined)?.type;
    if (type === "agent_settled" && handle.runId && !handle.runFinished) {
      handle.runFinished = true;
      if (context.task && context.task.status === "running") {
        context.task.status = "completed";
      }
      await this.emit({
        ...eventContext,
        event: {
          type: "run.finished",
          ...(handle.promptId ? { promptId: handle.promptId } : {}),
          status: "completed",
          stopReason: "pi_settled",
        },
      });
    }
    if (type === "turn_end") {
      const contextUsage = handle.session.getContextUsage();
      await this.emit({
        ...eventContext,
        event: {
          type: "context.updated",
          tokens: contextUsage?.tokens ?? null,
          limit: contextUsage?.contextWindow ?? null,
          confidence:
            contextUsage?.tokens === undefined || contextUsage?.tokens === null
              ? "unknown"
              : "measured",
        },
      });
    }
  }

  private async getModelRuntime(): Promise<PiModelRuntime> {
    this.modelRuntimePromise ??= loadPiSdk().then((pi) => {
      const paths = piRuntimePaths();
      return pi.ModelRuntime.create({
        refreshOnCreate: false,
        allowModelNetwork: parseBooleanEnvironment(
          process.env[PI_MODEL_NETWORK_ENV],
        ),
        modelRefreshTimeoutMs: 15_000,
        ...(process.env[PI_CATALOG_BASE_URL_ENV]?.trim()
          ? { catalogBaseUrl: process.env[PI_CATALOG_BASE_URL_ENV].trim() }
          : {}),
        authPath: paths.authPath,
        modelsPath: paths.modelsPath,
      });
    });
    return this.modelRuntimePromise;
  }

  private async getModelPolicies(): Promise<PiModelPolicySnapshot> {
    this.modelPoliciesPromise ??= loadPiModelPolicies();
    return this.modelPoliciesPromise;
  }

  private async settingsOverridesForModel(
    model: PiModelIdentity | undefined,
  ): Promise<PiSettingsOverrides> {
    return settingsOverridesForModel(model, await this.getModelPolicies());
  }

  private async createResourceLoader(
    pi: PiSdk,
    cwd: string,
    getSessionMode: () => string,
    getCapabilityMode: () => PiSubagentCapabilityMode = () => "all",
    getTokenUsage?: () => number | undefined,
  ) {
    const configuredRoot = process.env.MELODY_HOME?.trim();
    const agentDir = configuredRoot
      ? join(configuredRoot, "pi", "agent")
      : join(tmpdir(), "melody-pi-agent");
    // Pi keeps the additional path arrays by reference. Retaining them lets
    // an existing session discover newly-added/removed Host-projected Skills
    // and prompt templates on the next turn without enabling ambient scans.
    const additionalSkillPaths = piSkillPathsFor(cwd);
    const additionalPromptTemplatePaths = piPromptPathsFor(cwd);
    const instructionScope = createPiInstructionScope();
    const extensionFactories = [
      instructionScope.extensionFactory,
      // Compaction is safe in every session mode. It uses Pi's public
      // session_before_compact hook and falls back to Pi's native one-pass
      // summary whenever the first or second pass cannot complete.
      createCompactionExtension(),
      // Goal state is durable and read-only to the model outside an active
      // lifecycle; unsupported classifier-backed orchestration is diagnosed
      // as unavailable in Pi.
      createGoalExtension(getSessionMode, getCapabilityMode, {
        policy: () => this.goalPolicy,
        getTokenUsage,
      }),
      ...(getCapabilityMode() === "read-only"
        ? []
        : [createTodoExtension(getSessionMode, getCapabilityMode)]),
    ];
    let skillRootSpecs: PiSkillRootSpec[] | undefined;
    let promptRootSpecs: PiPromptRootSpec[] | undefined;
    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      // Melody plugins are discovered and trusted by the Host. Do not let a
      // Pi worker silently execute ambient ~/.pi extensions or skills. The
      // workspace context files remain available through Pi's standard,
      // read-only AGENTS/context loader.
      noExtensions: true,
      noSkills: true,
      additionalSkillPaths,
      noPromptTemplates: true,
      additionalPromptTemplatePaths,
      noThemes: true,
      // Keep the first-party compaction/goal/todo implementations in-process while
      // ambient user/plugin extensions stay disabled. Pi owns their lifecycle
      // and custom-entry persistence; Melody still owns session-mode policy.
      extensionFactories,
    });
    await loader.reload();
    instructionScope.seed(loader.getAgentsFiles().agentsFiles);
    return {
      loader,
      activateScopedInstructions: instructionScope.activate,
      refreshPaths: (manifest?: AgentResourceManifest) => {
        if (manifest) {
          const normalized = resourceRootSpecsFor(cwd, manifest);
          skillRootSpecs = normalized.skillRoots;
          promptRootSpecs = normalized.promptRoots;
          this.respectGitignore = normalized.respectGitignore;
          this.questionTimeoutPolicy = normalized.questionTimeoutPolicy;
          this.goalPolicy = normalized.goalPolicy;
          this.subagentPolicies = normalized.subagentPolicies;
        }
        const nextSkillPaths = piSkillPathsFor(cwd, skillRootSpecs);
        additionalSkillPaths.splice(
          0,
          additionalSkillPaths.length,
          ...nextSkillPaths,
        );
        const nextPromptTemplatePaths = piPromptPathsFor(cwd, promptRootSpecs);
        additionalPromptTemplatePaths.splice(
          0,
          additionalPromptTemplatePaths.length,
          ...nextPromptTemplatePaths,
        );
      },
    } satisfies {
      loader: PiResourceLoader;
      activateScopedInstructions: typeof instructionScope.activate;
      refreshPaths: (manifest?: AgentResourceManifest) => void;
    };
  }

  private createSessionManager(
    pi: PiSdk,
    cwd: string,
    productSessionId: string | undefined,
  ) {
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    if (!sessionRoot || !productSessionId) {
      // A direct worker invocation without a Host-provided root remains a
      // safe, disposable development session rather than writing to Pi's
      // ambient ~/.pi directory.
      return pi.SessionManager.inMemory(cwd);
    }
    return pi.SessionManager.open(
      piSessionFileFor(sessionRoot, cwd, productSessionId),
      sessionRoot,
      cwd,
    );
  }

  private resolveModel(runtime: PiModelRuntime, modelId: string) {
    const parsed = parseModelId(modelId);
    const direct = parsed
      ? runtime.getModel(parsed.provider, parsed.id)
      : runtime.getModels().find((candidate) => candidate.id === modelId);
    if (direct) return direct;

    // Product configuration aliases are not sent to the provider.  Accept a
    // display-name match for callers that already use Pi's catalog, then
    // resolve the Host-generated `melody-<alias>-<ordinal>` provider.
    const byName = runtime
      .getModels()
      .find((candidate) => candidate.name === modelId);
    if (byName) return byName;
    const prefix = customProviderPrefix(modelId);
    const byAlias = runtime
      .getModels()
      .find((candidate) => candidate.provider.startsWith(prefix));
    if (byAlias) return byAlias;
    throw modelError(modelId);
  }
}
