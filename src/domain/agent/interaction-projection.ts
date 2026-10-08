import type {
  AcpEnvelope,
  AgentQuestionAnnotation,
  AgentQuestionResponse,
  JsonRpcId,
  PermissionOption,
  TimelineEntry,
} from "../acp.ts";
import { upsertPlanApproval, settlePlanApproval } from "../plan-approval.ts";
import {
  projectPermissionRequest,
  type SessionUpdateResult,
} from "../session-projection-updates.ts";
import {
  parseUserQuestionRequest,
  questionEntryForRequest,
  updateQuestionEntry,
} from "../user-question.ts";
import type { AgentEvent, AgentEventEnvelope, JsonObject } from "./contract.ts";

type RecordValue = Record<string, unknown>;
type InteractionEvent = Extract<
  AgentEvent,
  {
    type:
      "interaction.requested" | "interaction.resolved" | "interaction.expired";
  }
>;
type InteractionRequestEvent = InteractionEvent & {
  type: "interaction.requested";
};
type InteractionResolutionEvent = InteractionEvent & {
  type: "interaction.resolved" | "interaction.expired";
};

export interface InteractionProjectionResult {
  projection: SessionUpdateResult;
  handled: boolean;
  reason?: string;
}

export interface PermissionRequestDetails {
  interactionId: string;
  toolCallId: string;
  title: string;
  command: string;
  options: PermissionOption[];
}

const recordValue = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const wireValue = (
  value: RecordValue | undefined,
  camelCase: string,
  snakeCase: string,
): unknown => value?.[camelCase] ?? value?.[snakeCase];

const rpcId = (value: unknown): JsonRpcId | undefined =>
  (typeof value === "string" && value.trim().length > 0) ||
  (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : undefined;

const jsonValue = (value: unknown): JsonObject[string] | undefined => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const normalized = jsonValue(item);
      return normalized === undefined ? [] : [normalized];
    });
  }
  const object = recordValue(value);
  if (!object) return undefined;
  const normalized: JsonObject = {};
  for (const [key, item] of Object.entries(object)) {
    const next = jsonValue(item);
    if (next !== undefined) normalized[key] = next;
  }
  return normalized;
};

const objectJson = (value: unknown): JsonObject | undefined => {
  const normalized = jsonValue(value);
  return normalized !== null &&
    normalized !== undefined &&
    typeof normalized === "object" &&
    !Array.isArray(normalized)
    ? normalized
    : undefined;
};

const interactionPayload = (event: InteractionEvent): RecordValue =>
  recordValue(event.payload) ?? {};

const toolPayload = (payload: RecordValue): RecordValue =>
  recordValue(wireValue(payload, "toolCall", "tool_call")) ?? payload;

const toolCallIdFrom = (payload: RecordValue, fallback: string): string =>
  stringValue(wireValue(payload, "toolCallId", "tool_call_id")) ??
  stringValue(wireValue(toolPayload(payload), "toolCallId", "tool_call_id")) ??
  fallback;

const permissionOptions = (value: unknown): PermissionOption[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const option = recordValue(item);
        const optionId = stringValue(
          wireValue(option, "optionId", "option_id"),
        );
        const name = stringValue(option?.name);
        const kind = stringValue(option?.kind) as PermissionOption["kind"];
        return optionId &&
          name &&
          [
            "allow_once",
            "allow_always",
            "reject_once",
            "reject_always",
          ].includes(kind)
          ? [{ optionId, name, kind }]
          : [];
      })
    : [];

const permissionProjection = (
  timeline: TimelineEntry[],
  event: InteractionRequestEvent,
): InteractionProjectionResult => {
  const payload = interactionPayload(event);
  const tool = toolPayload(payload);
  const toolCallId = toolCallIdFrom(
    payload,
    `permission-${event.interactionId}`,
  );
  const projection = projectPermissionRequest(
    timeline,
    {
      ...tool,
      toolCallId,
      ...(stringValue(tool.title) ? {} : { title: "工具调用" }),
    },
    event.interactionId,
    permissionOptions(wireValue(payload, "options", "options")),
  );
  return { projection: { timeline: projection.timeline }, handled: true };
};

/**
 * Extract the stable permission identity from a normalized Pi/ACP event.
 * Keeping this beside the projection code means the Pi store and the legacy
 * ACP store use the same title/command key when looking up persisted rules.
 */
export const permissionRequestDetailsForEvent = (
  envelope: AgentEventEnvelope,
): PermissionRequestDetails | undefined => {
  const event = envelope.event;
  if (event.type !== "interaction.requested" || event.kind !== "permission") {
    return undefined;
  }
  const payload = interactionPayload(event);
  const tool = toolPayload(payload);
  const toolCallId = toolCallIdFrom(
    payload,
    `permission-${event.interactionId}`,
  );
  const options = permissionOptions(wireValue(payload, "options", "options"));
  const projected = projectPermissionRequest(
    [],
    { ...tool, toolCallId },
    event.interactionId,
    options,
  );
  return {
    interactionId: event.interactionId,
    toolCallId: projected.toolCallId,
    title: projected.title,
    command: projected.command,
    options,
  };
};

const planContent = (payload: RecordValue): string =>
  stringValue(payload.planContent) ??
  stringValue(payload.plan_content) ??
  stringValue(payload.content) ??
  stringValue(payload.plan) ??
  "Melody 没有返回计划内容。";

const planProjection = (
  timeline: TimelineEntry[],
  event: InteractionRequestEvent,
): InteractionProjectionResult => {
  const payload = interactionPayload(event);
  const toolCallId = toolCallIdFrom(payload, event.interactionId);
  const requestId =
    rpcId(wireValue(payload, "requestId", "request_id")) ?? event.interactionId;
  return {
    projection: {
      timeline: upsertPlanApproval(timeline, {
        content: planContent(payload),
        requestId,
        toolCallId,
      }),
    },
    handled: true,
  };
};

const questionProjection = (
  timeline: TimelineEntry[],
  envelope: AgentEventEnvelope,
  event: InteractionRequestEvent,
): InteractionProjectionResult => {
  const payload = interactionPayload(event);
  const params: RecordValue = { ...payload };
  if (envelope.sessionId && !wireValue(params, "sessionId", "session_id")) {
    params.sessionId = envelope.sessionId;
  }
  if (!wireValue(params, "toolCallId", "tool_call_id")) {
    params.toolCallId = event.interactionId;
  }
  const request = parseUserQuestionRequest(
    {
      id: event.interactionId,
      method: "x.ai/ask_user_question",
      params,
    } satisfies AcpEnvelope,
    envelope.sessionId,
  );
  if (!request) {
    return {
      projection: { timeline },
      handled: false,
      reason: "question payload 没有可显示的问题。",
    };
  }
  return {
    projection: { timeline: questionEntryForRequest(timeline, request) },
    handled: true,
  };
};

const resolutionObject = (payload: RecordValue): RecordValue =>
  recordValue(payload.resolution) ?? payload;

const outcomeValue = (payload: RecordValue): string | undefined => {
  const resolution = resolutionObject(payload);
  const nested = recordValue(resolution.outcome);
  return (
    stringValue(nested?.outcome) ??
    stringValue(resolution.outcome) ??
    stringValue(resolution.status) ??
    stringValue(payload.outcome) ??
    stringValue(payload.status)
  )?.toLowerCase();
};

const optionIdFrom = (payload: RecordValue): string | undefined => {
  const resolution = resolutionObject(payload);
  const nested = recordValue(resolution.outcome);
  return (
    stringValue(nested?.optionId) ??
    stringValue(nested?.option_id) ??
    stringValue(resolution.optionId) ??
    stringValue(resolution.option_id)
  );
};

const findTool = (
  timeline: TimelineEntry[],
  interactionId: string,
  payload: RecordValue,
):
  | { index: number; entry: Extract<TimelineEntry, { kind: "tool" }> }
  | undefined => {
  const explicitToolCallId = toolCallIdFrom(payload, "");
  const index = timeline.findIndex((entry) => {
    if (entry.kind !== "tool") return false;
    return (
      String(entry.permissionRequestId) === interactionId ||
      String(entry.question?.requestId) === interactionId ||
      (explicitToolCallId !== "" && entry.toolCallId === explicitToolCallId)
    );
  });
  const entry = timeline[index];
  return index >= 0 && entry?.kind === "tool" ? { index, entry } : undefined;
};

const permissionResolution = (
  timeline: TimelineEntry[],
  event: InteractionResolutionEvent,
): InteractionProjectionResult => {
  const payload = interactionPayload(event);
  const found = findTool(timeline, event.interactionId, payload);
  if (!found || found.entry.question) {
    return {
      projection: { timeline },
      handled: false,
      reason: "没有找到对应的权限请求。",
    };
  }
  const outcome = outcomeValue(payload);
  const selected = optionIdFrom(payload);
  const selectedOption = selected
    ? found.entry.permissionOptions?.find(
        (option) => option.optionId === selected,
      )
    : undefined;
  const allowed =
    event.type === "interaction.resolved" &&
    (outcome === "allowed" ||
      outcome === "approved" ||
      (outcome === "selected" && selectedOption?.kind.startsWith("allow")));
  const permission: "allowed" | "denied" = allowed ? "allowed" : "denied";
  const status: "cancelled" | "completed" = allowed ? "completed" : "cancelled";
  const nextTimeline = timeline.map((entry, index) =>
    index === found.index && entry.kind === "tool"
      ? {
          ...entry,
          permission,
          status,
          ...(event.type === "interaction.expired"
            ? { output: "交互已过期。" }
            : {}),
        }
      : entry,
  );
  return { projection: { timeline: nextTimeline }, handled: true };
};

const planResolution = (
  timeline: TimelineEntry[],
  event: InteractionResolutionEvent,
): InteractionProjectionResult => {
  const payload = interactionPayload(event);
  const explicitToolCallId = toolCallIdFrom(payload, "");
  const entry = timeline.find(
    (item) =>
      item.kind === "plan" &&
      (String(item.requestId) === event.interactionId ||
        (explicitToolCallId !== "" && item.toolCallId === explicitToolCallId)),
  );
  if (!entry || entry.kind !== "plan") {
    return {
      projection: { timeline },
      handled: false,
      reason: "没有找到对应的计划审批。",
    };
  }
  const outcome = outcomeValue(payload);
  const status =
    event.type === "interaction.expired" ||
    outcome === "cancelled" ||
    outcome === "canceled" ||
    outcome === "abandoned" ||
    outcome === "expired"
      ? "abandoned"
      : outcome === "approved" || outcome === "accepted"
        ? "approved"
        : "changes-requested";
  return {
    projection: {
      timeline: settlePlanApproval(timeline, entry.id, status),
    },
    handled: true,
  };
};

const questionResponse = (
  payload: RecordValue,
): AgentQuestionResponse | undefined => {
  const resolution = resolutionObject(payload);
  const outcome = outcomeValue(payload);
  if (outcome === "accepted") {
    const answers = objectJson(resolution.answers);
    if (!answers) return undefined;
    const normalizedAnswers = Object.fromEntries(
      Object.entries(answers).map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [],
      ]),
    );
    const annotations = objectJson(resolution.annotations) as
      Record<string, AgentQuestionAnnotation> | undefined;
    return {
      outcome: "accepted",
      answers: normalizedAnswers,
      ...(annotations ? { annotations } : {}),
    };
  }
  if (outcome === "chat_about_this" || outcome === "skip_interview") {
    const partial = objectJson(
      wireValue(resolution, "partialAnswers", "partial_answers"),
    );
    return {
      outcome,
      partialAnswers: Object.fromEntries(
        Object.entries(partial ?? {}).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : [],
        ),
      ),
    };
  }
  if (
    outcome === "cancelled" ||
    outcome === "canceled" ||
    outcome === "expired"
  ) {
    return { outcome: "cancelled" };
  }
  return undefined;
};

const questionResolution = (
  timeline: TimelineEntry[],
  event: InteractionResolutionEvent,
): InteractionProjectionResult => {
  const payload = interactionPayload(event);
  const found = findTool(timeline, event.interactionId, payload);
  if (!found || !found.entry.question) {
    return {
      projection: { timeline },
      handled: false,
      reason: "没有找到对应的问题请求。",
    };
  }
  const response =
    event.type === "interaction.expired"
      ? ({ outcome: "cancelled" } satisfies AgentQuestionResponse)
      : questionResponse(payload);
  if (!response) {
    return {
      projection: { timeline },
      handled: false,
      reason: "question resolution 没有可识别的 outcome。",
    };
  }
  return {
    projection: {
      timeline: updateQuestionEntry(timeline, found.entry.id, response),
    },
    handled: true,
  };
};

/** Project a normalized interaction into the existing approval/question rows. */
export const projectInteractionEvent = (
  timeline: TimelineEntry[],
  envelope: AgentEventEnvelope,
): InteractionProjectionResult => {
  const event = envelope.event;
  if (event.type === "interaction.requested") {
    const requestEvent = event as InteractionRequestEvent;
    if (requestEvent.kind === "permission") {
      return permissionProjection(timeline, requestEvent);
    }
    if (requestEvent.kind === "plan") {
      return planProjection(timeline, requestEvent);
    }
    return questionProjection(timeline, envelope, requestEvent);
  }
  if (
    event.type === "interaction.resolved" ||
    event.type === "interaction.expired"
  ) {
    const resolutionEvent = event as InteractionResolutionEvent;
    if (resolutionEvent.kind === "permission") {
      return permissionResolution(timeline, resolutionEvent);
    }
    if (resolutionEvent.kind === "plan") {
      return planResolution(timeline, resolutionEvent);
    }
    return questionResolution(timeline, resolutionEvent);
  }
  return {
    projection: { timeline },
    handled: false,
    reason: "不是交互事件。",
  };
};
