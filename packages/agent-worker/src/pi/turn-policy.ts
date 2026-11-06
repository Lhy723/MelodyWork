import type {
  AgentRunConfig,
  AgentSessionModeId,
} from "@melody/agent-contract";
import {
  AGENT_SESSION_MODE_IDS,
  isAgentSessionModeId,
} from "@melody/agent-contract";
import { isPiThinkingLevel, type PiThinkingLevel } from "./subagent-records.ts";
import { gatewayError } from "./tool-errors.ts";

/** Normalize a configured reasoning level to one supported by Pi. */
export const normalizeThinkingLevel = (
  value: string | undefined,
): PiThinkingLevel | undefined => {
  if (value === undefined) return undefined;
  if (!isPiThinkingLevel(value)) {
    throw gatewayError(
      "pi.unsupported_thinking_level",
      `Pi 不支持思考强度：${value}。`,
      false,
      "session",
    );
  }
  return value;
};

/** Normalize and validate the product session mode at the Pi boundary. */
export const normalizeSessionModeId = (
  value: string | undefined,
): AgentSessionModeId => {
  const mode = value ?? "default";
  if (!isAgentSessionModeId(mode)) {
    throw gatewayError(
      "pi.unsupported_session_mode",
      `Pi 不支持会话模式：${mode}。可用模式：${AGENT_SESSION_MODE_IDS.join("、")}。`,
      false,
      "session",
    );
  }
  return mode;
};

const configSnapshotMismatch = (
  field: string,
  submitted: unknown,
  authoritative: unknown,
): ReturnType<typeof gatewayError> =>
  gatewayError(
    "pi.config_snapshot_mismatch",
    `Pi 会话的 ${field} 配置已变化（当前值：${String(authoritative ?? "未设置")}；提交值：${String(submitted ?? "未设置")}），请刷新后重试。`,
    false,
    "session",
  );

/**
 * Validate the configuration snapshot carried by a turn against the
 * worker-owned session handle. configRevision protects update order, but does
 * not prove the renderer used values acknowledged at that revision. A stale
 * composer can otherwise submit an old permission/mode/model after Pi has
 * already been configured for another value. Omitted optional fields mean
 * "use the current value" and are not treated as a mismatch.
 */
export const validateTurnConfigSnapshot = (
  config: AgentRunConfig,
  authoritative: {
    modelId?: string;
    reasoningEffort: PiThinkingLevel;
    sessionModeId: AgentSessionModeId;
    permissionMode: AgentRunConfig["permissionMode"];
  },
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
 * streaming Pi run. An old composer event arriving after a new run starts
 * must not steer that newer run with stale text.
 */
export const assertActivePiRun = (input: {
  expectedRunId: string;
  activeRunId?: string;
  runFinished: boolean;
  isStreaming: boolean;
}): void => {
  if (!input.activeRunId || input.runFinished) {
    throw gatewayError(
      "pi.run_not_active",
      "目标 Pi 运行已经结束或尚未开始，请刷新后重试。",
      false,
      "run",
    );
  }
  if (input.activeRunId !== input.expectedRunId) {
    throw gatewayError(
      "pi.run_mismatch",
      `目标 Pi 运行已变更（当前运行：${input.activeRunId}；提交运行：${input.expectedRunId}），请刷新后重试。`,
      false,
      "run",
    );
  }
  if (!input.isStreaming) {
    throw gatewayError(
      "pi.run_not_streaming",
      "目标 Pi 运行当前不在流式处理中，不能 steer 或 follow-up。",
      false,
      "run",
    );
  }
};

/**
 * Keep cancellation idempotent while rejecting a stale target that could
 * accidentally stop a newer run after a rapid submit/retry.
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
    throw gatewayError(
      "pi.run_mismatch",
      `取消请求指向的运行已变更（当前运行：${input.activeRunId ?? "无"}；提交运行：${input.expectedRunId}），已忽略以避免误取消。`,
      false,
      "run",
    );
  }
  if (
    input.expectedPromptId !== undefined &&
    input.expectedPromptId !== input.activePromptId
  ) {
    throw gatewayError(
      "pi.prompt_mismatch",
      `取消请求指向的提示已变更（当前提示：${input.activePromptId ?? "无"}；提交提示：${input.expectedPromptId}），已忽略以避免误取消。`,
      false,
      "run",
    );
  }
};
