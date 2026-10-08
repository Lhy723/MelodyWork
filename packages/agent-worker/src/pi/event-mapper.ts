import type {
  AgentEvent,
  AgentAssistantMetadata,
  AgentAssistantUsage,
  AgentUsage,
  JsonObject,
} from "@melody/agent-contract";

export interface PiEventMappingContext {
  sessionId: string;
  runId?: string;
  promptId?: string;
  /**
   * Tool names whose request lifecycle is emitted by a host gateway callback.
   * Pi also reports their provider-level toolcall_start/toolcall_delta events;
   * those are metadata, not a second product request.
   */
  gatewayToolNames?: ReadonlySet<string>;
  nextMessageId: () => string;
  offsets: Map<string, number>;
  /**
   * Pi's AgentMessage values do not carry a product message id. Keep the
   * active ids in the adapter context so every partial update for one
   * response shares the same message/offset identity.
   */
  activeMessageIds: Map<"user" | "assistant", string>;
}

export interface MappedPiEvent {
  event: AgentEvent;
}

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nonNegativeNumber = (value: unknown): number | undefined => {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
};

const boundedString = (value: unknown, max = 256): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
};

// Pi emits a full queue snapshot. Keep the normalized event safely below the
// JSONL frame limit even when a user has queued very long prompts or many
// follow-ups; the queue itself remains owned by Pi and is never mutated here.
const MAX_QUEUE_MESSAGES = 64;
const MAX_QUEUE_MESSAGE_CHARS = 8_192;
const queueMessages = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .slice(0, MAX_QUEUE_MESSAGES)
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, MAX_QUEUE_MESSAGE_CHARS))
    : [];

const jsonValue = (value: unknown): JsonObject => {
  const source = record(value);
  if (!source) return {};
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(source)) {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      result[key] = item;
    } else if (Array.isArray(item)) {
      const values = item.filter(
        (entry) =>
          entry === null ||
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean",
      );
      result[key] = values;
    }
  }
  return result;
};

export const textFromContent = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map(textFromContent)
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join("") : undefined;
  }
  const item = record(value);
  if (!item) return undefined;
  for (const key of ["text", "value", "content", "partialResult"]) {
    const text = textFromContent(item[key]);
    if (text !== undefined) return text;
  }
  return undefined;
};

/**
 * The Host may prepend a first-turn memory reminder to the prompt because Pi
 * exposes no public per-turn system-reminder mutation. Keep that internal
 * bridge payload out of the product transcript and renderer while preserving
 * it in the provider request.
 */
export const stripInjectedMemoryContext = (value: string): string => {
  const prefix = "<melody-memory-context>\n";
  const marker = "</melody-memory-context>";
  if (!value.startsWith(prefix)) return value;
  const start = value.slice(prefix.length);
  const end = start.indexOf(marker);
  if (end < 0) return value;
  return start.slice(end + marker.length).replace(/^\n\n/u, "");
};

const messageRole = (
  message: RecordValue | undefined,
): "user" | "assistant" | undefined => {
  const role = stringValue(message?.role);
  if (role === "user" || role === "assistant") return role;
  return undefined;
};

const explicitMessageId = (
  message: RecordValue | undefined,
): string | undefined =>
  stringValue(message?.id) ?? stringValue(message?.messageId);

const messageId = (
  message: RecordValue | undefined,
  context: PiEventMappingContext,
  roleHint?: "user" | "assistant",
  start = false,
): string =>
  (() => {
    const role = roleHint ?? messageRole(message);
    const explicit = explicitMessageId(message);
    if (explicit) {
      if (role) context.activeMessageIds.set(role, explicit);
      return explicit;
    }

    // A message_start marks a new logical message even when Pi omits an id.
    // For updates/end events, prefer the active role id; this is important
    // because Pi sends a fresh partial object on every update.
    if (!start && role) {
      const active = context.activeMessageIds.get(role);
      if (active) return active;
    }

    const responseId = stringValue(message?.responseId);
    const generated = responseId
      ? `${context.sessionId}:response:${responseId}`
      : `${context.sessionId}:message:${context.nextMessageId()}`;
    if (role) context.activeMessageIds.set(role, generated);
    return generated;
  })();

const offsetEvent = (
  type: "message.delta" | "thought.delta",
  id: string,
  partId: string,
  text: string,
  context: PiEventMappingContext,
): AgentEvent | undefined => {
  if (text.length === 0) return undefined;
  const key = `${type}:${id}:${partId}`;
  const offset = context.offsets.get(key) ?? 0;
  context.offsets.set(key, offset + text.length);
  return { type, messageId: id, partId, text, offset };
};

const usageFrom = (value: unknown): AgentUsage | undefined => {
  const source = record(value);
  if (!source) return undefined;
  const usage: AgentUsage = { confidence: "measured" };
  const fields: Array<
    [Exclude<keyof AgentUsage, "confidence" | "cost">, readonly string[]]
  > = [
    ["inputTokens", ["inputTokens", "input"]],
    ["outputTokens", ["outputTokens", "output"]],
    ["cachedReadTokens", ["cachedReadTokens", "cacheRead"]],
    ["reasoningTokens", ["reasoningTokens", "reasoning"]],
    ["modelCalls", ["modelCalls"]],
    ["apiDurationMs", ["apiDurationMs"]],
  ];
  let found = false;
  for (const [target, sourceKeys] of fields) {
    const number = sourceKeys
      .map((sourceKey) => finiteNumber(source[sourceKey]))
      .find((item): item is number => item !== undefined);
    if (number !== undefined) {
      usage[target] = number;
      found = true;
    }
  }
  const cost = record(source.cost);
  const explicitAmount = finiteNumber(cost?.amount);
  const piAmount = finiteNumber(cost?.total);
  const amount = explicitAmount ?? piAmount;
  // Pi's Usage cost is a numeric USD total (its model rates are USD per
  // million tokens); ACP may instead provide an explicit amount/currency.
  const currency =
    stringValue(cost?.currency) ?? (piAmount !== undefined ? "USD" : undefined);
  if (amount !== undefined && currency) {
    usage.cost = { amount, currency };
    found = true;
  }
  return found ? usage : undefined;
};

/** Preserve the lossless usage fields Pi requires in a native session row. */
const assistantUsageFrom = (
  value: unknown,
): AgentAssistantUsage | undefined => {
  const source = record(value);
  if (!source) return undefined;
  const input = nonNegativeNumber(source.input);
  const output = nonNegativeNumber(source.output);
  const cacheRead = nonNegativeNumber(source.cacheRead);
  const cacheWrite = nonNegativeNumber(source.cacheWrite);
  const totalTokens = nonNegativeNumber(source.totalTokens);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }
  const cost = record(source.cost);
  const costInput = nonNegativeNumber(cost?.input);
  const costOutput = nonNegativeNumber(cost?.output);
  const costCacheRead = nonNegativeNumber(cost?.cacheRead);
  const costCacheWrite = nonNegativeNumber(cost?.cacheWrite);
  const costTotal = nonNegativeNumber(cost?.total);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    ...(costInput !== undefined &&
    costOutput !== undefined &&
    costCacheRead !== undefined &&
    costCacheWrite !== undefined &&
    costTotal !== undefined
      ? {
          cost: {
            input: costInput,
            output: costOutput,
            cacheRead: costCacheRead,
            cacheWrite: costCacheWrite,
            total: costTotal,
          },
        }
      : {}),
  };
};

const assistantMetadataFrom = (
  message: RecordValue | undefined,
): AgentAssistantMetadata | undefined => {
  if (messageRole(message) !== "assistant") return undefined;
  const metadata: AgentAssistantMetadata = {
    ...(boundedString(message?.provider)
      ? { provider: boundedString(message?.provider) }
      : {}),
    ...(boundedString(message?.api)
      ? { api: boundedString(message?.api) }
      : {}),
    ...(boundedString(message?.model)
      ? { model: boundedString(message?.model) }
      : {}),
    ...(boundedString(message?.responseId)
      ? { responseId: boundedString(message?.responseId) }
      : {}),
    ...(boundedString(message?.stopReason)
      ? { stopReason: boundedString(message?.stopReason) }
      : {}),
    ...(assistantUsageFrom(message?.usage)
      ? { usage: assistantUsageFrom(message?.usage) }
      : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const contextEventFrom = (value: unknown): AgentEvent | undefined => {
  const source = record(value);
  if (!source) return undefined;
  const tokens = finiteNumber(source.tokens);
  const contextWindow = finiteNumber(source.contextWindow);
  return {
    type: "context.updated",
    tokens: tokens ?? null,
    limit: contextWindow ?? null,
    confidence: tokens === undefined ? "unknown" : "measured",
  };
};

const toolId = (source: RecordValue, context: PiEventMappingContext): string =>
  stringValue(source.toolCallId) ??
  stringValue(source.id) ??
  `${context.sessionId}:tool:${context.nextMessageId()}`;

/**
 * Resolve the tool call a streaming `assistantMessageEvent` refers to.
 *
 * Pi's `toolcall_start`/`toolcall_delta` events carry no top-level tool name or
 * id: the call lives in `partial.content[contentIndex]`. Reading only the
 * top-level fields left every streamed tool call nameless, which produced a
 * blank `tool.requested` row that no later event could match — and defeated the
 * ToolGateway duplicate suppression, since the name is what identifies a
 * gateway tool.
 */
const streamedToolCall = (
  assistantEvent: RecordValue,
  message: RecordValue | undefined,
): { id?: string; name?: string } => {
  const contentIndex = finiteNumber(assistantEvent.contentIndex) ?? 0;
  const partial = record(assistantEvent.partial) ?? message;
  const content = partial?.content;
  const part = Array.isArray(content)
    ? record(content[contentIndex])
    : undefined;
  const nestedName =
    stringValue(part?.name) ??
    stringValue(record(part?.function)?.name) ??
    stringValue(part?.toolName);
  const nestedId = stringValue(part?.id) ?? stringValue(part?.toolCallId);
  return {
    ...((stringValue(assistantEvent.toolName) ?? nestedName)
      ? { name: stringValue(assistantEvent.toolName) ?? nestedName }
      : {}),
    ...((stringValue(assistantEvent.toolCallId) ??
    stringValue(assistantEvent.id) ??
    nestedId)
      ? {
          id:
            stringValue(assistantEvent.toolCallId) ??
            stringValue(assistantEvent.id) ??
            nestedId,
        }
      : {}),
  };
};

/** Map Pi's public AgentSession event union to the engine-neutral contract. */
export const mapPiEvent = (
  value: unknown,
  context: PiEventMappingContext,
): MappedPiEvent[] => {
  const event = record(value);
  const type = stringValue(event?.type);
  if (!event || !type) return [];
  const mapped: MappedPiEvent[] = [];

  if (type === "agent_start") {
    if (context.runId) {
      mapped.push({
        event: { type: "run.started", promptId: context.promptId },
      });
    }
    return mapped;
  }

  if (type === "queue_update") {
    mapped.push({
      event: {
        type: "run.queue_updated",
        steering: queueMessages(event.steering),
        followUp: queueMessages(event.followUp),
      },
    });
    return mapped;
  }

  if (type === "message_start") {
    const message = record(event.message);
    const role = messageRole(message);
    if (role) {
      const id = messageId(message, context, role, true);
      mapped.push({
        event: {
          type: "message.started",
          messageId: id,
          role,
          content:
            role === "user"
              ? (() => {
                  const content = textFromContent(message?.content);
                  return content === undefined
                    ? undefined
                    : stripInjectedMemoryContext(content);
                })()
              : undefined,
        },
      });
    }
    return mapped;
  }

  if (type === "message_update") {
    const message = record(event.message);
    const assistantEvent = record(event.assistantMessageEvent);
    if (!assistantEvent) return mapped;
    const id = messageId(message, context);
    const contentIndex =
      finiteNumber(assistantEvent.contentIndex) ??
      stringValue(assistantEvent.contentIndex) ??
      "0";
    const partId = String(contentIndex);
    const assistantType = stringValue(assistantEvent.type);
    const delta = textFromContent(assistantEvent.delta);
    if (assistantType === "text_delta" && delta) {
      const mappedEvent = offsetEvent(
        "message.delta",
        id,
        partId,
        delta,
        context,
      );
      if (mappedEvent) mapped.push({ event: mappedEvent });
    } else if (assistantType === "thinking_delta" && delta) {
      const mappedEvent = offsetEvent(
        "thought.delta",
        id,
        partId,
        delta,
        context,
      );
      if (mappedEvent) mapped.push({ event: mappedEvent });
    } else if (assistantType === "toolcall_start") {
      const call = streamedToolCall(assistantEvent, message);
      // Custom ToolGateway tools emit one authoritative request from their
      // execute callback, including validated arguments. Avoid exposing the
      // provider-level start event as a duplicate request.
      if (call.name && !context.gatewayToolNames?.has(call.name)) {
        mapped.push({
          event: {
            type: "tool.requested",
            toolCallId: call.id ?? toolId(assistantEvent, context),
            toolName: call.name,
            status: "pending",
          },
        });
      }
    } else if (assistantType === "toolcall_delta" && delta) {
      const call = streamedToolCall(assistantEvent, message);
      if (call.name && !context.gatewayToolNames?.has(call.name)) {
        mapped.push({
          event: {
            type: "tool.progress",
            toolCallId: call.id ?? toolId(assistantEvent, context),
            toolName: call.name,
            output: delta,
            status: "running",
          },
        });
      }
    }
    const usage = usageFrom(message?.usage ?? assistantEvent.usage);
    if (usage) mapped.push({ event: { type: "usage.updated", usage } });
    return mapped;
  }

  if (type === "message_end") {
    const message = record(event.message);
    const role = messageRole(message);
    if (role) {
      const id = messageId(message, context, role);
      const assistantMetadata =
        role === "assistant" ? assistantMetadataFrom(message) : undefined;
      mapped.push({
        event: {
          type: "message.completed",
          messageId: id,
          role,
          content: (() => {
            const content = textFromContent(message?.content);
            return content === undefined || role !== "user"
              ? content
              : stripInjectedMemoryContext(content);
          })(),
          ...(assistantMetadata ? { assistantMetadata } : {}),
        },
      });
      context.activeMessageIds.delete(role);
    }
    const usage = usageFrom(message?.usage);
    if (usage) mapped.push({ event: { type: "usage.updated", usage } });
    return mapped;
  }

  if (type === "tool_execution_start") {
    const toolName = stringValue(event.toolName);
    if (toolName && context.gatewayToolNames?.has(toolName)) return mapped;
    mapped.push({
      event: {
        type: "tool.started",
        toolCallId: toolId(event, context),
        toolName,
        status: "running",
        activity: jsonValue(event.args),
      },
    });
    return mapped;
  }

  if (type === "tool_execution_update") {
    const toolName = stringValue(event.toolName);
    if (toolName && context.gatewayToolNames?.has(toolName)) return mapped;
    mapped.push({
      event: {
        type: "tool.progress",
        toolCallId: toolId(event, context),
        toolName,
        output: textFromContent(event.partialResult),
        status: "running",
      },
    });
    return mapped;
  }

  if (type === "tool_execution_end") {
    const toolName = stringValue(event.toolName);
    if (toolName && context.gatewayToolNames?.has(toolName)) return mapped;
    const isError = event.isError === true;
    mapped.push({
      event: {
        type: "tool.finished",
        toolCallId: toolId(event, context),
        toolName,
        output: textFromContent(event.result),
        status: isError ? "failed" : "completed",
        error: isError
          ? {
              code: "pi.tool_failed",
              message:
                textFromContent(event.result) ?? "Pi tool execution failed.",
              retriable: false,
              scope: "tool",
            }
          : undefined,
      },
    });
    return mapped;
  }

  if (type === "compaction_start") {
    mapped.push({ event: { type: "session.compacting" } });
    return mapped;
  }
  if (type === "compaction_end") {
    mapped.push({ event: { type: "session.compacted" } });
    return mapped;
  }
  if (type === "turn_end") {
    const usage = usageFrom(record(event.message)?.usage);
    if (usage) mapped.push({ event: { type: "usage.updated", usage } });
    const contextEvent = contextEventFrom(event.contextUsage);
    if (contextEvent) mapped.push({ event: contextEvent });
    return mapped;
  }
  if (type === "agent_settled") {
    const contextEvent = contextEventFrom(event.contextUsage);
    if (contextEvent) mapped.push({ event: contextEvent });
    return mapped;
  }
  return mapped;
};
