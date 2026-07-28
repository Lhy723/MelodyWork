import { create } from "zustand";

import type {
  AcpEnvelope,
  AcpSessionPhase,
  AgentContextUsage,
  AgentModelOption,
  AgentPlanDecision,
  AgentPermissionMode,
  AgentPromptAttachment,
  AgentReasoningEffortOption,
  AgentSessionModeOption,
  AgentStatus,
  AgentTimelineAttachment,
  PermissionOption,
  TimelineEntry,
} from "@/domain/acp";
import {
  settlePlanApproval,
  upsertPlanApproval,
} from "@/domain/plan-approval";
import {
  notificationMetadata,
  parseTimelineProjection,
  SessionEventDeduplicator,
  TIMELINE_PROJECTION_VERSION,
  usableTimelineProjection,
} from "@/domain/session-projection";
import {
  sessionModeIdFromUpdate,
  sessionModeState,
} from "@/domain/session-mode";
import { extractToolActivity } from "@/domain/tool-activity";
import {
  findPermissionRule,
  isTauriRuntime,
  sendAcp,
  updateStoredSession,
  upsertPermissionRule,
} from "@/lib/melody-bridge";
import { useWorkspaceStore } from "@/stores/workspace-store";

const INITIALIZE_REQUEST_ID = 1;
const AUTHENTICATE_REQUEST_ID = 2;
const SET_MODEL_REQUEST_ID = 4;
const SET_REASONING_EFFORT_REQUEST_ID = 5;
const SET_SESSION_MODE_REQUEST_ID = 6;
const SETUP_TIMEOUT_MS = 20_000;
let nextPromptRequestId = 100;
let nextSessionOpenRequestId = -1;
const sessionEventDeduplicator = new SessionEventDeduplicator();
const fullReplayStarted = new Set<string>();
const loadFallbackTimelines = new Map<string, TimelineEntry[]>();
const pendingUserEchoBlocks = new Map<string, number>();
const pendingSessionOpens = new Map<
  number,
  { localSessionId: string; requestedSessionId?: string }
>();

// prompt 请求 ID → 前后端会话映射，用于路由后台响应和运行状态。
const pendingPrompts = new Map<
  number,
  { acpSessionId: string; localSessionId: string }
>();

const previewTimeline: TimelineEntry[] = [
  {
    id: "user-1",
    kind: "message",
    role: "user",
    content:
      "通过 ACP stdio 将 MelodyWork 连接到内置 Melody Build 智能体。",
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
  ) => Promise<void>;
  receiveAcp: (message: AcpEnvelope) => Promise<void>;
  submitPrompt: (
    content: string,
    attachments?: AgentPromptAttachment[],
  ) => Promise<void>;
  selectModel: (modelId: string) => Promise<void>;
  selectReasoningEffort: (effort: string) => Promise<void>;
  selectSessionMode: (modeId: string) => Promise<void>;
  selectPermissionMode: (mode: AgentPermissionMode) => Promise<void>;
  resolvePermission: (entryId: string, optionId: string) => Promise<void>;
  resolvePlan: (
    entryId: string,
    outcome: AgentPlanDecision,
    feedback?: string,
  ) => Promise<void>;
}

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

const stringifyValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value, null, 2);
};

const toolCommand = (tool: Record<string, unknown>): string => {
  const rawInput = objectValue(tool.rawInput);
  return (
    stringValue(rawInput?.command) ??
    stringValue(rawInput?.cmd) ??
    stringValue(rawInput?.path) ??
    stringifyValue(tool.rawInput)
  );
};

const toolOutput = (tool: Record<string, unknown>): string => {
  const content = Array.isArray(tool.content) ? tool.content : [];
  const contentText = content
    .map((item) => {
      const block = objectValue(item);
      return (
        stringValue(block?.text) ??
        stringifyValue(block?.content) ??
        stringifyValue(item)
      );
    })
    .filter(Boolean)
    .join("\n");
  return contentText || stringifyValue(tool.rawOutput);
};

const permissionToolKey = (title: string, command: string) =>
  `${title.trim()}\n${command.trim()}`;

const appendAgentChunk = (
  timeline: TimelineEntry[],
  text: string,
): TimelineEntry[] => {
  const now = Date.now();
  const settledTimeline = timeline.map((entry) =>
    entry.kind === "thought" && entry.streaming
      ? { ...entry, completedAt: entry.completedAt ?? now, streaming: false }
      : entry,
  );
  const last = settledTimeline.at(-1);
  if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
    return [
      ...settledTimeline.slice(0, -1),
      { ...last, content: `${last.content}${text}` },
    ];
  }
  return [
    ...settledTimeline,
    {
      id: `assistant-${Date.now()}`,
      kind: "message",
      role: "assistant",
      content: text,
      startedAt: now,
      streaming: true,
    },
  ];
};

const appendThoughtChunk = (
  timeline: TimelineEntry[],
  text: string,
): TimelineEntry[] => {
  const now = Date.now();
  const last = timeline.at(-1);
  if (last?.kind === "thought" && last.streaming) {
    return [
      ...timeline.slice(0, -1),
      { ...last, content: `${last.content}${text}` },
    ];
  }
  return [
    ...timeline.map((entry) =>
      entry.kind === "message" && entry.streaming
        ? { ...entry, completedAt: entry.completedAt ?? now, streaming: false }
        : entry,
    ),
    {
      id: `thought-${now}`,
      kind: "thought",
      content: text,
      startedAt: now,
      streaming: true,
    },
  ];
};

const settleStreamingEntries = (timeline: TimelineEntry[]): TimelineEntry[] => {
  const now = Date.now();
  return timeline.map((entry) =>
    (entry.kind === "message" || entry.kind === "thought") && entry.streaming
      ? { ...entry, completedAt: entry.completedAt ?? now, streaming: false }
      : entry,
  );
};

const appendUserChunk = (
  timeline: TimelineEntry[],
  update: Record<string, unknown>,
  eventId?: string,
): TimelineEntry[] => {
  const content = objectValue(update.content);
  const contentMeta = objectValue(content?._meta);
  const chunkMeta = objectValue(update._meta);
  if (chunkMeta?.hideFromScrollback === true) {
    return timeline;
  }
  const text =
    stringValue(contentMeta?.displayText) ??
    stringValue(content?.text);
  if (!text) {
    return timeline;
  }
  const promptIndex = numberValue(chunkMeta?.promptIndex);
  const settled = settleStreamingEntries(timeline);
  const last = settled.at(-1);
  if (
    last?.kind === "message" &&
    last.role === "user" &&
    last.content === text
  ) {
    return [
      ...settled.slice(0, -1),
      { ...last, sourcePromptIndex: promptIndex },
    ];
  }
  if (
    last?.kind === "message" &&
    last.role === "user" &&
    promptIndex !== undefined &&
    last.sourcePromptIndex === promptIndex
  ) {
    return [
      ...settled.slice(0, -1),
      {
        ...last,
        content: `${last.content}\n${text}`,
        streaming: true,
      },
    ];
  }
  return [
    ...settled,
    {
      id: eventId ? `user-${eventId}` : `user-${Date.now()}`,
      kind: "message",
      role: "user",
      content: text,
      startedAt: Date.now(),
      streaming: true,
      sourcePromptIndex: promptIndex,
    },
  ];
};

const appendAgentError = (
  timeline: TimelineEntry[],
  message: string,
): TimelineEntry[] => {
  const now = Date.now();
  const content = `Melody 无法完成请求：${message}`;
  const last = timeline.at(-1);
  if (
    last?.kind === "message" &&
    last.role === "assistant" &&
    last.content === content
  ) {
    return timeline;
  }
  return [
    ...settleStreamingEntries(timeline),
    {
      id: `assistant-error-${now}`,
      kind: "message",
      role: "assistant",
      content,
      completedAt: now,
      startedAt: now,
    },
  ];
};

const upsertTool = (
  timeline: TimelineEntry[],
  tool: Record<string, unknown>,
): TimelineEntry[] => {
  const toolCallId =
    stringValue(tool.toolCallId) ?? `tool-${Date.now().toString(36)}`;
  const index = timeline.findIndex(
    (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
  );
  const existing = index >= 0 ? timeline[index] : undefined;
  const status =
    stringValue(tool.status) ??
    (existing?.kind === "tool" ? existing.status : undefined);
  const completed =
    status === "completed" ||
    status === "failed" ||
    (existing?.kind === "tool" && existing.permission === "denied");
  const next: TimelineEntry = {
    id: existing?.id ?? `tool-${toolCallId}`,
    kind: "tool",
    toolCallId,
    title:
      stringValue(tool.title) ??
      (existing?.kind === "tool" ? existing.title : "工具调用"),
    command:
      toolCommand(tool) ||
      (existing?.kind === "tool" ? existing.command : ""),
    output:
      toolOutput(tool) ||
      (existing?.kind === "tool" ? existing.output : ""),
    startedAt:
      existing?.kind === "tool" ? existing.startedAt : Date.now(),
    completedAt:
      existing?.kind === "tool" && existing.completedAt
        ? existing.completedAt
        : completed
          ? Date.now()
          : undefined,
    activity: extractToolActivity(
      tool,
      existing?.kind === "tool" ? existing.activity : undefined,
    ),
    status,
    permission:
      existing?.kind === "tool" ? existing.permission : undefined,
    permissionRequestId:
      existing?.kind === "tool" ? existing.permissionRequestId : undefined,
    permissionOptions:
      existing?.kind === "tool" ? existing.permissionOptions : undefined,
  };

  if (index < 0) {
    return [...timeline, next];
  }
  return timeline.map((entry, entryIndex) =>
    entryIndex === index ? next : entry,
  );
};

const parsePermissionOptions = (value: unknown): PermissionOption[] =>
  Array.isArray(value)
    ? value.flatMap((option) => {
        const item = objectValue(option);
        const optionId = stringValue(item?.optionId);
        const name = stringValue(item?.name);
        const kind = stringValue(item?.kind) as PermissionOption["kind"];
        return optionId && name && kind
          ? [{ optionId, name, kind }]
          : [];
      })
    : [];

const errorMessage = (message: AcpEnvelope, fallback: string) =>
  stringValue(objectValue(message.error?.data)?.message) ??
  message.error?.message ??
  fallback;

const reasonMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

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
      throw new Error(
        `无法读取附件 ${attachment.filename ?? "文件"}。`,
      );
    }

    const mediaType = attachment.mediaType || parsed.mediaType;
    if (mediaType.startsWith("image/")) {
      if (!parsed.base64) {
        throw new Error(
          `无法编码图片 ${attachment.filename ?? "附件"}。`,
        );
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
        const meta =
          objectValue(model?._meta) ?? objectValue(model?.meta);
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

const contextUsageValue = (
  value: Record<string, unknown> | undefined,
): AgentContextUsage | undefined => {
  const usedTokens = numberValue(value?.used);
  const maxTokens = numberValue(value?.size);
  if (
    usedTokens === undefined ||
    maxTokens === undefined ||
    usedTokens < 0 ||
    maxTokens <= 0
  ) {
    return undefined;
  }

  const rawCost = objectValue(value?.cost);
  const amount = numberValue(rawCost?.amount);
  const currency = stringValue(rawCost?.currency);
  const normalizedCurrency =
    currency && /^[a-z]{3}$/i.test(currency) ? currency.toUpperCase() : undefined;
  return {
    usedTokens,
    maxTokens,
    ...(amount !== undefined && amount >= 0 && normalizedCurrency
      ? { cost: { amount, currency: normalizedCurrency } }
      : {}),
  };
};

const contextUsageFromResult = (
  result: Record<string, unknown> | undefined,
  fallback?: AgentContextUsage,
): AgentContextUsage | undefined => {
  const directUsage = contextUsageValue(objectValue(result?.usage));
  if (directUsage) {
    return directUsage;
  }

  const meta = objectValue(result?._meta);
  const metadataUsage = contextUsageValue(
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
  const maxTokens = models.find((model) => model.id === modelId)
    ?.contextWindowTokens;
  if (maxTokens === undefined || maxTokens <= 0) {
    return current;
  }
  if (current?.maxTokens === maxTokens) {
    return current;
  }
  return { usedTokens: 0, maxTokens };
};

// 从 ACP 消息中提取 session update 的真实 params。
// session/update 是直连形式：params.sessionId / params.update
// _x.ai/session_notification 是包装形式：params.params.sessionId / params.params.update
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

// 将 session update 应用到指定 timeline，返回更新后的 timeline 和状态标志。
interface SessionUpdateResult {
  timeline: TimelineEntry[];
  error?: string;
  streaming?: boolean;
  contextUsage?: AgentContextUsage;
}
const applySessionUpdate = (
  timeline: TimelineEntry[],
  update: Record<string, unknown> | undefined,
  eventId?: string,
): SessionUpdateResult => {
  const updateType = stringValue(update?.sessionUpdate);

  if (updateType === "usage_update") {
    return {
      timeline,
      contextUsage: contextUsageValue(update),
    };
  }

  if (updateType === "user_message_chunk" && update) {
    return {
      timeline: appendUserChunk(timeline, update, eventId),
    };
  }

  if (updateType === "agent_message_chunk") {
    const content = objectValue(update?.content);
    const text = stringValue(content?.text);
    if (text) {
      return {
        timeline: appendAgentChunk(timeline, text),
        streaming: true,
      };
    }
    return { timeline };
  }

  if (updateType === "agent_thought_chunk") {
    const content = objectValue(update?.content);
    const text = stringValue(content?.text);
    if (text) {
      return {
        timeline: appendThoughtChunk(timeline, text),
        streaming: true,
      };
    }
    return { timeline };
  }

  if (
    updateType === "retry_state" &&
    stringValue(update?.type) === "failed"
  ) {
    const detail =
      stringValue(update?.message) ?? "模型请求失败。";
    return {
      timeline: appendAgentError(timeline, detail),
      error: detail,
    };
  }

  if (updateType === "turn_completed") {
    const stopReason =
      stringValue(update?.stopReason) ??
      stringValue(update?.stop_reason);
    const detail =
      stringValue(update?.agentResult) ??
      stringValue(update?.agent_result);
    if (stopReason === "error") {
      const failure = detail ?? "本轮 Melody 对话发生错误。";
      return {
        timeline: appendAgentError(timeline, failure),
        error: failure,
      };
    }
    return { timeline: settleStreamingEntries(timeline) };
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    return {
      timeline: upsertTool(settleStreamingEntries(timeline), update ?? {}),
    };
  }

  return { timeline };
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
  stderr: [],
  availableModels: [],
  availableSessionModes: [],
  permissionMode: "ask",
  runningSessions: {},
  chatStatus: "ready",
  setStatus: (status) =>
    set({
      status,
      ...(status.phase === "missing" || status.phase === "failed"
        ? { chatStatus: "error" as const, acpPhase: "error" as const }
        : {}),
    }),
  appendStderr: (line) =>
    set((state) => ({ stderr: [...state.stderr.slice(-49), line] })),
  beginSession: async (
    cwd,
    localSessionId,
    acpSessionId,
    timelineJson,
    acpCursor,
    timelineVersion,
  ) => {
    const fallbackTimeline = parseTimelineProjection(timelineJson);
    const restoredTimeline = usableTimelineProjection({
      timelineJson,
      cursor: acpCursor,
      version: timelineVersion,
    });
    const restoredCursor =
      timelineVersion === TIMELINE_PROJECTION_VERSION && acpCursor
        ? acpCursor
        : undefined;
    if (!isTauriRuntime()) {
      set({
        activeSessionId: localSessionId,
        localSessionId,
        cwd,
        acpSessionId,
        acpCursor: restoredCursor,
        acpPhase: "ready",
        timeline:
          localSessionId === "implement-acp-bridge" && restoredTimeline.length === 0
            ? previewTimeline
            : restoredTimeline,
        contextUsage: undefined,
        chatStatus: "ready",
      });
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
    const finalTimeline =
      restoredFromBuffer ?? restoredTimeline;
    const finalCursor = restoredFromBuffer && acpSessionId
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
        contextUsageForModel(
          state.availableModels,
          state.selectedModelId,
        ),
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
        armSetupTimeout(
          localSessionId,
          "creating",
          "打开 Melody 会话超时。",
        );
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
      const selectedModelId =
        models.selectedModelId ?? get().selectedModelId;
      set({
        availableModels: models.availableModels,
        selectedModelId,
        selectedReasoningEffort:
          models.selectedReasoningEffort ??
          get().selectedReasoningEffort,
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
        armSetupTimeout(
          localSessionId,
          "creating",
          "打开 Melody 会话超时。",
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
        armSetupTimeout(
          localSessionId,
          "creating",
          "打开 Melody 会话超时。",
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
        const detail = errorMessage(
          message,
          "更改推理强度失败",
        );
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
      const isCurrent =
        pendingOpen.localSessionId === get().localSessionId;
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
              message: errorMessage(
                message,
                "Melody 没有返回会话 ID",
              ),
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
      const toolCallId =
        stringValue(params.toolCallId) ??
        `exit-plan-${String(message.id)}`;
      const content =
        stringValue(params.planContent)?.trim() ||
        "Melody 没有返回计划内容。";
      const request = {
        content,
        requestId: message.id,
        toolCallId,
      };
      const currentSessionId = get().acpSessionId;

      if (
        sessionId &&
        currentSessionId &&
        sessionId !== currentSessionId
      ) {
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
      const promptSessionId = pendingPrompt?.acpSessionId;
      const currentAcpSessionId = get().acpSessionId;

      // 后台会话的 prompt 响应：更新缓冲 timeline 的 streaming 标记，
      // 不污染当前会话的 chatStatus / acpPhase。
      if (
        promptSessionId &&
        currentAcpSessionId &&
        promptSessionId !== currentAcpSessionId
      ) {
        pendingPrompts.delete(promptId);
        pendingUserEchoBlocks.delete(promptSessionId);
        const promptUsage = contextUsageFromResult(
          message.result,
          get().backgroundContextUsage[promptSessionId],
        );
        const promptError = message.error
          ? errorMessage(message, "Melody 请求失败")
          : undefined;
        set((state) => ({
          runningSessions: pendingPrompt
            ? {
                ...state.runningSessions,
                [pendingPrompt.localSessionId]: false,
              }
            : state.runningSessions,
          backgroundTimelines: {
            ...state.backgroundTimelines,
            [promptSessionId]: promptError
              ? appendAgentError(
                  state.backgroundTimelines[promptSessionId] ?? [],
                  promptError,
                )
              : settleStreamingEntries(
                  state.backgroundTimelines[promptSessionId] ?? [],
                ),
          },
          backgroundContextUsage: promptUsage
            ? {
                ...state.backgroundContextUsage,
                [promptSessionId]: promptUsage,
              }
            : state.backgroundContextUsage,
        }));
        return;
      }

      pendingPrompts.delete(promptId);
      if (promptSessionId) {
        pendingUserEchoBlocks.delete(promptSessionId);
      }
      const promptError = message.error
        ? errorMessage(message, "Melody 请求失败")
        : undefined;
      const promptUsage = contextUsageFromResult(
        message.result,
        get().contextUsage,
      );
      set((state) => ({
        runningSessions: pendingPrompt
          ? {
              ...state.runningSessions,
              [pendingPrompt.localSessionId]: false,
            }
          : state.runningSessions,
        acpPhase: message.error ? "error" : "ready",
        chatStatus: message.error ? "error" : "ready",
        status: promptError
          ? { ...state.status, message: promptError }
          : state.status,
        timeline: promptError
          ? appendAgentError(state.timeline, promptError)
          : settleStreamingEntries(state.timeline),
        ...(promptUsage ? { contextUsage: promptUsage } : {}),
      }));
      return;
    }

    if (message.method === "session/request_permission" && message.id !== undefined) {
      const params = message.params ?? {};
      const tool = objectValue(params.toolCall) ?? {};
      const toolCallId =
        stringValue(tool.toolCallId) ?? `permission-${String(message.id)}`;
      const options = parsePermissionOptions(params.options);

      set((state) => {
        const withTool = upsertTool(state.timeline, {
          ...tool,
          toolCallId,
        });
        return {
          timeline: withTool.map((entry) =>
            entry.kind === "tool" && entry.toolCallId === toolCallId
              ? {
                  ...entry,
                  permission: "pending",
                  permissionRequestId: message.id,
                  permissionOptions: options,
                }
              : entry,
          ),
        };
      });

      const projectId =
        useWorkspaceStore.getState().activeProject?.id;
      const title = stringValue(tool.title) ?? "工具调用";
      const command = toolCommand(tool);
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

    const isSessionUpdate =
      message.method === "session/update" ||
      message.method === "_x.ai/session_notification";
    if (!isSessionUpdate) {
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
    let startsFullReplay = false;
    if (metadata.isReplay && !fullReplayStarted.has(routedSessionId)) {
      fullReplayStarted.add(routedSessionId);
      sessionEventDeduplicator.reset(routedSessionId);
      startsFullReplay = true;
    }
    if (
      !sessionEventDeduplicator.accept(
        routedSessionId,
        metadata.eventId,
      )
    ) {
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
      : applySessionUpdate(
          currentTimeline,
          update,
          metadata.eventId,
        );
    set((state) => ({
      timeline: result.timeline,
      ...(metadata.eventId ? { acpCursor: metadata.eventId } : {}),
      ...(result.streaming
        ? { chatStatus: "streaming" as const }
        : {}),
      ...(result.error
        ? {
            acpPhase: "error" as const,
            chatStatus: "error" as const,
            status: { ...state.status, message: result.error },
          }
        : {}),
      ...(result.contextUsage
        ? { contextUsage: result.contextUsage }
        : {}),
      ...(authoritativeSessionModeId
        ? {
            selectedSessionModeId: authoritativeSessionModeId,
            pendingSessionModeId: undefined,
          }
        : {}),
    }));
  },
  submitPrompt: async (content, attachments = []) => {
    const trimmed = content.trim();
    if ((!trimmed && attachments.length === 0) || get().chatStatus !== "ready") {
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

    const localSessionId = get().localSessionId;
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
          attachments:
            attachments.length > 0
              ? timelineAttachments(attachments)
              : undefined,
        },
      ],
    }));

    if (!isTauriRuntime()) {
      window.setTimeout(() => {
        set((state) => ({
          chatStatus: "ready",
          runningSessions: localSessionId
            ? {
                ...state.runningSessions,
                [localSessionId]: false,
              }
            : state.runningSessions,
          timeline: [
            ...state.timeline,
            {
              id: `assistant-${Date.now()}`,
              kind: "message",
              role: "assistant",
              content:
                "浏览器预览使用相同的时间线渲染器；在桌面应用中，此请求会通过 ACP session/prompt 发送。",
            },
          ],
        }));
      }, 500);
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
    pendingPrompts.set(id, { acpSessionId: sessionId, localSessionId });
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
        },
      });
    } catch (reason) {
      pendingPrompts.delete(id);
      pendingUserEchoBlocks.delete(sessionId);
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
  selectModel: async (modelId) => {
    const state = get();
    if (
      !modelId ||
      modelId === state.selectedModelId ||
      state.pendingModelId
    ) {
      return;
    }
    if (!isTauriRuntime()) {
      const selectedModel = state.availableModels.find(
        (model) => model.id === modelId,
      );
      set({
        selectedModelId: modelId,
        selectedReasoningEffort: selectedModel?.reasoningEffort,
        contextUsage: contextUsageForModel(
          state.availableModels,
          modelId,
        ),
      });
      return;
    }
    if (!state.acpSessionId) {
      set({
        selectedModelId: modelId,
        contextUsage: contextUsageForModel(
          state.availableModels,
          modelId,
        ),
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
      timeline: settlePlanApproval(
        state.timeline,
        entryId,
        settledStatus,
      ),
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
          ...(normalizedFeedback
            ? { feedback: normalizedFeedback }
            : {}),
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
    if (
      entry?.kind !== "tool" ||
      entry.permissionRequestId === undefined
    ) {
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
    const permission =
      option?.kind.startsWith("reject") ? "denied" : "allowed";

    if (projectDecision) {
      const projectId =
        useWorkspaceStore.getState().activeProject?.id;
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
}));
