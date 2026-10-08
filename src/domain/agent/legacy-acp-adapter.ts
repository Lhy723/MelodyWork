import type { AcpEnvelope } from "../acp.ts";
import {
  AGENT_PROTOCOL_VERSION,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentUsage,
  type JsonObject,
  type JsonValue,
} from "./contract.ts";

type RecordValue = Record<string, unknown>;

const recordValue = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object"
    ? (value as RecordValue)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const jsonValue = (value: unknown): JsonValue | undefined => {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const parsed = jsonValue(item);
      return parsed === undefined ? [] : [parsed];
    });
  }
  const record = recordValue(value);
  if (!record) return undefined;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(record)) {
    const parsed = jsonValue(item);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
};

const jsonObject = (value: unknown): JsonObject => {
  const parsed = jsonValue(value);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : {};
};

const wireValue = (
  value: RecordValue | undefined,
  camel: string,
  snake: string,
): unknown => value?.[camel] ?? value?.[snake];

const updatePayload = (message: AcpEnvelope): RecordValue | undefined => {
  const params = recordValue(message.params);
  const update = recordValue(params?.update);
  return update ?? params;
};

const sessionIdFor = (message: AcpEnvelope): string | undefined => {
  const params = recordValue(message.params);
  return stringValue(wireValue(params, "sessionId", "session_id"));
};

const metadataFor = (message: AcpEnvelope): RecordValue | undefined => {
  const params = recordValue(message.params);
  return recordValue(params?._meta) ?? recordValue(params?.meta);
};

const eventIdFor = (message: AcpEnvelope, fallback: string): string =>
  stringValue(wireValue(metadataFor(message), "eventId", "event_id")) ??
  fallback;

const textFrom = (value: unknown): string | undefined => {
  const content = recordValue(value);
  return (
    stringValue(content?.text) ??
    stringValue(content?.content) ??
    (typeof value === "string" ? value : undefined)
  );
};

const usageFrom = (value: unknown): AgentUsage | undefined => {
  const usage = recordValue(value);
  if (!usage) return undefined;
  const cost = recordValue(usage.cost);
  return {
    inputTokens: numberValue(wireValue(usage, "inputTokens", "input_tokens")),
    outputTokens: numberValue(
      wireValue(usage, "outputTokens", "output_tokens"),
    ),
    cachedReadTokens: numberValue(
      wireValue(usage, "cachedReadTokens", "cached_read_tokens"),
    ),
    reasoningTokens: numberValue(
      wireValue(usage, "reasoningTokens", "reasoning_tokens"),
    ),
    modelCalls: numberValue(wireValue(usage, "modelCalls", "model_calls")),
    apiDurationMs: numberValue(
      wireValue(usage, "apiDurationMs", "api_duration_ms"),
    ),
    ...(cost &&
    numberValue(cost.amount) !== undefined &&
    stringValue(cost.currency)
      ? {
          cost: {
            amount: numberValue(cost.amount) as number,
            currency: stringValue(cost.currency) as string,
          },
        }
      : {}),
    confidence: "measured",
  };
};

const envelope = (
  message: AcpEnvelope,
  event: AgentEvent,
  fallback: string,
  runId?: string,
  eventSuffix?: string,
): AgentEventEnvelope => ({
  protocolVersion: AGENT_PROTOCOL_VERSION,
  eventId: eventSuffix
    ? `${eventIdFor(message, fallback)}:${eventSuffix}`
    : eventIdFor(message, fallback),
  sourceEventId: eventIdFor(message, fallback),
  sessionId: sessionIdFor(message),
  ...(runId ? { runId } : {}),
  replay: Boolean(
    metadataFor(message)?.isReplay ?? metadataFor(message)?.is_replay,
  ),
  event,
});

const unhandled = (
  message: AcpEnvelope,
  fallback: string,
): AgentEventEnvelope =>
  envelope(
    message,
    {
      type: "protocol.unhandled",
      ...(message.method ? { method: message.method } : {}),
      payload: jsonObject(message.params ?? message.result ?? message.error),
    },
    fallback,
  );

/**
 * Convert one legacy ACP notification/request into product events.
 *
 * The adapter intentionally emits `protocol.unhandled` for unknown updates.
 * This makes a newly added Melody event visible to migration diagnostics
 * instead of silently dropping it or teaching the product stores ACP details.
 */
export const adaptLegacyAcpMessage = (
  message: AcpEnvelope,
  sourceOrdinal = 0,
): AgentEventEnvelope[] => {
  const fallback = `legacy-${sourceOrdinal}`;
  const params = recordValue(message.params);
  const update = updatePayload(message) ?? {};
  const updateType = stringValue(
    wireValue(update, "sessionUpdate", "session_update"),
  );
  const promptId = stringValue(wireValue(params, "promptId", "prompt_id"));

  if (
    message.method === "session/update" ||
    message.method?.endsWith("/session/update")
  ) {
    if (updateType === "agent_message_chunk") {
      const text = textFrom(update?.content);
      if (!text) return [unhandled(message, fallback)];
      return [
        envelope(
          message,
          {
            type: "message.delta",
            messageId: promptId ?? `${fallback}-assistant`,
            partId: `${fallback}-part`,
            text,
            offset: 0,
          },
          fallback,
        ),
      ];
    }
    if (
      updateType === "agent_thought_chunk" ||
      updateType === "thought_chunk"
    ) {
      const text = textFrom(update?.content);
      if (!text) return [unhandled(message, fallback)];
      return [
        envelope(
          message,
          {
            type: "thought.delta",
            messageId: promptId ?? `${fallback}-thought`,
            partId: `${fallback}-part`,
            text,
            offset: 0,
          },
          fallback,
        ),
      ];
    }
    if (updateType === "turn_completed") {
      const usage = usageFrom(update?.usage);
      return [
        ...(usage
          ? [
              envelope(
                message,
                { type: "usage.updated", usage },
                fallback,
                undefined,
                "usage",
              ),
            ]
          : []),
        envelope(
          message,
          {
            type: "run.finished",
            status: "completed",
            stopReason: stringValue(
              wireValue(update, "stopReason", "stop_reason"),
            ),
          },
          fallback,
          undefined,
          "finished",
        ),
      ];
    }
    if (updateType === "tool_call") {
      const toolCallId = stringValue(
        wireValue(update, "toolCallId", "tool_call_id"),
      );
      if (toolCallId) {
        return [
          envelope(
            message,
            {
              type: "tool.requested",
              toolCallId,
              toolName: stringValue(wireValue(update, "title", "name")),
              status: "pending",
              activity: jsonObject(update),
            },
            fallback,
          ),
        ];
      }
    }
    if (updateType === "tool_call_update") {
      const toolCallId = stringValue(
        wireValue(update, "toolCallId", "tool_call_id"),
      );
      if (toolCallId) {
        const status = stringValue(update.status);
        return [
          envelope(
            message,
            {
              type:
                status === "completed" || status === "failed"
                  ? "tool.finished"
                  : "tool.progress",
              toolCallId,
              status:
                status === "failed"
                  ? "failed"
                  : status === "completed"
                    ? "completed"
                    : "running",
              output: textFrom(update.output),
              activity: jsonObject(update),
            },
            fallback,
          ),
        ];
      }
    }
    return [unhandled(message, fallback)];
  }

  if (
    message.method === "x.ai/session/prompt_complete" ||
    message.method === "_x.ai/session/prompt_complete"
  ) {
    const stopReason = stringValue(
      wireValue(params, "stopReason", "stop_reason"),
    );
    return [
      envelope(
        message,
        {
          type: "run.finished",
          status: stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason,
        },
        fallback,
      ),
    ];
  }

  if (message.method === "session/request_permission") {
    const interactionId =
      message.id === undefined ? fallback : String(message.id);
    return [
      envelope(
        message,
        {
          type: "interaction.requested",
          interactionId,
          kind: "permission",
          payload: jsonObject(params),
        },
        fallback,
      ),
    ];
  }

  if (
    message.method === "x.ai/exit_plan_mode" ||
    message.method === "_x.ai/exit_plan_mode"
  ) {
    const interactionId =
      stringValue(wireValue(params, "toolCallId", "tool_call_id")) ?? fallback;
    return [
      envelope(
        message,
        {
          type: "interaction.requested",
          interactionId,
          kind: "plan",
          payload: jsonObject(params),
        },
        fallback,
      ),
    ];
  }

  if (
    message.method === "x.ai/ask_user_question" ||
    message.method === "_x.ai/ask_user_question"
  ) {
    const interactionId =
      message.id === undefined ? fallback : String(message.id);
    return [
      envelope(
        message,
        {
          type: "interaction.requested",
          interactionId,
          kind: "question",
          payload: jsonObject(params),
        },
        fallback,
      ),
    ];
  }

  return [unhandled(message, fallback)];
};
