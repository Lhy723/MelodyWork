import type { AgentError } from "@melody/agent-contract";
import { containsControlCharacters } from "@melody/agent-contract";
import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { PiTaskStatus } from "./task-tools.ts";
import { gatewayError } from "./tool-errors.ts";
import type { PiSubagentType } from "./subagent-policy-normalization.ts";

const fail = (
  code: string,
  message: string,
  scope: AgentError["scope"],
): Error & { agentError: AgentError } =>
  gatewayError(code, message, false, scope);

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

export type PiResumeTaskCandidate = {
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
 * A task id is not sufficient to authorize resume. Persisted records also
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
