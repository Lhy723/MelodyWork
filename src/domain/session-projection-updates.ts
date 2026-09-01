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
  /** A non-terminal status emitted while the agent is retrying a request. */
  statusMessage?: string;
  contextUsage?: AgentContextUsage;
}

const objectValue = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object"
    ? (value as JsonObject)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const wireValue = (
  value: JsonObject | undefined,
  camelCase: string,
  snakeCase: string,
) => value?.[camelCase] ?? value?.[snakeCase];

const wireString = (
  value: JsonObject | undefined,
  camelCase: string,
  snakeCase: string,
) => stringValue(wireValue(value, camelCase, snakeCase));

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

const textFromContent = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => textFromContent(item))
      .filter((item): item is string => Boolean(item))
      .join("");
    return text || undefined;
  }
  const content = objectValue(value);
  if (!content) {
    return undefined;
  }
  const meta = objectValue(content._meta) ?? objectValue(content.meta);
  return (
    stringValue(meta?.displayText) ??
    stringValue(meta?.display_text) ??
    stringValue(content.text) ??
    stringValue(content.content) ??
    textFromContent(content.content)
  );
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
  const chunkMeta = objectValue(update._meta) ?? objectValue(update.meta);
  if (
    chunkMeta?.hideFromScrollback === true ||
    chunkMeta?.hide_from_scrollback === true
  ) {
    return timeline;
  }
  const text = textFromContent(update.content);
  if (!text) {
    return timeline;
  }
  const promptIndex = numberValue(
    wireValue(chunkMeta, "promptIndex", "prompt_index"),
  );
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
  const usedTokens = numberValue(wireValue(value, "used", "used_tokens"));
  const maxTokens = numberValue(wireValue(value, "size", "max_tokens"));
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
  const inputTokens = numberValue(
    wireValue(value, "inputTokens", "input_tokens"),
  );
  const outputTokens = numberValue(
    wireValue(value, "outputTokens", "output_tokens"),
  );
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return undefined;
  }
  const cachedReadTokens =
    numberValue(wireValue(value, "cachedReadTokens", "cached_read_tokens")) ??
    0;
  const reasoningTokens =
    numberValue(wireValue(value, "reasoningTokens", "reasoning_tokens")) ?? 0;
  const modelCalls =
    numberValue(wireValue(value, "modelCalls", "model_calls")) ?? 0;
  const apiDurationMs =
    numberValue(wireValue(value, "apiDurationMs", "api_duration_ms")) ?? 0;
  const costUsdTicks = numberValue(
    wireValue(value, "costUsdTicks", "cost_usd_ticks"),
  );
  const usageIsIncomplete =
    wireValue(value, "usageIsIncomplete", "usage_is_incomplete") === true;
  const costIsPartial =
    wireValue(value, "costIsPartial", "cost_is_partial") === true;
  return {
    inputTokens,
    outputTokens,
    cachedReadTokens: Math.max(0, cachedReadTokens),
    reasoningTokens: Math.max(0, reasoningTokens),
    modelCalls: Math.max(0, modelCalls),
    apiDurationMs: Math.max(0, apiDurationMs),
    usageIsIncomplete,
    costIsPartial,
    ...(costUsdTicks !== undefined && costUsdTicks >= 0
      ? { costUsdTicks }
      : {}),
  };
};

const appendTerminalAgentResult = (
  timeline: TimelineEntry[],
  resultText: string | undefined,
): TimelineEntry[] => {
  const text = resultText?.trim();
  if (!text) {
    return timeline;
  }
  let lastUserIndex = -1;
  let lastAssistantIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (
      lastAssistantIndex < 0 &&
      entry?.kind === "message" &&
      entry.role === "assistant"
    ) {
      lastAssistantIndex = index;
    }
    if (entry?.kind === "message" && entry.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastAssistantIndex > lastUserIndex) {
    return timeline;
  }
  const now = Date.now();
  return [
    ...settleSessionProjection(timeline),
    {
      id: `assistant-terminal-${now}`,
      kind: "message",
      role: "assistant",
      content: text,
      startedAt: now,
      completedAt: now,
    },
  ];
};

const hasAssistantAfterLatestUser = (timeline: TimelineEntry[]) => {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry?.kind === "message" && entry.role === "user") {
      return false;
    }
    if (entry?.kind === "message" && entry.role === "assistant") {
      return true;
    }
  }
  return false;
};

const normalizedFailureReason = (value: string | undefined) =>
  value?.toLowerCase().replace(/[-\s]/g, "_");

const isRateLimitReason = (value: string | undefined) => {
  if (!value) {
    return false;
  }
  return /(?:\b429\b|rate[_ -]?limit|too[_ -]?many[_ -]?requests|tpm|throttl|overload|inference.*exhausted)/i.test(
    value,
  );
};

const isRateLimitedUpdate = (update: JsonObject | undefined) =>
  wireValue(update, "isRateLimited", "is_rate_limited") === true;

const isFailureStopReason = (stopReason: string | undefined) => {
  const normalized = normalizedFailureReason(stopReason);
  return (
    normalized !== undefined &&
    [
      "error",
      "failed",
      "failure",
      "refusal",
      "content_filter",
      "internal_error",
      "rate_limit",
      "rate_limited",
      "too_many_requests",
      "overloaded",
      "timeout",
      "timed_out",
    ].includes(normalized)
  );
};

const failureMessage = (
  stopReason: string | undefined,
  detail: string | undefined,
  rateLimited = false,
) => {
  const normalized = normalizedFailureReason(stopReason);
  if (
    rateLimited ||
    normalized === "rate_limit" ||
    normalized === "rate_limited" ||
    normalized === "too_many_requests" ||
    normalized === "overloaded" ||
    isRateLimitReason(detail)
  ) {
    return "模型请求受到限流（TPM），请稍后再试或切换模型。";
  }
  if (normalized === "timeout" || normalized === "timed_out") {
    return "模型请求超时，请稍后重试。";
  }
  return detail?.trim() || "本轮 Melody 对话发生错误。";
};

export const applySessionUpdate = (
  timeline: TimelineEntry[],
  update: JsonObject | undefined,
  eventId?: string,
): SessionUpdateResult => {
  const updateType = wireString(update, "sessionUpdate", "session_update");

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
    const text = textFromContent(update?.content);
    return text
      ? { timeline: appendAgentChunk(timeline, text), streaming: true }
      : { timeline };
  }

  if (updateType === "agent_thought_chunk") {
    const text = textFromContent(update?.content);
    return text
      ? { timeline: appendThoughtChunk(timeline, text), streaming: true }
      : { timeline };
  }

  const retryType = normalizedFailureReason(
    wireString(update, "type", "status"),
  );
  if (updateType === "retry_state") {
    const detail =
      wireString(update, "message", "reason") ??
      wireString(update, "error", "error_message");
    const rateLimited =
      isRateLimitedUpdate(update) || isRateLimitReason(detail);
    if (retryType === "retrying") {
      return {
        timeline,
        statusMessage: rateLimited
          ? "模型请求受到限流，正在重试…"
          : detail
            ? `模型请求失败，正在重试：${detail}`
            : "正在重试模型请求…",
      };
    }
    if (["failed", "error", "exhausted"].includes(retryType ?? "")) {
      const failure = failureMessage(undefined, detail, rateLimited);
      return {
        timeline: appendSessionError(timeline, failure),
        error: failure,
        completed: true,
      };
    }
  }

  if (updateType === "turn_completed") {
    const billingUsage = billingUsageValue(objectValue(update?.usage));
    const stopReason = wireString(update, "stopReason", "stop_reason");
    const detail =
      wireString(update, "agentResult", "agent_result") ??
      textFromContent(update?.result);
    if (isFailureStopReason(stopReason)) {
      const failure = failureMessage(stopReason, detail);
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
    const withTerminalResult = appendTerminalAgentResult(timeline, detail);
    const fallbackTimeline =
      detail?.trim() || hasAssistantAfterLatestUser(withTerminalResult)
        ? withTerminalResult
        : appendTerminalAgentResult(
            withTerminalResult,
            "本轮已完成，但没有返回可显示的文本。",
          );
    return {
      timeline: stampLatestTurnAnalytics(
        fallbackTimeline,
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
