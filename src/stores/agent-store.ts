import { create } from "zustand";

import { toUserMessage as reasonMessage } from "@/domain/app-error";
import type {
  AcpEnvelope,
  AcpSessionPhase,
  AgentContextUsage,
  AgentModelOption,
  AgentPlanDecision,
  AgentPermissionMode,
  AgentPromptAttachment,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentReasoningEffortOption,
  AgentSessionModeOption,
  AgentStatus,
  AgentSubagent,
  AgentTimelineAttachment,
  PermissionOption,
  TimelineEntry,
} from "@/domain/acp";
import { settlePlanApproval, upsertPlanApproval } from "@/domain/plan-approval";
import {
  appendSessionError,
  applySessionUpdate,
  isSessionUpdateMethod,
  notificationMetadata,
  parseSessionContextUsage,
  parseTimelineProjection,
  projectPermissionRequest,
  readTimelineProjection,
  SessionEventDeduplicator,
  settleSessionProjection,
  type SessionUpdateResult,
  TIMELINE_PROJECTION_VERSION,
  usableTimelineProjection,
} from "@/domain/session-projection";
import {
  sessionModeIdFromUpdate,
  sessionModeState,
} from "@/domain/session-mode";
import {
  isUserQuestionMethod,
  parseUserQuestionRequest,
} from "@/domain/user-question";
import {
  markPromptStarted,
  markPromptResponseReceived,
  promptResponseDisposition,
  shouldCancelBeforeFirstEvent,
} from "@/domain/prompt-timeout";
import {
  findPermissionRule,
  isTauriRuntime,
  sendAcp,
  updateStoredSession,
  upsertPermissionRule,
} from "@/lib/melody-bridge";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const INITIALIZE_REQUEST_ID = 1;
const AUTHENTICATE_REQUEST_ID = 2;
const SET_MODEL_REQUEST_ID = 4;
const SET_REASONING_EFFORT_REQUEST_ID = 5;
const SET_SESSION_MODE_REQUEST_ID = 6;
const SETUP_TIMEOUT_MS = 20_000;
const PROMPT_FIRST_EVENT_TIMEOUT_MS = 30_000;
const TRANSIENT_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const TRANSIENT_STATE_SWEEP_MS = 60 * 1000;
let nextPromptRequestId = 100;
let nextSessionOpenRequestId = -1;
const sessionEventDeduplicator = new SessionEventDeduplicator();
const fullReplayStarted = new Set<string>();
const loadFallbackTimelines = new Map<string, TimelineEntry[]>();
const pendingUserEchoBlocks = new Map<string, number>();
const pendingSessionOpens = new Map<
  number,
  { localSessionId: string; requestedSessionId?: string; createdAt: number }
>();

// prompt 请求 ID → 前后端会话映射，用于路由后台响应和运行状态。
const pendingPrompts = new Map<
  number,
  {
    acpSessionId: string;
    localSessionId: string;
    promptId: string;
    createdAt: number;
    firstEventAt?: number;
    responseReceivedAt?: number;
  }
>();
const promptTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
const cancelledPromptIds = new Set<string>();

const clearPromptTimeout = (requestId: number) => {
  const timeout = promptTimeouts.get(requestId);
  if (timeout !== undefined) {
    clearTimeout(timeout);
    promptTimeouts.delete(requestId);
  }
};

const clearPromptTimeouts = () => {
  for (const requestId of promptTimeouts.keys()) {
    clearPromptTimeout(requestId);
  }
};

const rememberCancelledPrompt = (promptId: string) => {
  cancelledPromptIds.add(promptId);
  while (cancelledPromptIds.size > 256) {
    const oldest = cancelledPromptIds.values().next().value;
    if (oldest === undefined) {
      break;
    }
    cancelledPromptIds.delete(oldest);
  }
};

const pruneTransientState = () => {
  const cutoff = Date.now() - TRANSIENT_STATE_MAX_AGE_MS;
  for (const [requestId, request] of pendingSessionOpens) {
    if (request.createdAt < cutoff) {
      pendingSessionOpens.delete(requestId);
      loadFallbackTimelines.delete(request.localSessionId);
    }
  }
  for (const [requestId, request] of pendingPrompts) {
    if (request.createdAt < cutoff) {
      pendingPrompts.delete(requestId);
      clearPromptTimeout(requestId);
      pendingUserEchoBlocks.delete(request.acpSessionId);
    }
  }
  if (fullReplayStarted.size > 128) {
    fullReplayStarted.clear();
    sessionEventDeduplicator.clear();
  }
};

const clearTransientState = () => {
  pendingSessionOpens.clear();
  pendingPrompts.clear();
  clearPromptTimeouts();
  pendingUserEchoBlocks.clear();
  loadFallbackTimelines.clear();
  fullReplayStarted.clear();
  sessionEventDeduplicator.clear();
  cancelledPromptIds.clear();
};

// A dead ACP process may never deliver another event to trigger pruning.
// Keep the module-level registries bounded even while the desktop remains open.
const scheduleTransientStateSweep = () => {
  if (typeof window === "undefined") {
    return;
  }
  window.setTimeout(() => {
    pruneTransientState();
    scheduleTransientStateSweep();
  }, TRANSIENT_STATE_SWEEP_MS);
};
scheduleTransientStateSweep();

const previewTimeline: TimelineEntry[] = [
  {
    id: "user-1",
    kind: "message",
    role: "user",
    content: "通过 ACP stdio 将 MelodyWork 连接到内置 Melody Build 智能体。",
  },
  {
    id: "assistant-1",
    kind: "message",
    role: "assistant",
    content:
      "我会验证桌面连接、初始化 ACP 会话，并让界面与工具及权限事件保持同步。",
  },
  {
    id: "tool-1",
    kind: "tool",
    toolCallId: "preview-check",
    title: "运行前端检查",
    command: "pnpm check",
    output:
      "> melody-work@0.1.0 check\n> tsc --noEmit\n\n正在等待运行此命令的授权。",
    status: "pending",
    permission: "pending",
    permissionRequestId: "preview-permission",
    permissionOptions: [
      { optionId: "reject-once", name: "拒绝一次", kind: "reject_once" },
      { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
      {
        optionId: "always-allow",
        name: "本会话始终允许",
        kind: "allow_always",
      },
    ],
  },
];

interface AgentStore {
  activeSessionId: string;
  localSessionId?: string;
  cwd: string;
  status: AgentStatus;
  acpPhase: AcpSessionPhase;
  acpSessionId?: string;
  acpCursor?: string;
  timeline: TimelineEntry[];
  backgroundTimelines: Record<string, TimelineEntry[]>;
  backgroundCursors: Record<string, string>;
  contextUsage?: AgentContextUsage;
  backgroundContextUsage: Record<string, AgentContextUsage>;
  subagents: Record<string, AgentSubagent>;
  stderr: string[];
  availableModels: AgentModelOption[];
  selectedModelId?: string;
  pendingModelId?: string;
  selectedReasoningEffort?: string;
  pendingReasoningEffort?: string;
  availableSessionModes: AgentSessionModeOption[];
  selectedSessionModeId?: string;
  pendingSessionModeId?: string;
  permissionMode: AgentPermissionMode;
  runningSessions: Record<string, boolean>;
  chatStatus: "ready" | "submitted" | "streaming" | "error";
  setStatus: (status: AgentStatus) => void;
  appendStderr: (line: string) => void;
  beginSession: (
    cwd: string,
    localSessionId: string,
    acpSessionId?: string,
    timelineJson?: string,
    acpCursor?: string,
    timelineVersion?: number,
    archivedTimelineJson?: string,
  ) => Promise<void>;
  receiveAcp: (message: AcpEnvelope) => Promise<void>;
  submitPrompt: (
    content: string,
    attachments?: AgentPromptAttachment[],
  ) => Promise<void>;
  cancelPrompt: (reason?: "user" | "timeout") => Promise<void>;
  selectModel: (modelId: string) => Promise<void>;
  selectReasoningEffort: (effort: string) => Promise<void>;
  selectSessionMode: (modeId: string) => Promise<void>;
  selectPermissionMode: (mode: AgentPermissionMode) => Promise<void>;
  resolvePermission: (entryId: string, optionId: string) => Promise<void>;
  resolveQuestion: (
    entryId: string,
    response: AgentQuestionResponse,
  ) => Promise<void>;
  resolvePlan: (
    entryId: string,
    outcome: AgentPlanDecision,
    feedback?: string,
  ) => Promise<void>;
}

const pendingPromptForSession = (sessionId: string) =>
  [...pendingPrompts.entries()].find(
    ([, pending]) => pending.acpSessionId === sessionId,
  );

const removePendingPrompt = (requestId: number) => {
  const pending = pendingPrompts.get(requestId);
  if (!pending) {
    return undefined;
  }
  pendingPrompts.delete(requestId);
  clearPromptTimeout(requestId);
  pendingUserEchoBlocks.delete(pending.acpSessionId);
  return pending;
};

const armPromptFirstEventTimeout = (requestId: number) => {
  clearPromptTimeout(requestId);
  promptTimeouts.set(
    requestId,
    setTimeout(() => {
      clearPromptTimeout(requestId);
      const pending = pendingPrompts.get(requestId);
      const state = useAgentStore.getState();
      if (
        !pending ||
        state.localSessionId !== pending.localSessionId ||
        state.acpSessionId !== pending.acpSessionId ||
        !shouldCancelBeforeFirstEvent(
          pending,
          Date.now(),
          PROMPT_FIRST_EVENT_TIMEOUT_MS,
        ) ||
        (state.chatStatus !== "submitted" && state.chatStatus !== "streaming")
      ) {
        return;
      }
      // This only guards a completely silent prompt. Tool-level deadlines
      // belong to the sidecar, while a started tool remains user-cancellable.
      void state.cancelPrompt("timeout");
    }, PROMPT_FIRST_EVENT_TIMEOUT_MS),
  );
};

const markPromptActivity = (sessionId?: string) => {
  if (!sessionId) {
    return;
  }
  const pending = pendingPromptForSession(sessionId);
  if (!pending || pending[1].firstEventAt !== undefined) {
    return;
  }
  clearPromptTimeout(pending[0]);
  pendingPrompts.set(pending[0], markPromptStarted(pending[1], Date.now()));
};

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const wireValue = (
  value: Record<string, unknown> | undefined,
  camelCase: string,
  snakeCase: string,
) => value?.[camelCase] ?? value?.[snakeCase];

const permissionToolKey = (title: string, command: string) =>
  `${title.trim()}\n${command.trim()}`;

const parsePermissionOptions = (value: unknown): PermissionOption[] =>
  Array.isArray(value)
    ? value.flatMap((option) => {
        const item = objectValue(option);
        const optionId = stringValue(item?.optionId);
        const name = stringValue(item?.name);
        const kind = stringValue(item?.kind) as PermissionOption["kind"];
        return optionId && name && kind ? [{ optionId, name, kind }] : [];
      })
    : [];

const questionResponseText = (response: AgentQuestionResponse) => {
  switch (response.outcome) {
    case "accepted":
      return "已提交回答，Melody 将继续处理。";
    case "chat_about_this":
      return "已请求进一步讨论这些问题。";
    case "skip_interview":
      return "已跳过提问，Melody 将继续制定计划。";
    case "cancelled":
      return "已取消回答。";
  }
};

const questionEntryForRequest = (
  timeline: TimelineEntry[],
  request: AgentQuestionRequest,
): TimelineEntry[] => {
  const index = timeline.findIndex(
    (entry) =>
      entry.kind === "tool" &&
      (entry.toolCallId === request.toolCallId ||
        entry.question?.requestId === request.requestId),
  );
  const existing = index >= 0 ? timeline[index] : undefined;
  const existingQuestion =
    existing?.kind === "tool" ? existing.question : undefined;
  const keepAnsweredRequest =
    existingQuestion?.requestId === request.requestId &&
    existingQuestion.outcome !== "pending";
  const next: TimelineEntry = {
    id:
      existing?.id ??
      `question-${request.toolCallId}-${String(request.requestId)}`,
    kind: "tool",
    toolCallId: request.toolCallId,
    title:
      existing?.kind === "tool" && existing.title.trim()
        ? existing.title
        : "询问用户",
    command:
      existing?.kind === "tool" && existing.command.trim()
        ? existing.command
        : "ask_user_question",
    output:
      existing?.kind === "tool" && existing.output
        ? existing.output
        : "正在等待你的回答。",
    startedAt: existing?.kind === "tool" ? existing.startedAt : Date.now(),
    activity: existing?.kind === "tool" ? existing.activity : undefined,
    status: keepAnsweredRequest
      ? existing?.kind === "tool"
        ? existing.status
        : "completed"
      : "pending",
    permission: existing?.kind === "tool" ? existing.permission : undefined,
    permissionRequestId:
      existing?.kind === "tool" ? existing.permissionRequestId : undefined,
    permissionOptions:
      existing?.kind === "tool" ? existing.permissionOptions : undefined,
    question: keepAnsweredRequest ? existingQuestion : request,
  };
  if (index < 0) {
    return [...timeline, next];
  }
  return timeline.map((entry, entryIndex) =>
    entryIndex === index ? next : entry,
  );
};

const updateQuestionEntry = (
  timeline: TimelineEntry[],
  entryId: string,
  response: AgentQuestionResponse,
): TimelineEntry[] =>
  timeline.map((entry) => {
    if (entry.id !== entryId || entry.kind !== "tool" || !entry.question) {
      return entry;
    }
    const question = entry.question;
    return {
      ...entry,
      output: questionResponseText(response),
      question: {
        ...question,
        outcome: response.outcome,
        ...(response.outcome === "accepted"
          ? {
              answers: response.answers,
              annotations: response.annotations,
              partialAnswers: undefined,
            }
          : response.outcome === "chat_about_this" ||
              response.outcome === "skip_interview"
            ? {
                partialAnswers: response.partialAnswers,
                answers: undefined,
                annotations: undefined,
              }
            : {
                answers: undefined,
                annotations: undefined,
                partialAnswers: undefined,
              }),
      },
    };
  });

const errorMessage = (message: AcpEnvelope, fallback: string) =>
  stringValue(objectValue(message.error?.data)?.message) ??
  message.error?.message ??
  fallback;

const parseDataUrl = (url: string) => {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) {
    return undefined;
  }
  return {
    data: match[3],
    base64: Boolean(match[2]),
    mediaType: match[1],
  };
};

const decodeAttachmentText = (
  parsed: NonNullable<ReturnType<typeof parseDataUrl>>,
) => {
  if (!parsed.base64) {
    return decodeURIComponent(parsed.data);
  }
  const bytes = Uint8Array.from(atob(parsed.data), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
};

const attachmentPromptBlocks = (
  attachments: AgentPromptAttachment[],
): Record<string, unknown>[] =>
  attachments.map((attachment) => {
    const parsed = parseDataUrl(attachment.url);
    if (!parsed) {
      throw new Error(`无法读取附件 ${attachment.filename ?? "文件"}。`);
    }

    const mediaType = attachment.mediaType || parsed.mediaType;
    if (mediaType.startsWith("image/")) {
      if (!parsed.base64) {
        throw new Error(`无法编码图片 ${attachment.filename ?? "附件"}。`);
      }
      return {
        type: "image",
        data: parsed.data,
        mimeType: mediaType,
      };
    }

    return {
      type: "text",
      text: [
        `<attachment filename="${attachment.filename ?? "attachment"}" media-type="${mediaType || "text/plain"}">`,
        decodeAttachmentText(parsed),
        "</attachment>",
      ].join("\n"),
    };
  });

const timelineAttachments = (
  attachments: AgentPromptAttachment[],
): AgentTimelineAttachment[] =>
  attachments.map((attachment, index) => ({
    id: `attachment-${Date.now()}-${index}`,
    type: "file",
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    url: "",
  }));

const responseMeta = (
  message: AcpEnvelope,
): Record<string, unknown> | undefined =>
  objectValue(message.result?.meta) ?? objectValue(message.result?._meta);

const preferredAuthMethod = (message: AcpEnvelope): string | undefined => {
  const methods = Array.isArray(message.result?.authMethods)
    ? message.result.authMethods.flatMap((value) => {
        const method = objectValue(value);
        const id = stringValue(method?.id);
        return id ? [id] : [];
      })
    : [];
  const preferred = stringValue(responseMeta(message)?.defaultAuthMethodId);
  if (preferred && methods.includes(preferred)) {
    return preferred;
  }
  return (
    methods.find((id) => id === "cached_token") ??
    methods.find((id) => id === "xai.api_key") ??
    methods[0]
  );
};

const reasoningEffortCopy: Record<
  string,
  { label: string; description: string }
> = {
  xhigh: { label: "极高", description: "最深入的推理与实现检查" },
  high: { label: "高", description: "更充分的推理与实现检查" },
  medium: { label: "中", description: "兼顾速度与质量" },
  low: { label: "低", description: "优先快速响应" },
};

const modelOptions = (message: AcpEnvelope) => {
  const state = objectValue(responseMeta(message)?.modelState);
  const availableModels = Array.isArray(state?.availableModels)
    ? state.availableModels.flatMap((value) => {
        const model = objectValue(value);
        const id = stringValue(model?.modelId);
        if (!id) {
          return [];
        }
        const meta = objectValue(model?._meta) ?? objectValue(model?.meta);
        const supportsReasoningEffort =
          booleanValue(meta?.supportsReasoningEffort) ?? false;
        const configuredOptions = Array.isArray(meta?.reasoningEfforts)
          ? meta.reasoningEfforts.flatMap(
              (raw): AgentReasoningEffortOption[] => {
                if (typeof raw === "string") {
                  const localized = reasoningEffortCopy[raw];
                  return [
                    {
                      id: raw,
                      value: raw,
                      label: localized?.label ?? raw,
                      description: localized?.description,
                    },
                  ];
                }
                const option = objectValue(raw);
                const optionValue = stringValue(option?.value);
                if (!optionValue) {
                  return [];
                }
                const localized = reasoningEffortCopy[optionValue];
                return [
                  {
                    id: stringValue(option?.id) ?? optionValue,
                    value: optionValue,
                    label:
                      localized?.label ??
                      stringValue(option?.label) ??
                      optionValue,
                    description:
                      localized?.description ??
                      stringValue(option?.description),
                  },
                ];
              },
            )
          : [];
        const reasoningEfforts =
          supportsReasoningEffort && configuredOptions.length === 0
            ? ["xhigh", "high", "medium", "low"].map((effort) => ({
                id: effort,
                value: effort,
                label: reasoningEffortCopy[effort].label,
                description: reasoningEffortCopy[effort].description,
              }))
            : configuredOptions;
        return [
          {
            id,
            name: stringValue(model?.name) ?? id,
            contextWindowTokens: numberValue(meta?.totalContextTokens),
            reasoningEffort: stringValue(meta?.reasoningEffort),
            reasoningEfforts,
          },
        ];
      })
    : [];
  const selectedModelId = stringValue(state?.currentModelId);
  const selectedModel = availableModels.find(
    (model) => model.id === selectedModelId,
  );
  return {
    availableModels,
    selectedModelId,
    selectedReasoningEffort: selectedModel?.reasoningEffort,
  };
};

const armSetupTimeout = (
  localSessionId: string,
  expectedPhase: AcpSessionPhase,
  message: string,
) => {
  window.setTimeout(() => {
    const state = useAgentStore.getState();
    if (
      state.localSessionId === localSessionId &&
      state.acpPhase === expectedPhase
    ) {
      useAgentStore.setState({
        acpPhase: "error",
        chatStatus: "error",
        status: { ...state.status, message },
      });
    }
  }, SETUP_TIMEOUT_MS);
};

const contextUsageFromResult = (
  result: Record<string, unknown> | undefined,
  fallback?: AgentContextUsage,
): AgentContextUsage | undefined => {
  const directUsage = parseSessionContextUsage(objectValue(result?.usage));
  if (directUsage) {
    return directUsage;
  }

  const meta = objectValue(result?._meta);
  const metadataUsage = parseSessionContextUsage(
    objectValue(meta?.["x.ai/contextUsage"]),
  );
  if (metadataUsage) {
    return metadataUsage;
  }

  const usedTokens = numberValue(meta?.totalTokens);
  if (fallback && usedTokens !== undefined && usedTokens >= 0) {
    return {
      ...fallback,
      usedTokens,
    };
  }

  return undefined;
};

const contextUsageForModel = (
  models: AgentModelOption[],
  modelId: string | undefined,
  current?: AgentContextUsage,
): AgentContextUsage | undefined => {
  const maxTokens = models.find(
    (model) => model.id === modelId,
  )?.contextWindowTokens;
  if (maxTokens === undefined || maxTokens <= 0) {
    return current;
  }
  if (current?.maxTokens === maxTokens) {
    return current;
  }
  return { usedTokens: 0, maxTokens };
};

// 从 ACP 消息中提取 session update 的真实 params。
// session/update 与 x.ai/session/update 是直连形式：
// params.sessionId / params.update。session_notification 也可能由兼容层
// 包装为 params.params.sessionId / params.params.update。
const extractSessionUpdateParams = (
  message: AcpEnvelope,
): Record<string, unknown> | undefined => {
  const params = objectValue(message.params);
  if (!params) {
    return undefined;
  }
  if (params.update !== undefined || params.sessionId !== undefined) {
    return params;
  }
  return objectValue(params.params);
};

const applySubagentUpdate = (
  subagents: Record<string, AgentSubagent>,
  update: Record<string, unknown> | undefined,
  routedSessionId: string,
  startsFullReplay: boolean,
): Record<string, AgentSubagent> => {
  const updateType = stringValue(update?.sessionUpdate);
  let next = subagents;
  if (startsFullReplay) {
    next = Object.fromEntries(
      Object.entries(subagents).filter(
        ([, subagent]) => subagent.parentSessionId !== routedSessionId,
      ),
    );
  }
  if (
    updateType !== "subagent_spawned" &&
    updateType !== "subagent_progress" &&
    updateType !== "subagent_finished"
  ) {
    return next;
  }

  const subagentId = stringValue(
    wireValue(update, "subagentId", "subagent_id"),
  );
  const childSessionId = stringValue(
    wireValue(update, "childSessionId", "child_session_id"),
  );
  if (!subagentId || !childSessionId) {
    return next;
  }

  const now = Date.now();
  const current = next[subagentId];
  if (updateType === "subagent_spawned") {
    const parentSessionId =
      stringValue(wireValue(update, "parentSessionId", "parent_session_id")) ??
      routedSessionId;
    return {
      ...next,
      [subagentId]: {
        subagentId,
        parentSessionId,
        childSessionId,
        subagentType:
          stringValue(wireValue(update, "subagentType", "subagent_type")) ??
          "general-purpose",
        description: stringValue(update?.description) ?? "Subagent",
        status: "running",
        startedAt: current?.startedAt ?? now,
        updatedAt: now,
        toolsUsed: current?.toolsUsed ?? [],
        model: stringValue(update?.model),
        persona: stringValue(update?.persona),
        role: stringValue(update?.role),
        capabilityMode: stringValue(
          wireValue(update, "capabilityMode", "capability_mode"),
        ),
        resumedFrom: stringValue(
          wireValue(update, "resumedFrom", "resumed_from"),
        ),
      },
    };
  }

  if (!current) {
    return next;
  }
  if (updateType === "subagent_progress") {
    const toolsUsed = wireValue(update, "toolsUsed", "tools_used");
    return {
      ...next,
      [subagentId]: {
        ...current,
        updatedAt: now,
        durationMs: numberValue(wireValue(update, "durationMs", "duration_ms")),
        turnCount: numberValue(wireValue(update, "turnCount", "turn_count")),
        toolCallCount: numberValue(
          wireValue(update, "toolCallCount", "tool_call_count"),
        ),
        tokensUsed: numberValue(wireValue(update, "tokensUsed", "tokens_used")),
        contextWindowTokens: numberValue(
          wireValue(update, "contextWindowTokens", "context_window_tokens"),
        ),
        contextUsagePct: numberValue(
          wireValue(update, "contextUsagePct", "context_usage_pct"),
        ),
        toolsUsed: Array.isArray(toolsUsed)
          ? toolsUsed.filter((tool): tool is string => typeof tool === "string")
          : current.toolsUsed,
        errorCount: numberValue(wireValue(update, "errorCount", "error_count")),
      },
    };
  }

  const status = stringValue(update?.status);
  return {
    ...next,
    [subagentId]: {
      ...current,
      status:
        status === "failed" || status === "cancelled" ? status : "completed",
      updatedAt: now,
      durationMs:
        numberValue(wireValue(update, "durationMs", "duration_ms")) ??
        current.durationMs,
      turnCount:
        numberValue(update?.turns) ??
        numberValue(wireValue(update, "turnCount", "turn_count")) ??
        current.turnCount,
      toolCallCount:
        numberValue(wireValue(update, "toolCalls", "tool_calls")) ??
        numberValue(wireValue(update, "toolCallCount", "tool_call_count")) ??
        current.toolCallCount,
      tokensUsed:
        numberValue(wireValue(update, "tokensUsed", "tokens_used")) ??
        current.tokensUsed,
      error: stringValue(update?.error),
      output: stringValue(update?.output),
    },
  };
};

const sendSessionOpen = async (
  localSessionId: string,
  cwd: string,
  acpSessionId?: string,
  modelId?: string,
  permissionMode: AgentPermissionMode = "ask",
  cursor?: string,
) => {
  const requestId = nextSessionOpenRequestId--;
  const meta = {
    clientIdentifier: "melody-work",
    yoloMode: permissionMode === "always-approve",
    autoMode: permissionMode === "auto",
    ...(modelId ? { modelId } : {}),
    ...(cursor ? { cursor } : {}),
  };
  pendingSessionOpens.set(requestId, {
    localSessionId,
    requestedSessionId: acpSessionId,
    createdAt: Date.now(),
  });
  try {
    await sendAcp({
      jsonrpc: "2.0",
      id: requestId,
      method: acpSessionId ? "session/load" : "session/new",
      params: acpSessionId
        ? { sessionId: acpSessionId, cwd, mcpServers: [], _meta: meta }
        : {
            cwd,
            mcpServers: [],
            _meta: meta,
          },
    });
  } catch (reason) {
    pendingSessionOpens.delete(requestId);
    throw reason;
  }
};

export const useAgentStore = create<AgentStore>((set, get) => ({
  activeSessionId: "implement-acp-bridge",
  cwd: ".",
  status: {
    phase: "stopped",
    message: "正在启动桌面连接…",
  },
  acpPhase: "idle",
  timeline: previewTimeline,
  backgroundTimelines: {},
  backgroundCursors: {},
  backgroundContextUsage: {},
  subagents: {},
  stderr: [],
  availableModels: [],
  availableSessionModes: [],
  permissionMode: useAppSettingsStore.getState().defaultPermissionMode,
  runningSessions: {},
  chatStatus: "ready",
  setStatus: (status) => {
    const current = get();
    const sessionLost =
      status.phase === "stopped" &&
      (current.chatStatus === "submitted" ||
        current.chatStatus === "streaming");
    if (
      status.phase === "stopped" ||
      status.phase === "missing" ||
      status.phase === "failed"
    ) {
      clearTransientState();
    }
    set((state) => ({
      status,
      ...(status.phase === "missing" || status.phase === "failed" || sessionLost
        ? {
            chatStatus: "error" as const,
            acpPhase: "error" as const,
          }
        : {}),
      ...(sessionLost
        ? {
            timeline: appendSessionError(
              state.timeline,
              status.message ?? "ACP sidecar 已停止，当前请求已结束。",
            ),
            runningSessions: state.localSessionId
              ? { ...state.runningSessions, [state.localSessionId]: false }
              : state.runningSessions,
          }
        : {}),
    }));
  },
  appendStderr: (line) =>
    set((state) => ({ stderr: [...state.stderr.slice(-49), line] })),
  beginSession: async (
    cwd,
    localSessionId,
    acpSessionId,
    timelineJson,
    acpCursor,
    timelineVersion,
    archivedTimelineJson,
  ) => {
    const projectionTimelineJson = archivedTimelineJson ?? timelineJson;
    // The archive can restore the display independently. A cursor is only
    // safe when the bounded snapshot was written as a complete projection;
    // version 0 deliberately forces ACP replay after compaction or migration.
    const projectionVersion = timelineVersion;
    const projectionCursor =
      projectionVersion === TIMELINE_PROJECTION_VERSION ? acpCursor : undefined;
    const fallbackTimeline = parseTimelineProjection(projectionTimelineJson);
    const archivedProjection = archivedTimelineJson
      ? readTimelineProjection(archivedTimelineJson)
      : undefined;
    const projectionRead = readTimelineProjection(projectionTimelineJson);
    const restoredTimeline = archivedProjection
      ? archivedProjection.status === "valid"
        ? archivedProjection.timeline
        : []
      : usableTimelineProjection({
          timelineJson: projectionTimelineJson,
          cursor: projectionCursor,
          version: projectionVersion,
        });
    const restoredCursor =
      projectionVersion === TIMELINE_PROJECTION_VERSION &&
      (archivedProjection?.status ?? projectionRead.status) === "valid"
        ? projectionCursor
        : undefined;
    if (!isTauriRuntime()) {
      set({
        activeSessionId: localSessionId,
        localSessionId,
        cwd,
        acpSessionId,
        acpCursor: restoredCursor,
        timeline:
          localSessionId === "implement-acp-bridge" &&
          restoredTimeline.length === 0
            ? previewTimeline
            : restoredTimeline,
        contextUsage: undefined,
        acpPhase: "initializing",
        chatStatus: "submitted",
      });
      try {
        await sendAcp({
          jsonrpc: "2.0",
          id: INITIALIZE_REQUEST_ID,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: { fs: {}, terminal: false },
            _meta: { clientType: "melody-work-preview" },
          },
        });
        armSetupTimeout(
          localSessionId,
          "initializing",
          "浏览器预览 ACP 初始化超时。",
        );
      } catch (reason) {
        set({
          acpPhase: "error",
          chatStatus: "error",
          status: { ...get().status, message: reasonMessage(reason) },
        });
      }
      return;
    }

    const state = get();
    if (
      state.localSessionId === localSessionId &&
      (state.acpPhase === "initializing" ||
        state.acpPhase === "authenticating" ||
        state.acpPhase === "creating" ||
        state.acpPhase === "ready" ||
        state.acpPhase === "prompting")
    ) {
      return;
    }

    // 切换会话时，把当前 timeline 存入后台缓冲（以 acpSessionId 索引），
    // 这样旧会话后续的 ACP 消息可以继续追加到缓冲而非丢失。
    const oldAcpSessionId = state.acpSessionId;
    const backgroundTimelines = { ...state.backgroundTimelines };
    const backgroundCursors = { ...state.backgroundCursors };
    const backgroundContextUsage = { ...state.backgroundContextUsage };
    if (
      oldAcpSessionId &&
      state.localSessionId &&
      state.localSessionId !== localSessionId
    ) {
      backgroundTimelines[oldAcpSessionId] = state.timeline;
      if (state.acpCursor) {
        backgroundCursors[oldAcpSessionId] = state.acpCursor;
      }
      if (state.contextUsage) {
        backgroundContextUsage[oldAcpSessionId] = state.contextUsage;
      }
    }

    // 恢复新会话：优先使用后台缓冲（含切换后产生的新回复），
    // 否则从数据库持久化的 timelineJson 恢复。
    const restoredFromBuffer = acpSessionId
      ? backgroundTimelines[acpSessionId]
      : undefined;
    const finalTimeline = restoredFromBuffer ?? restoredTimeline;
    const finalCursor =
      restoredFromBuffer && acpSessionId
        ? backgroundCursors[acpSessionId]
        : restoredCursor;
    const restoredContextUsage = acpSessionId
      ? backgroundContextUsage[acpSessionId]
      : undefined;
    if (acpSessionId && restoredFromBuffer) {
      delete backgroundTimelines[acpSessionId];
      delete backgroundCursors[acpSessionId];
    }
    if (acpSessionId && restoredContextUsage) {
      delete backgroundContextUsage[acpSessionId];
    }
    if (acpSessionId) {
      loadFallbackTimelines.set(localSessionId, fallbackTimeline);
      fullReplayStarted.delete(acpSessionId);
      sessionEventDeduplicator.reset(acpSessionId);
    }

    set({
      activeSessionId: localSessionId,
      localSessionId,
      cwd,
      acpSessionId,
      acpCursor: finalCursor,
      timeline: finalTimeline,
      backgroundTimelines,
      backgroundCursors,
      contextUsage:
        restoredContextUsage ??
        contextUsageForModel(state.availableModels, state.selectedModelId),
      backgroundContextUsage,
      availableSessionModes: [],
      selectedSessionModeId: undefined,
      pendingSessionModeId: undefined,
      acpPhase: state.acpPhase === "idle" ? "initializing" : "creating",
      chatStatus: "submitted",
    });
    try {
      if (state.acpPhase !== "idle") {
        await sendSessionOpen(
          localSessionId,
          cwd,
          acpSessionId,
          state.selectedModelId,
          state.permissionMode,
          finalCursor,
        );
        armSetupTimeout(localSessionId, "creating", "打开 Melody 会话超时。");
        return;
      }
      await sendAcp({
        jsonrpc: "2.0",
        id: INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          _meta: {
            startupHints: {
              nonInteractive: false,
              skipGitStatus: false,
              skipProjectLayout: false,
            },
            clientType: "melody-work",
            clientVersion: "0.1.0",
          },
        },
      });
      armSetupTimeout(
        localSessionId,
        "initializing",
        "初始化 Melody Build 超时。",
      );
    } catch (reason) {
      set({
        acpPhase: "error",
        chatStatus: "error",
        status: {
          ...get().status,
          message: reasonMessage(reason),
        },
      });
    }
  },
  receiveAcp: async (message) => {
    pruneTransientState();
    try {
      if (isUserQuestionMethod(message.method) && message.id !== undefined) {
        const request = parseUserQuestionRequest(message, get().acpSessionId);
        if (!request) {
          return;
        }
        markPromptActivity(request.sessionId);
        const currentAcpSessionId = get().acpSessionId;
        if (currentAcpSessionId && request.sessionId !== currentAcpSessionId) {
          set((state) => ({
            backgroundTimelines: {
              ...state.backgroundTimelines,
              [request.sessionId]: questionEntryForRequest(
                state.backgroundTimelines[request.sessionId] ?? [],
                request,
              ),
            },
          }));
        } else {
          set((state) => ({
            timeline: questionEntryForRequest(state.timeline, request),
            acpPhase: "prompting",
            chatStatus: "streaming",
          }));
        }
        return;
      }

      if (message.id === INITIALIZE_REQUEST_ID) {
        if (message.error) {
          set({
            acpPhase: "error",
            chatStatus: "error",
            status: {
              ...get().status,
              message: errorMessage(message, "ACP 初始化失败"),
            },
          });
          return;
        }
        const models = modelOptions(message);
        const selectedModelId = models.selectedModelId ?? get().selectedModelId;
        set({
          availableModels: models.availableModels,
          selectedModelId,
          selectedReasoningEffort:
            models.selectedReasoningEffort ?? get().selectedReasoningEffort,
          contextUsage: contextUsageForModel(
            models.availableModels,
            selectedModelId,
            get().contextUsage,
          ),
        });
        const methodId = preferredAuthMethod(message);
        if (methodId) {
          set({ acpPhase: "authenticating" });
          try {
            await sendAcp({
              jsonrpc: "2.0",
              id: AUTHENTICATE_REQUEST_ID,
              method: "authenticate",
              params: {
                methodId,
                _meta: { headless: false },
              },
            });
            const localSessionId = get().localSessionId;
            if (localSessionId) {
              armSetupTimeout(
                localSessionId,
                "authenticating",
                "Melody Build 身份验证超时。请通过 Melody CLI 登录后重试。",
              );
            }
          } catch (reason) {
            set({
              acpPhase: "error",
              chatStatus: "error",
              status: { ...get().status, message: reasonMessage(reason) },
            });
          }
          return;
        }
        set({ acpPhase: "creating" });
        try {
          const localSessionId = get().localSessionId;
          if (!localSessionId) {
            return;
          }
          await sendSessionOpen(
            localSessionId,
            get().cwd,
            get().acpSessionId,
            get().selectedModelId,
            get().permissionMode,
            get().acpCursor,
          );
          armSetupTimeout(localSessionId, "creating", "打开 Melody 会话超时。");
        } catch (reason) {
          set({
            acpPhase: "error",
            chatStatus: "error",
            status: { ...get().status, message: reasonMessage(reason) },
          });
        }
        return;
      }

      if (message.id === AUTHENTICATE_REQUEST_ID) {
        if (message.error) {
          set({
            acpPhase: "error",
            chatStatus: "error",
            status: {
              ...get().status,
              message: errorMessage(
                message,
                "Melody 身份验证失败。请通过 Melody CLI 登录后重试。",
              ),
            },
          });
          return;
        }
        set({ acpPhase: "creating" });
        try {
          const localSessionId = get().localSessionId;
          if (!localSessionId) {
            return;
          }
          await sendSessionOpen(
            localSessionId,
            get().cwd,
            get().acpSessionId,
            get().selectedModelId,
            get().permissionMode,
            get().acpCursor,
          );
          armSetupTimeout(localSessionId, "creating", "打开 Melody 会话超时。");
        } catch (reason) {
          set({
            acpPhase: "error",
            chatStatus: "error",
            status: { ...get().status, message: reasonMessage(reason) },
          });
        }
        return;
      }

      if (message.id === SET_MODEL_REQUEST_ID) {
        const pendingModelId = get().pendingModelId;
        if (message.error || !pendingModelId) {
          const detail = errorMessage(message, "切换 Melody 模型失败");
          set({
            pendingModelId: undefined,
            acpPhase: "error",
            chatStatus: "error",
            status: { ...get().status, message: detail },
          });
          return;
        }
        const selectedModel = get().availableModels.find(
          (model) => model.id === pendingModelId,
        );
        set({
          selectedModelId: pendingModelId,
          selectedReasoningEffort: selectedModel?.reasoningEffort,
          contextUsage: contextUsageForModel(
            get().availableModels,
            pendingModelId,
          ),
          pendingModelId: undefined,
          acpPhase: "ready",
          chatStatus: "ready",
          status: {
            ...get().status,
            message: `正在使用 ${pendingModelId}`,
          },
        });
        return;
      }

      if (message.id === SET_REASONING_EFFORT_REQUEST_ID) {
        const pendingReasoningEffort = get().pendingReasoningEffort;
        if (message.error || !pendingReasoningEffort) {
          const detail = errorMessage(message, "更改推理强度失败");
          set({
            pendingReasoningEffort: undefined,
            acpPhase: "error",
            chatStatus: "error",
            status: { ...get().status, message: detail },
          });
          return;
        }
        set({
          selectedReasoningEffort: pendingReasoningEffort,
          pendingReasoningEffort: undefined,
          acpPhase: "ready",
          chatStatus: "ready",
          status: {
            ...get().status,
            message: `推理强度：${pendingReasoningEffort}`,
          },
        });
        return;
      }

      if (message.id === SET_SESSION_MODE_REQUEST_ID) {
        const pendingSessionModeId = get().pendingSessionModeId;
        if (message.error) {
          const detail = errorMessage(message, "切换 Melody 会话模式失败");
          set({
            pendingSessionModeId: undefined,
            status: { ...get().status, message: detail },
          });
          return;
        }
        if (pendingSessionModeId) {
          set({
            selectedSessionModeId: pendingSessionModeId,
            pendingSessionModeId: undefined,
            status: {
              ...get().status,
              message: `会话模式：${pendingSessionModeId}`,
            },
          });
        }
        return;
      }

      const pendingOpen =
        typeof message.id === "number"
          ? pendingSessionOpens.get(message.id)
          : undefined;
      if (pendingOpen) {
        pendingSessionOpens.delete(message.id as number);
        const sessionId =
          stringValue(message.result?.sessionId) ??
          pendingOpen.requestedSessionId;
        const isCurrent = pendingOpen.localSessionId === get().localSessionId;
        if (message.error && pendingOpen.requestedSessionId) {
          if (!isCurrent) {
            return;
          }
          const fallback = loadFallbackTimelines.get(
            pendingOpen.localSessionId,
          );
          const detail = errorMessage(message, "无法加载 Melody 会话");
          set((state) => ({
            acpPhase: "error",
            chatStatus: "error",
            timeline:
              state.timeline.length > 0
                ? state.timeline
                : (fallback ?? state.timeline),
            status: {
              ...state.status,
              message: `${detail}。已保留本地只读缓存，没有创建替代会话。`,
            },
          }));
          return;
        }
        if (message.error || !sessionId) {
          if (isCurrent) {
            set({
              acpPhase: "error",
              chatStatus: "error",
              status: {
                ...get().status,
                message: errorMessage(message, "Melody 没有返回会话 ID"),
              },
            });
          }
          return;
        }
        const sessionUsage = contextUsageFromResult(message.result);
        const modes = sessionModeState(message.result);
        if (isCurrent) {
          set({
            acpPhase: "ready",
            acpSessionId: sessionId,
            chatStatus: "ready",
            ...(sessionUsage ? { contextUsage: sessionUsage } : {}),
            ...(modes
              ? {
                  availableSessionModes: modes.availableSessionModes,
                  selectedSessionModeId: modes.selectedSessionModeId,
                  pendingSessionModeId: undefined,
                }
              : {}),
          });
        }
        loadFallbackTimelines.delete(pendingOpen.localSessionId);
        if (!pendingOpen.requestedSessionId) {
          const updated = await updateStoredSession({
            id: pendingOpen.localSessionId,
            acpSessionId: sessionId,
          });
          useWorkspaceStore.getState().replaceSession(updated);
        }
        return;
      }

      if (
        message.method === "x.ai/exit_plan_mode" &&
        message.id !== undefined
      ) {
        const params = message.params ?? {};
        const sessionId = stringValue(params.sessionId);
        markPromptActivity(sessionId ?? get().acpSessionId);
        const toolCallId =
          stringValue(params.toolCallId) ?? `exit-plan-${String(message.id)}`;
        const content =
          stringValue(params.planContent)?.trim() ||
          "Melody 没有返回计划内容。";
        const request = {
          content,
          requestId: message.id,
          toolCallId,
        };
        const currentSessionId = get().acpSessionId;

        if (sessionId && currentSessionId && sessionId !== currentSessionId) {
          set((state) => ({
            backgroundTimelines: {
              ...state.backgroundTimelines,
              [sessionId]: upsertPlanApproval(
                state.backgroundTimelines[sessionId] ?? [],
                request,
              ),
            },
          }));
        } else {
          set((state) => ({
            timeline: upsertPlanApproval(state.timeline, request),
          }));
        }
        return;
      }

      if (
        typeof message.id === "number" &&
        message.id >= 100 &&
        !message.method
      ) {
        const promptId = message.id;
        const pendingPrompt = pendingPrompts.get(promptId);
        const responsePromptId = stringValue(responseMeta(message)?.promptId);
        if (responsePromptId && cancelledPromptIds.has(responsePromptId)) {
          return;
        }
        if (!pendingPrompt) {
          return;
        }
        const promptError = message.error
          ? errorMessage(message, "Melody 请求失败")
          : undefined;
        const promptResponse = promptResponseDisposition(
          Boolean(message.error),
          pendingPrompt.responseReceivedAt !== undefined,
        );
        if (promptResponse === "duplicate") {
          return;
        }
        const promptSessionId = pendingPrompt?.acpSessionId;
        const currentAcpSessionId = get().acpSessionId;
        const isBackgroundPrompt =
          Boolean(promptSessionId) &&
          Boolean(currentAcpSessionId) &&
          promptSessionId !== currentAcpSessionId;
        const promptUsage = contextUsageFromResult(
          message.result,
          isBackgroundPrompt && promptSessionId
            ? get().backgroundContextUsage[promptSessionId]
            : get().contextUsage,
        );

        // 后台会话的 prompt 响应只更新缓冲上下文，不污染当前会话状态。
        if (isBackgroundPrompt && promptSessionId) {
          if (promptResponse === "accepted") {
            pendingPrompts.set(
              promptId,
              markPromptResponseReceived(pendingPrompt, Date.now()),
            );
            if (promptUsage) {
              set((state) => ({
                backgroundContextUsage: {
                  ...state.backgroundContextUsage,
                  [promptSessionId]: promptUsage,
                },
              }));
            }
            return;
          }

          removePendingPrompt(promptId);
          set((state) => ({
            runningSessions: pendingPrompt
              ? {
                  ...state.runningSessions,
                  [pendingPrompt.localSessionId]: false,
                }
              : state.runningSessions,
            backgroundTimelines: {
              ...state.backgroundTimelines,
              [promptSessionId]: appendSessionError(
                state.backgroundTimelines[promptSessionId] ?? [],
                promptError ?? "Melody 请求失败",
              ),
            },
          }));
          return;
        }

        if (promptResponse === "accepted") {
          pendingPrompts.set(
            promptId,
            markPromptResponseReceived(pendingPrompt, Date.now()),
          );
          if (promptUsage) {
            set({ contextUsage: promptUsage });
          }
          return;
        }

        removePendingPrompt(promptId);
        set((state) => ({
          runningSessions: pendingPrompt
            ? {
                ...state.runningSessions,
                [pendingPrompt.localSessionId]: false,
              }
            : state.runningSessions,
          acpPhase: "error",
          chatStatus: "error",
          status: promptError
            ? { ...state.status, message: promptError }
            : state.status,
          timeline: appendSessionError(
            state.timeline,
            promptError ?? "Melody 请求失败",
          ),
        }));
        return;
      }

      if (
        message.method === "session/request_permission" &&
        message.id !== undefined
      ) {
        const params = message.params ?? {};
        markPromptActivity(stringValue(params.sessionId) ?? get().acpSessionId);
        const tool = objectValue(params.toolCall) ?? {};
        const options = parsePermissionOptions(params.options);

        const permissionProjection = projectPermissionRequest(
          get().timeline,
          tool,
          message.id,
          options,
        );
        set({ timeline: permissionProjection.timeline });

        const projectId = useWorkspaceStore.getState().activeProject?.id;
        const { title, command, toolCallId } = permissionProjection;
        if (projectId) {
          const rule = await findPermissionRule(
            projectId,
            permissionToolKey(title, command),
          );
          const option = rule
            ? options.find((item) =>
                rule.decision === "deny"
                  ? item.kind.startsWith("reject")
                  : item.kind.startsWith("allow"),
              )
            : undefined;
          if (rule && option) {
            set((state) => ({
              timeline: state.timeline.map((entry) =>
                entry.kind === "tool" && entry.toolCallId === toolCallId
                  ? {
                      ...entry,
                      permission:
                        rule.decision === "deny" ? "denied" : "allowed",
                    }
                  : entry,
              ),
            }));
            await sendAcp({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                outcome: {
                  outcome: "selected",
                  optionId: option.optionId,
                },
              },
            });
          }
        }
        return;
      }

      if (!isSessionUpdateMethod(message.method)) {
        return;
      }

      const updateParams = extractSessionUpdateParams(message);
      const update = objectValue(updateParams?.update);
      const messageSessionId = updateParams
        ? stringValue(updateParams.sessionId)
        : undefined;
      const currentAcpSessionId = get().acpSessionId;
      const routedSessionId = messageSessionId ?? currentAcpSessionId;
      if (!routedSessionId) {
        return;
      }
      const metadata = notificationMetadata(updateParams);
      if (metadata.promptId && cancelledPromptIds.has(metadata.promptId)) {
        return;
      }
      markPromptActivity(routedSessionId);
      let startsFullReplay = false;
      if (metadata.isReplay && !fullReplayStarted.has(routedSessionId)) {
        fullReplayStarted.add(routedSessionId);
        sessionEventDeduplicator.reset(routedSessionId);
        startsFullReplay = true;
      }
      if (!sessionEventDeduplicator.accept(routedSessionId, metadata.eventId)) {
        return;
      }
      const updateType = stringValue(update?.sessionUpdate);
      const echoBlocks = pendingUserEchoBlocks.get(routedSessionId) ?? 0;
      const skipUserEcho =
        updateType === "user_message_chunk" &&
        !metadata.isReplay &&
        echoBlocks > 0;
      if (skipUserEcho) {
        if (echoBlocks === 1) {
          pendingUserEchoBlocks.delete(routedSessionId);
        } else {
          pendingUserEchoBlocks.set(routedSessionId, echoBlocks - 1);
        }
      }
      set((state) => {
        const nextSubagents = applySubagentUpdate(
          state.subagents,
          update,
          routedSessionId,
          startsFullReplay,
        );
        return nextSubagents === state.subagents
          ? state
          : { subagents: nextSubagents };
      });

      // 后台会话的 update：缓冲到 backgroundTimelines，不污染当前会话。
      if (
        messageSessionId &&
        currentAcpSessionId &&
        messageSessionId !== currentAcpSessionId
      ) {
        const buffered = startsFullReplay
          ? []
          : (get().backgroundTimelines[messageSessionId] ?? []);
        const result: SessionUpdateResult = skipUserEcho
          ? { timeline: buffered }
          : applySessionUpdate(buffered, update, metadata.eventId);
        if (result.completed) {
          const pending = metadata.promptId
            ? [...pendingPrompts.entries()].find(
                ([, value]) => value.promptId === metadata.promptId,
              )
            : pendingPromptForSession(messageSessionId);
          if (pending) {
            removePendingPrompt(pending[0]);
          }
        }
        set((state) => ({
          backgroundTimelines: {
            ...state.backgroundTimelines,
            [messageSessionId]: result.timeline,
          },
          backgroundCursors: metadata.eventId
            ? {
                ...state.backgroundCursors,
                [messageSessionId]: metadata.eventId,
              }
            : state.backgroundCursors,
          backgroundContextUsage: result.contextUsage
            ? {
                ...state.backgroundContextUsage,
                [messageSessionId]: result.contextUsage,
              }
            : state.backgroundContextUsage,
        }));
        return;
      }

      // 当前会话的 update：正常处理。
      const currentTimeline = startsFullReplay ? [] : get().timeline;
      const authoritativeSessionModeId = sessionModeIdFromUpdate(update);
      const result: SessionUpdateResult = skipUserEcho
        ? { timeline: currentTimeline }
        : applySessionUpdate(currentTimeline, update, metadata.eventId);
      if (result.completed) {
        const pending = metadata.promptId
          ? [...pendingPrompts.entries()].find(
              ([, value]) => value.promptId === metadata.promptId,
            )
          : pendingPromptForSession(routedSessionId);
        if (pending) {
          removePendingPrompt(pending[0]);
        }
      }
      set((state) => ({
        timeline: result.timeline,
        ...(metadata.eventId ? { acpCursor: metadata.eventId } : {}),
        ...(result.streaming ? { chatStatus: "streaming" as const } : {}),
        ...(result.completed
          ? {
              acpPhase: result.error ? ("error" as const) : ("ready" as const),
              chatStatus: result.error
                ? ("error" as const)
                : ("ready" as const),
              runningSessions: state.localSessionId
                ? { ...state.runningSessions, [state.localSessionId]: false }
                : state.runningSessions,
            }
          : {}),
        ...(result.error
          ? {
              acpPhase: "error" as const,
              chatStatus: "error" as const,
              status: { ...state.status, message: result.error },
            }
          : {}),
        ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
        ...(authoritativeSessionModeId
          ? {
              selectedSessionModeId: authoritativeSessionModeId,
              pendingSessionModeId: undefined,
            }
          : {}),
      }));
    } catch (reason) {
      const detail = reasonMessage(reason);
      clearTransientState();
      set((state) => ({
        acpPhase: "error",
        chatStatus: "error",
        runningSessions: state.localSessionId
          ? { ...state.runningSessions, [state.localSessionId]: false }
          : state.runningSessions,
        status: {
          ...state.status,
          message: `ACP 事件处理失败：${detail}`,
        },
      }));
    }
  },
  submitPrompt: async (content, attachments = []) => {
    const trimmed = content.trim();
    if (!trimmed && attachments.length === 0) {
      return;
    }

    let prompt: Record<string, unknown>[];
    try {
      prompt = [
        ...(trimmed ? [{ type: "text", text: trimmed }] : []),
        ...attachmentPromptBlocks(attachments),
      ];
    } catch (reason) {
      set((state) => ({
        chatStatus: "error",
        status: { ...state.status, message: reasonMessage(reason) },
      }));
      throw reason;
    }

    const attachmentNames = attachments
      .map((attachment) => attachment.filename)
      .filter(Boolean)
      .join(", ");
    const timelineContent =
      trimmed ||
      (attachmentNames
        ? `已附加：${attachmentNames}`
        : `已附加 ${attachments.length} 个文件`);
    const stateBeforeSubmit = get();
    const localSessionId = stateBeforeSubmit.localSessionId;

    if (stateBeforeSubmit.chatStatus !== "ready") {
      const sessionId = stateBeforeSubmit.acpSessionId;
      if (!sessionId || !localSessionId) {
        return;
      }
      const sendNow =
        useAppSettingsStore.getState().followUpBehavior === "steer";
      set((state) => ({
        timeline: [
          ...state.timeline,
          {
            id: `user-follow-up-${Date.now()}`,
            kind: "message",
            role: "user",
            content: timelineContent,
            startedAt: Date.now(),
            attachments:
              attachments.length > 0
                ? timelineAttachments(attachments)
                : undefined,
          },
        ],
      }));
      if (!isTauriRuntime()) {
        return;
      }
      pendingUserEchoBlocks.set(
        sessionId,
        (pendingUserEchoBlocks.get(sessionId) ?? 0) + prompt.length,
      );
      try {
        await sendAcp({
          jsonrpc: "2.0",
          method: "x.ai/queue/interject",
          params: {
            sessionId,
            prompt,
            sendNow,
          },
        });
      } catch (reason) {
        pendingUserEchoBlocks.delete(sessionId);
        set((state) => ({
          status: { ...state.status, message: reasonMessage(reason) },
        }));
        throw reason;
      }
      return;
    }

    set((state) => ({
      chatStatus: "submitted",
      runningSessions: localSessionId
        ? {
            ...state.runningSessions,
            [localSessionId]: true,
          }
        : state.runningSessions,
      timeline: [
        ...state.timeline,
        {
          id: `user-${Date.now()}`,
          kind: "message",
          role: "user",
          content: timelineContent,
          startedAt: Date.now(),
          attachments:
            attachments.length > 0
              ? timelineAttachments(attachments)
              : undefined,
        },
      ],
    }));

    if (!isTauriRuntime()) {
      const sessionId = get().acpSessionId;
      if (!sessionId || !localSessionId) {
        set((state) => ({
          acpPhase: "error",
          chatStatus: "error",
          status: {
            ...state.status,
            message: "预览 ACP 会话尚未就绪，请重新打开会话。",
          },
        }));
        return;
      }
      const id = nextPromptRequestId++;
      const promptId = `melody-work-${localSessionId}-${id}`;
      pendingPrompts.set(id, {
        acpSessionId: sessionId,
        localSessionId,
        promptId,
        createdAt: Date.now(),
      });
      set({ acpPhase: "prompting" });
      try {
        await sendAcp({
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId, prompt, _meta: { promptId } },
        });
        if (pendingPrompts.has(id)) {
          armPromptFirstEventTimeout(id);
        }
      } catch (reason) {
        removePendingPrompt(id);
        set((state) => ({
          acpPhase: "error",
          chatStatus: "error",
          runningSessions: {
            ...state.runningSessions,
            [localSessionId]: false,
          },
          status: { ...state.status, message: reasonMessage(reason) },
        }));
      }
      return;
    }

    const sessionId = get().acpSessionId;
    if (!sessionId) {
      set((state) => ({
        chatStatus: "error",
        acpPhase: "error",
        runningSessions: localSessionId
          ? {
              ...state.runningSessions,
              [localSessionId]: false,
            }
          : state.runningSessions,
        status: {
          ...state.status,
          message: "Melody 会话尚未就绪，请重新打开会话后重试。",
        },
      }));
      return;
    }
    if (!localSessionId) {
      return;
    }
    const id = nextPromptRequestId++;
    const promptId = `melody-work-${localSessionId}-${id}`;
    pendingPrompts.set(id, {
      acpSessionId: sessionId,
      localSessionId,
      promptId,
      createdAt: Date.now(),
    });
    pendingUserEchoBlocks.set(sessionId, prompt.length);
    set({ acpPhase: "prompting" });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: {
          sessionId,
          prompt,
          _meta: { promptId },
        },
      });
      if (pendingPrompts.has(id)) {
        armPromptFirstEventTimeout(id);
      }
    } catch (reason) {
      removePendingPrompt(id);
      set((state) => ({
        acpPhase: "error",
        chatStatus: "error",
        runningSessions: {
          ...state.runningSessions,
          [localSessionId]: false,
        },
        status: { ...state.status, message: reasonMessage(reason) },
      }));
      throw reason;
    }
  },
  cancelPrompt: async (reason = "user") => {
    const stateBeforeCancel = get();
    const localSessionId = stateBeforeCancel.localSessionId;
    const sessionId = stateBeforeCancel.acpSessionId;
    const pending = sessionId ? pendingPromptForSession(sessionId) : undefined;
    if (
      stateBeforeCancel.chatStatus !== "submitted" &&
      stateBeforeCancel.chatStatus !== "streaming" &&
      !pending
    ) {
      return;
    }

    const pendingRequestId = pending?.[0];
    const pendingPrompt = pending?.[1];
    if (pendingRequestId !== undefined) {
      removePendingPrompt(pendingRequestId);
      if (pendingPrompt) {
        rememberCancelledPrompt(pendingPrompt.promptId);
      }
    }

    const timeoutMessage =
      "发送请求后 30 秒内未收到任何 ACP 进展事件，已自动停止。";
    try {
      if (sessionId && isTauriRuntime()) {
        await sendAcp({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId,
            _meta: {
              ...(pendingPrompt
                ? { cancelPromptId: pendingPrompt.promptId }
                : {}),
              cancelSubagents: true,
              cancelTrigger: reason === "timeout" ? "timeout" : "mouse",
            },
          },
        });
      }
      set((state) => ({
        acpPhase: "ready",
        chatStatus: "ready",
        timeline:
          reason === "timeout"
            ? appendSessionError(state.timeline, timeoutMessage)
            : settleSessionProjection(state.timeline),
        runningSessions: localSessionId
          ? { ...state.runningSessions, [localSessionId]: false }
          : state.runningSessions,
        ...(reason === "timeout"
          ? { status: { ...state.status, message: timeoutMessage } }
          : {}),
      }));
    } catch (cancelError) {
      const detail = reasonMessage(cancelError);
      set((state) => ({
        acpPhase: "error",
        chatStatus: "error",
        timeline: appendSessionError(
          state.timeline,
          `取消当前请求失败：${detail}`,
        ),
        runningSessions: localSessionId
          ? { ...state.runningSessions, [localSessionId]: false }
          : state.runningSessions,
        status: { ...state.status, message: detail },
      }));
    }
  },
  selectModel: async (modelId) => {
    const state = get();
    if (!modelId || modelId === state.selectedModelId || state.pendingModelId) {
      return;
    }
    if (!isTauriRuntime()) {
      const selectedModel = state.availableModels.find(
        (model) => model.id === modelId,
      );
      set({
        selectedModelId: modelId,
        selectedReasoningEffort: selectedModel?.reasoningEffort,
        contextUsage: contextUsageForModel(state.availableModels, modelId),
      });
      return;
    }
    if (!state.acpSessionId) {
      set({
        selectedModelId: modelId,
        contextUsage: contextUsageForModel(state.availableModels, modelId),
        status: {
          ...state.status,
          message: "所选模型将在下一个会话中使用。",
        },
      });
      return;
    }
    set({ pendingModelId: modelId });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: SET_MODEL_REQUEST_ID,
        method: "session/set_model",
        params: {
          sessionId: state.acpSessionId,
          modelId,
        },
      });
    } catch (reason) {
      set({
        pendingModelId: undefined,
        acpPhase: "error",
        chatStatus: "error",
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
  },
  selectReasoningEffort: async (effort) => {
    const state = get();
    if (
      !effort ||
      effort === state.selectedReasoningEffort ||
      state.pendingReasoningEffort ||
      !state.selectedModelId
    ) {
      return;
    }
    if (!isTauriRuntime() || !state.acpSessionId) {
      set({ selectedReasoningEffort: effort });
      return;
    }
    set({ pendingReasoningEffort: effort });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: SET_REASONING_EFFORT_REQUEST_ID,
        method: "session/set_model",
        params: {
          sessionId: state.acpSessionId,
          modelId: state.selectedModelId,
          _meta: { reasoningEffort: effort },
        },
      });
    } catch (reason) {
      set({
        pendingReasoningEffort: undefined,
        acpPhase: "error",
        chatStatus: "error",
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
  },
  selectSessionMode: async (modeId) => {
    const state = get();
    if (
      !modeId ||
      modeId === state.selectedSessionModeId ||
      state.pendingSessionModeId
    ) {
      return;
    }
    if (!isTauriRuntime() || !state.acpSessionId) {
      set({ selectedSessionModeId: modeId });
      return;
    }
    set({ pendingSessionModeId: modeId });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: SET_SESSION_MODE_REQUEST_ID,
        method: "session/set_mode",
        params: {
          sessionId: state.acpSessionId,
          modeId,
        },
      });
    } catch (reason) {
      set({
        pendingSessionModeId: undefined,
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
  },
  selectPermissionMode: async (mode) => {
    const state = get();
    if (mode === state.permissionMode) {
      return;
    }
    set({ permissionMode: mode });
    if (!isTauriRuntime() || !state.acpSessionId) {
      return;
    }
    try {
      await sendAcp({
        jsonrpc: "2.0",
        method: "x.ai/yolo_mode_changed",
        params: {
          clientIdentifier: "melody-work",
          permission_mode: mode,
          yolo_mode: mode === "always-approve",
          auto_mode: mode === "auto",
        },
      });
    } catch (reason) {
      set({
        permissionMode: state.permissionMode,
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
  },
  resolvePlan: async (entryId, outcome, feedback) => {
    const entry = get().timeline.find((item) => item.id === entryId);
    if (
      entry?.kind !== "plan" ||
      entry.status !== "awaiting-approval" ||
      entry.requestId === undefined
    ) {
      return;
    }
    const normalizedFeedback = feedback?.trim();
    if (outcome === "cancelled" && !normalizedFeedback) {
      return;
    }
    const settledStatus =
      outcome === "approved"
        ? "approved"
        : outcome === "abandoned"
          ? "abandoned"
          : "changes-requested";
    set((state) => ({
      timeline: settlePlanApproval(state.timeline, entryId, settledStatus),
    }));

    if (!isTauriRuntime()) {
      return;
    }
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: entry.requestId,
        result: {
          outcome,
          ...(normalizedFeedback ? { feedback: normalizedFeedback } : {}),
        },
      });
    } catch (reason) {
      set((state) => ({
        timeline: state.timeline.map((item) =>
          item.kind === "plan" && item.id === entryId
            ? {
                ...item,
                requestId: entry.requestId,
                status: "awaiting-approval",
              }
            : item,
        ),
        status: {
          ...state.status,
          message: reasonMessage(reason),
        },
      }));
      throw reason;
    }
  },
  resolvePermission: async (entryId, optionId) => {
    const entry = get().timeline.find((item) => item.id === entryId);
    if (entry?.kind !== "tool" || entry.permissionRequestId === undefined) {
      return;
    }
    const projectDecision = optionId.startsWith("project:")
      ? (optionId.slice("project:".length) as "allow" | "deny")
      : undefined;
    const option = projectDecision
      ? entry.permissionOptions?.find((item) =>
          projectDecision === "deny"
            ? item.kind.startsWith("reject")
            : item.kind.startsWith("allow"),
        )
      : entry.permissionOptions?.find((item) => item.optionId === optionId);
    if (!option) {
      return;
    }
    const permission = option?.kind.startsWith("reject") ? "denied" : "allowed";

    if (projectDecision) {
      const projectId = useWorkspaceStore.getState().activeProject?.id;
      if (projectId) {
        await upsertPermissionRule({
          projectId,
          toolKey: permissionToolKey(entry.title, entry.command),
          title: entry.title,
          command: entry.command,
          decision: projectDecision,
        });
      }
    }

    set((state) => ({
      timeline: state.timeline.map((item) =>
        item.id === entryId ? { ...item, permission } : item,
      ),
    }));

    if (!isTauriRuntime()) {
      return;
    }
    await sendAcp({
      jsonrpc: "2.0",
      id: entry.permissionRequestId,
      result: {
        outcome: {
          outcome: "selected",
          optionId: option.optionId,
        },
      },
    });
  },
  resolveQuestion: async (entryId, response) => {
    const state = get();
    let entry = state.timeline.find((item) => item.id === entryId);
    let backgroundSessionId: string | undefined;
    if (!entry) {
      for (const [sessionId, timeline] of Object.entries(
        state.backgroundTimelines,
      )) {
        const candidate = timeline.find((item) => item.id === entryId);
        if (candidate) {
          entry = candidate;
          backgroundSessionId = sessionId;
          break;
        }
      }
    }
    if (
      entry?.kind !== "tool" ||
      !entry.question ||
      entry.question.outcome !== "pending"
    ) {
      return;
    }
    const requestId = entry.question.requestId;
    const wireResponse =
      response.outcome === "chat_about_this" ||
      response.outcome === "skip_interview"
        ? {
            outcome: response.outcome,
            partial_answers: response.partialAnswers,
          }
        : response;
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: requestId,
        result: wireResponse,
      });
    } catch (reason) {
      set({
        status: { ...get().status, message: reasonMessage(reason) },
      });
      throw reason;
    }
    set((current) =>
      backgroundSessionId
        ? {
            backgroundTimelines: {
              ...current.backgroundTimelines,
              [backgroundSessionId]: updateQuestionEntry(
                current.backgroundTimelines[backgroundSessionId] ?? [],
                entryId,
                response,
              ),
            },
          }
        : {
            timeline: updateQuestionEntry(current.timeline, entryId, response),
          },
    );
  },
}));
