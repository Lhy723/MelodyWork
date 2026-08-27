import type {
  AgentBillingUsage,
  AgentContextUsage,
  JsonRpcId,
  PermissionOption,
  TimelineEntry,
} from "./acp.ts";
import { extractToolActivity } from "./tool-activity.ts";

type JsonObject = Record<string, unknown>;

export interface SessionUpdateResult {
  timeline: TimelineEntry[];
  error?: string;
  completed?: boolean;
  streaming?: boolean;
  contextUsage?: AgentContextUsage;
}

const objectValue = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object"
    ? (value as JsonObject)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

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

const toolCommand = (tool: JsonObject): string => {
  const rawInput = objectValue(tool.rawInput);
  return (
    stringValue(rawInput?.command) ??
    stringValue(rawInput?.cmd) ??
    stringValue(rawInput?.path) ??
    stringifyValue(tool.rawInput)
  );
};

const toolOutput = (tool: JsonObject): string => {
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

const appendAgentChunk = (
  timeline: TimelineEntry[],
  text: string,
): TimelineEntry[] => {
  const now = Date.now();
  const last = timeline.at(-1);
  if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
    return [
      ...timeline.slice(0, -1),
      { ...last, content: `${last.content}${text}` },
    ];
  }
  const settledTimeline = timeline.map((entry) =>
    entry.kind === "thought" && entry.streaming
      ? { ...entry, completedAt: entry.completedAt ?? now, streaming: false }
      : entry,
  );
  return [
    ...settledTimeline,
    {
      id: `assistant-${now}`,
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

export const settleSessionProjection = (
  timeline: TimelineEntry[],
): TimelineEntry[] => {
  const now = Date.now();
  return timeline.map((entry) =>
    (entry.kind === "message" || entry.kind === "thought") && entry.streaming
      ? { ...entry, completedAt: entry.completedAt ?? now, streaming: false }
      : entry,
  );
};

const stampLatestTurnAnalytics = (
  timeline: TimelineEntry[],
  usage: AgentContextUsage | undefined,
  billingUsage: AgentBillingUsage | undefined,
  reasoningEffort: string | undefined,
  sessionModeId: string | undefined,
): TimelineEntry[] => {
  const settled = settleSessionProjection(timeline);
  let lastUserIndex = -1;
  let assistantIndex = -1;
  for (let index = settled.length - 1; index >= 0; index -= 1) {
    const entry = settled[index];
    if (
      assistantIndex < 0 &&
      entry?.kind === "message" &&
      entry.role === "assistant"
    ) {
      assistantIndex = index;
    }
    if (entry?.kind === "message" && entry.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (assistantIndex <= lastUserIndex) {
    assistantIndex = -1;
  }
  if (assistantIndex < 0) {
    return settled;
  }
  return settled.map((entry, index) =>
    index === assistantIndex && entry.kind === "message"
      ? {
          ...entry,
          ...(usage
            ? {
                tokenUsage: {
                  usedTokens: usage.usedTokens,
                  maxTokens: usage.maxTokens,
                },
              }
            : {}),
          ...(billingUsage ? { billingUsage } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(sessionModeId ? { sessionModeId } : {}),
        }
      : entry,
  );
};

const appendUserChunk = (
  timeline: TimelineEntry[],
  update: JsonObject,
  eventId?: string,
): TimelineEntry[] => {
  const content = objectValue(update.content);
  const contentMeta = objectValue(content?._meta);
  const chunkMeta = objectValue(update._meta);
  if (chunkMeta?.hideFromScrollback === true) {
    return timeline;
  }
  const text =
    stringValue(contentMeta?.displayText) ?? stringValue(content?.text);
  if (!text) {
    return timeline;
  }
  const promptIndex = numberValue(chunkMeta?.promptIndex);
  const settled = settleSessionProjection(timeline);
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
      { ...last, content: `${last.content}\n${text}`, streaming: true },
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

export const appendSessionError = (
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
    ...settleSessionProjection(timeline),
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
  tool: JsonObject,
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
      toolCommand(tool) || (existing?.kind === "tool" ? existing.command : ""),
    output:
      toolOutput(tool) || (existing?.kind === "tool" ? existing.output : ""),
    startedAt: existing?.kind === "tool" ? existing.startedAt : Date.now(),
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
    permission: existing?.kind === "tool" ? existing.permission : undefined,
    permissionRequestId:
      existing?.kind === "tool" ? existing.permissionRequestId : undefined,
    permissionOptions:
      existing?.kind === "tool" ? existing.permissionOptions : undefined,
    question: existing?.kind === "tool" ? existing.question : undefined,
  };

  if (index < 0) {
    return [...timeline, next];
  }
  return timeline.map((entry, entryIndex) =>
    entryIndex === index ? next : entry,
  );
};

export const projectPermissionRequest = (
  timeline: TimelineEntry[],
  tool: JsonObject,
  requestId: JsonRpcId,
  options: PermissionOption[],
) => {
  const toolCallId =
    stringValue(tool.toolCallId) ?? `permission-${String(requestId)}`;
  const normalizedTool = { ...tool, toolCallId };
  return {
    timeline: upsertTool(timeline, normalizedTool).map((entry) =>
      entry.kind === "tool" && entry.toolCallId === toolCallId
        ? {
            ...entry,
            permission: "pending" as const,
            permissionRequestId: requestId,
            permissionOptions: options,
          }
        : entry,
    ),
    toolCallId,
    title: stringValue(tool.title) ?? "工具调用",
    command: toolCommand(tool),
  };
};

export const parseSessionContextUsage = (
  value: JsonObject | undefined,
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
    currency && /^[a-z]{3}$/i.test(currency)
      ? currency.toUpperCase()
      : undefined;
  return {
    usedTokens,
    maxTokens,
    ...(amount !== undefined && amount >= 0 && normalizedCurrency
      ? { cost: { amount, currency: normalizedCurrency } }
      : {}),
  };
};

const billingUsageValue = (
  value: JsonObject | undefined,
): AgentBillingUsage | undefined => {
  const inputTokens = numberValue(value?.inputTokens);
  const outputTokens = numberValue(value?.outputTokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return undefined;
  }
  const cachedReadTokens = numberValue(value?.cachedReadTokens) ?? 0;
  const reasoningTokens = numberValue(value?.reasoningTokens) ?? 0;
  const modelCalls = numberValue(value?.modelCalls) ?? 0;
  const apiDurationMs = numberValue(value?.apiDurationMs) ?? 0;
  const costUsdTicks = numberValue(value?.costUsdTicks);
  return {
    inputTokens,
    outputTokens,
    cachedReadTokens: Math.max(0, cachedReadTokens),
    reasoningTokens: Math.max(0, reasoningTokens),
    modelCalls: Math.max(0, modelCalls),
    apiDurationMs: Math.max(0, apiDurationMs),
    usageIsIncomplete: value?.usageIsIncomplete === true,
    costIsPartial: value?.costIsPartial === true,
    ...(costUsdTicks !== undefined && costUsdTicks >= 0
      ? { costUsdTicks }
      : {}),
  };
};

export const applySessionUpdate = (
  timeline: TimelineEntry[],
  update: JsonObject | undefined,
  eventId?: string,
): SessionUpdateResult => {
  const updateType = stringValue(update?.sessionUpdate);

  if (updateType === "usage_update") {
    return {
      timeline,
      contextUsage: parseSessionContextUsage(update),
    };
  }

  if (updateType === "user_message_chunk" && update) {
    return { timeline: appendUserChunk(timeline, update, eventId) };
  }

  if (updateType === "agent_message_chunk") {
    const text = stringValue(objectValue(update?.content)?.text);
    return text
      ? { timeline: appendAgentChunk(timeline, text), streaming: true }
      : { timeline };
  }

  if (updateType === "agent_thought_chunk") {
    const text = stringValue(objectValue(update?.content)?.text);
    return text
      ? { timeline: appendThoughtChunk(timeline, text), streaming: true }
      : { timeline };
  }

  if (updateType === "retry_state" && stringValue(update?.type) === "failed") {
    const detail = stringValue(update?.message) ?? "模型请求失败。";
    return {
      timeline: appendSessionError(timeline, detail),
      error: detail,
    };
  }

  if (updateType === "turn_completed") {
    const billingUsage = billingUsageValue(objectValue(update?.usage));
    const stopReason =
      stringValue(update?.stopReason) ?? stringValue(update?.stop_reason);
    const detail =
      stringValue(update?.agentResult) ?? stringValue(update?.agent_result);
    if (stopReason === "error") {
      const failure = detail ?? "本轮 Melody 对话发生错误。";
      return {
        timeline: stampLatestTurnAnalytics(
          appendSessionError(timeline, failure),
          undefined,
          billingUsage,
          undefined,
          undefined,
        ),
        error: failure,
        completed: true,
      };
    }
    return {
      timeline: stampLatestTurnAnalytics(
        timeline,
        undefined,
        billingUsage,
        undefined,
        undefined,
      ),
      completed: true,
    };
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    return {
      timeline: upsertTool(settleSessionProjection(timeline), update ?? {}),
    };
  }

  return { timeline };
};

// Version 3 replays projections written before MelodyWork handled the durable
// `_x.ai/session/update` completion rail. Those projections may otherwise keep
// a finished assistant message marked as streaming forever.
export const TIMELINE_PROJECTION_VERSION = 3;

const SESSION_UPDATE_METHODS = new Set([
  "session/update",
  "_x.ai/session/update",
  "x.ai/session/update",
  "_x.ai/session_notification",
  "x.ai/session_notification",
]);

export const isSessionUpdateMethod = (method?: string): boolean =>
  method !== undefined && SESSION_UPDATE_METHODS.has(method);

export interface NotificationMetadata {
  eventId?: string;
  isReplay: boolean;
  promptId?: string;
}

export type TimelineProjectionReadStatus = "missing" | "valid" | "corrupt";

export interface TimelineProjectionRead {
  timeline: TimelineEntry[];
  status: TimelineProjectionReadStatus;
}

const isTimelineEntry = (value: unknown): value is TimelineEntry => {
  const entry = objectValue(value);
  if (!entry || typeof entry.id !== "string") {
    return false;
  }
  if (entry.kind === "message") {
    return (
      (entry.role === "user" || entry.role === "assistant") &&
      typeof entry.content === "string"
    );
  }
  if (entry.kind === "thought") {
    return typeof entry.content === "string";
  }
  if (entry.kind === "plan") {
    return (
      typeof entry.toolCallId === "string" &&
      typeof entry.content === "string" &&
      [
        "streaming",
        "awaiting-approval",
        "approved",
        "changes-requested",
        "abandoned",
        "superseded",
      ].includes(entry.status as string)
    );
  }
  if (entry.kind === "tool") {
    const validTool =
      typeof entry.title === "string" &&
      typeof entry.command === "string" &&
      typeof entry.output === "string";
    if (!validTool) {
      return false;
    }
    const question = objectValue(entry.question);
    if (!question) {
      return true;
    }
    return (
      (typeof question.requestId === "string" ||
        typeof question.requestId === "number") &&
      typeof question.sessionId === "string" &&
      typeof question.toolCallId === "string" &&
      Array.isArray(question.questions) &&
      question.questions.length > 0 &&
      (question.mode === "default" || question.mode === "plan") &&
      [
        "pending",
        "accepted",
        "chat_about_this",
        "skip_interview",
        "cancelled",
      ].includes(question.outcome as string)
    );
  }
  return false;
};

export const readTimelineProjection = (
  timelineJson?: string,
): TimelineProjectionRead => {
  if (!timelineJson) {
    return { timeline: [], status: "missing" };
  }
  try {
    const value: unknown = JSON.parse(timelineJson);
    if (!Array.isArray(value)) {
      return { timeline: [], status: "corrupt" };
    }
    const timeline = value.filter(isTimelineEntry);
    return {
      // Keep healthy entries available to the read-only fallback while the
      // corrupt projection is excluded from cursor-based restoration.
      timeline,
      status: timeline.length === value.length ? "valid" : "corrupt",
    };
  } catch {
    return { timeline: [], status: "corrupt" };
  }
};

export const parseTimelineProjection = (
  timelineJson?: string,
): TimelineEntry[] => readTimelineProjection(timelineJson).timeline;

export const usableTimelineProjection = ({
  timelineJson,
  cursor,
  version,
}: {
  timelineJson?: string;
  cursor?: string;
  version?: number;
}): TimelineEntry[] =>
  version === TIMELINE_PROJECTION_VERSION && cursor
    ? (() => {
        const projection = readTimelineProjection(timelineJson);
        return projection.status === "corrupt" ? [] : projection.timeline;
      })()
    : [];

export const timelineProjectionVersion = (
  timeline: TimelineEntry[],
  activelyStreaming = false,
) => {
  const hasOrphanedStream =
    !activelyStreaming &&
    timeline.some(
      (entry) =>
        (entry.kind === "message" || entry.kind === "thought") &&
        entry.streaming,
    );
  const hasLegacyTool = timeline.some(
    (entry) => entry.kind === "tool" && entry.activity === undefined,
  );
  return hasOrphanedStream || hasLegacyTool
    ? TIMELINE_PROJECTION_VERSION - 1
    : TIMELINE_PROJECTION_VERSION;
};

export const notificationMetadata = (
  params: Record<string, unknown> | undefined,
): NotificationMetadata => {
  const value = params?._meta;
  const meta =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    eventId: typeof meta?.eventId === "string" ? meta.eventId : undefined,
    isReplay: meta?.isReplay === true,
    ...(typeof meta?.promptId === "string" ? { promptId: meta.promptId } : {}),
  };
};

/**
 * Melody Build stamps the same event id on a live notification and its
 * persisted replay. Keeping a bounded exact-id set makes applying those
 * notifications idempotent without assuming counters stay monotonic across
 * multiple Melody Build processes.
 */
export class SessionEventDeduplicator {
  readonly capacityPerSession: number;
  readonly maxSessions: number;
  readonly #eventIds = new Map<
    string,
    { order: string[]; values: Set<string> }
  >();

  constructor(capacityPerSession = 4096, maxSessions = 128) {
    this.capacityPerSession = capacityPerSession;
    this.maxSessions = maxSessions;
  }

  reset(sessionId: string) {
    this.#eventIds.delete(sessionId);
  }

  clear() {
    this.#eventIds.clear();
  }

  accept(sessionId: string, eventId?: string): boolean {
    if (!eventId) {
      return true;
    }
    const tracked = this.#eventIds.get(sessionId) ?? {
      order: [],
      values: new Set<string>(),
    };
    if (tracked.values.has(eventId)) {
      return false;
    }
    tracked.values.add(eventId);
    tracked.order.push(eventId);
    while (tracked.order.length > this.capacityPerSession) {
      const expired = tracked.order.shift();
      if (expired) {
        tracked.values.delete(expired);
      }
    }
    if (
      !this.#eventIds.has(sessionId) &&
      this.#eventIds.size >= this.maxSessions
    ) {
      const oldestSession = this.#eventIds.keys().next().value;
      if (oldestSession !== undefined) {
        this.#eventIds.delete(oldestSession);
      }
    }
    this.#eventIds.set(sessionId, tracked);
    return true;
  }
}
