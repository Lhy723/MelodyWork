import type {
  AgentAssistantMetadata,
  AgentEvent,
  AgentEventEnvelope,
  AgentUsage,
  JsonObject,
} from "./contract.ts";
import type {
  AgentBillingUsage,
  AgentSubagent,
  TimelineEntry,
} from "../acp.ts";
import {
  appendSessionError,
  applySessionUpdate,
  settleSessionProjection,
  type SessionUpdateResult,
} from "../session-projection-updates.ts";
import { projectInteractionEvent } from "./interaction-projection.ts";
import {
  projectPiModelCatalog,
  type PiModelOptionsProjection,
} from "./pi-model-options.ts";
import {
  projectSubagentEvent,
  type SubagentProjectionResult,
} from "./subagent-projection.ts";

/**
 * State kept while a normalized run is projected into the legacy timeline
 * shape. The maps are intentionally in-memory only: the durable event cursor
 * and event log remain the Host's responsibility.
 */
/**
 * One Host-owned monitor line, kept out of the chat timeline so the UI can
 * present a stream without diluting message history.
 */
export interface AgentMonitorNotification {
  taskId: string;
  description: string;
  line: string;
  sequence: number;
  truncated: boolean;
  receivedAt: number;
}

/** Bounded per-session notification ring; a long monitor must not grow forever. */
export const MAX_AGENT_MONITOR_NOTIFICATIONS = 200;

export interface AgentEventProjectionState {
  timeline: TimelineEntry[];
  subagents: ReadonlyMap<string, AgentSubagent>;
  latestUsage?: AgentUsage;
  messageTimelineIds: ReadonlyMap<string, string>;
  deltaOffsets: ReadonlyMap<string, number>;
  notifications: AgentMonitorNotification[];
  /**
   * Counts Host-owned schedule changes for this session.
   *
   * The schedule inventory itself lives in the Host database, so the renderer
   * only needs a reason to re-read it; mirroring the rows here would create a
   * second source of truth that could drift from the dispatcher.
   */
  scheduleRevision: number;
}

export const createAgentEventProjectionState = (
  timeline: TimelineEntry[] = [],
  subagents: ReadonlyMap<string, AgentSubagent> = new Map(),
  notifications: AgentMonitorNotification[] = [],
): AgentEventProjectionState => ({
  timeline,
  subagents,
  messageTimelineIds: new Map(),
  deltaOffsets: new Map(),
  notifications,
  scheduleRevision: 0,
});

export const appendMonitorNotification = (
  notifications: AgentMonitorNotification[],
  event: Extract<AgentEvent, { type: "task.notification" }>,
  receivedAt: number,
): AgentMonitorNotification[] => {
  const next = [
    ...notifications,
    {
      taskId: event.taskId,
      description: event.description,
      line: event.line,
      sequence: event.sequence,
      truncated: event.truncated === true,
      receivedAt,
    },
  ];
  return next.length > MAX_AGENT_MONITOR_NOTIFICATIONS
    ? next.slice(next.length - MAX_AGENT_MONITOR_NOTIFICATIONS)
    : next;
};

export type AgentProjectionLifecycle =
  | "run-accepted"
  | "run-started"
  | "run-finished"
  | "runtime-warning"
  | "runtime-error"
  | "session-compacting"
  | "session-compacted";

export type AgentProjectionDiagnostic =
  | {
      kind: "session-mismatch";
      eventType: string;
      expectedSessionId: string;
      actualSessionId?: string;
    }
  | {
      kind: "invalid-event";
      eventType?: string;
      reason: string;
    }
  | {
      kind: "duplicate-message-delta";
      eventType: "message.delta";
      messageId: string;
      partId: string;
      receivedOffset: number;
      expectedOffset: number;
    }
  | {
      kind: "message-offset-gap";
      eventType: "message.delta";
      messageId: string;
      partId: string;
      receivedOffset: number;
      expectedOffset: number;
    }
  | {
      kind: "invalid-context";
      eventType: "context.updated";
      tokens: number | null;
      limit: number | null;
    }
  | {
      kind: "invalid-interaction";
      eventType:
        | "interaction.requested"
        | "interaction.resolved"
        | "interaction.expired";
      interactionKind: "permission" | "question" | "plan";
      reason: string;
    }
  | {
      kind: "invalid-subagent";
      eventType: "task.changed" | "subagent.changed";
      reason: string;
    }
  | {
      kind: "protocol-unhandled";
      eventType: "protocol.unhandled";
      method?: string;
      payload: JsonObject;
    }
  | {
      kind: "unknown-event";
      eventType: string;
    };

/**
 * A projection result keeps the existing SessionUpdateResult intact while
 * carrying the small amount of engine-neutral metadata that the store needs
 * to route model catalogs, interactions, tasks and diagnostics.
 */
export interface AgentEventProjectionResult {
  event: AgentEventEnvelope;
  state: AgentEventProjectionState;
  projection: SessionUpdateResult;
  billingUsage?: AgentBillingUsage;
  contextConfidence?: AgentEventProjectionContextConfidence;
  lifecycle?: AgentProjectionLifecycle;
  /** Known events that do not own a timeline row. */
  auxiliaryEvent?: AgentEvent;
  /** A runtime model snapshot projected into the product model-picker shape. */
  modelCatalogProjection?: PiModelOptionsProjection;
  /** Normalized subagent events projected into the shared subagent map. */
  subagentProjection?: SubagentProjectionResult;
  diagnostic?: AgentProjectionDiagnostic;
  /** True when the event was deliberately not applied to this session. */
  ignored?: boolean;
}

export type AgentEventProjectionContextConfidence =
  "measured" | "estimated" | "unknown";

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const usageFields = [
  "inputTokens",
  "outputTokens",
  "cachedReadTokens",
  "reasoningTokens",
  "modelCalls",
  "apiDurationMs",
] as const;

const mergeUsage = (
  previous: AgentUsage | undefined,
  next: AgentUsage,
): AgentUsage => ({
  ...(previous ?? {}),
  ...next,
  confidence: next.confidence,
  ...(next.cost !== undefined
    ? { cost: next.cost }
    : previous?.cost !== undefined
      ? { cost: previous.cost }
      : {}),
});

/** Pi reports USD in dollars while the product stores cost in 1e-10 USD ticks. */
const USD_TICKS_PER_DOLLAR = 10_000_000_000;

const toBillingUsage = (usage: AgentUsage): AgentBillingUsage => {
  const values = Object.fromEntries(
    usageFields.map((field) => [field, finiteNonNegative(usage[field])]),
  ) as Record<(typeof usageFields)[number], number | undefined>;
  const usageIsIncomplete =
    usage.confidence !== "measured" ||
    usageFields.some((field) => values[field] === undefined);
  const amount = finiteNonNegative(usage.cost?.amount);
  const currency =
    typeof usage.cost?.currency === "string"
      ? usage.cost.currency.toUpperCase()
      : undefined;
  const hasUsdCost =
    amount !== undefined &&
    currency === "USD" &&
    Number.isSafeInteger(amount * USD_TICKS_PER_DOLLAR);
  const costUsdTicks = hasUsdCost
    ? Math.round(amount * USD_TICKS_PER_DOLLAR)
    : undefined;

  return {
    inputTokens: values.inputTokens ?? 0,
    outputTokens: values.outputTokens ?? 0,
    cachedReadTokens: values.cachedReadTokens ?? 0,
    reasoningTokens: values.reasoningTokens ?? 0,
    modelCalls: values.modelCalls ?? 0,
    apiDurationMs: values.apiDurationMs ?? 0,
    usageIsIncomplete,
    // Absence of a convertible USD total is not evidence that the request was
    // free. Keep the cost field partial so statistics do not manufacture zero.
    costIsPartial: !hasUsdCost,
    ...(costUsdTicks !== undefined ? { costUsdTicks } : {}),
  };
};

const usageUpdate = (usage: AgentBillingUsage): JsonObject => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedReadTokens: usage.cachedReadTokens,
  reasoningTokens: usage.reasoningTokens,
  modelCalls: usage.modelCalls,
  apiDurationMs: usage.apiDurationMs,
  usageIsIncomplete: usage.usageIsIncomplete,
  costIsPartial: usage.costIsPartial,
  ...(usage.costUsdTicks !== undefined
    ? { costUsdTicks: usage.costUsdTicks }
    : {}),
});

const unchanged = (
  state: AgentEventProjectionState,
  event: AgentEventEnvelope,
  extras: Omit<
    AgentEventProjectionResult,
    "event" | "state" | "projection"
  > = {},
): AgentEventProjectionResult => ({
  event,
  state,
  projection: { timeline: state.timeline },
  ...extras,
});

const withProjection = (
  state: AgentEventProjectionState,
  event: AgentEventEnvelope,
  projection: SessionUpdateResult,
  patch: Partial<AgentEventProjectionState> = {},
  extras: Omit<
    AgentEventProjectionResult,
    "event" | "state" | "projection"
  > = {},
): AgentEventProjectionResult => ({
  event,
  state: {
    ...state,
    ...patch,
    timeline: projection.timeline,
  },
  projection,
  ...extras,
});

const latestAssistantAfterLatestUser = (timeline: TimelineEntry[]) => {
  let latestUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry?.kind === "message" && entry.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  for (let index = timeline.length - 1; index > latestUserIndex; index -= 1) {
    const entry = timeline[index];
    if (entry?.kind === "message" && entry.role === "assistant") {
      return index;
    }
  }
  return -1;
};

/** Replace a streamed assistant row with Pi's final complete message. */
const completeAssistantMessage = (
  timeline: TimelineEntry[],
  messageTimelineId: string | undefined,
  content: string | undefined,
  assistantMetadata: AgentAssistantMetadata | undefined,
  nativeEntryId: string | undefined,
): TimelineEntry[] => {
  const mappedIndex = messageTimelineId
    ? timeline.findIndex(
        (entry) =>
          entry.id === messageTimelineId &&
          entry.kind === "message" &&
          entry.role === "assistant",
      )
    : -1;
  const index =
    mappedIndex >= 0 ? mappedIndex : latestAssistantAfterLatestUser(timeline);
  if (index < 0) {
    return settleSessionProjection(timeline);
  }
  const now = Date.now();
  return timeline.map((entry, entryIndex) =>
    entryIndex === index && entry.kind === "message"
      ? {
          ...entry,
          ...(content !== undefined ? { content } : {}),
          ...(nativeEntryId ? { nativeEntryId } : {}),
          ...(assistantMetadata
            ? {
                assistantMetadata: {
                  ...(entry.assistantMetadata ?? {}),
                  ...assistantMetadata,
                },
              }
            : {}),
          streaming: false,
          completedAt: entry.completedAt ?? now,
        }
      : entry,
  );
};

const messageMapAfterDelta = (
  map: ReadonlyMap<string, string>,
  messageId: string,
  timeline: TimelineEntry[],
): Map<string, string> => {
  const next = new Map(map);
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (
      entry?.kind === "message" &&
      entry.role === "assistant" &&
      entry.streaming
    ) {
      next.set(messageId, entry.id);
      break;
    }
  }
  return next;
};

const removeMessageState = (
  state: AgentEventProjectionState,
  messageId: string,
): Pick<AgentEventProjectionState, "messageTimelineIds" | "deltaOffsets"> => {
  const messageTimelineIds = new Map(state.messageTimelineIds);
  messageTimelineIds.delete(messageId);
  const prefix = `${messageId}\u0000`;
  const deltaOffsets = new Map(
    [...state.deltaOffsets].filter(([key]) => !key.startsWith(prefix)),
  );
  return { messageTimelineIds, deltaOffsets };
};

const toolProjection = (
  timeline: TimelineEntry[],
  event: Extract<
    AgentEvent,
    {
      type:
        "tool.requested" | "tool.started" | "tool.progress" | "tool.finished";
    }
  >,
  eventId: string,
): SessionUpdateResult => {
  const status =
    event.type === "tool.requested"
      ? (event.status ?? "pending")
      : event.type === "tool.finished"
        ? event.status === "cancelled"
          ? "cancelled"
          : event.error
            ? "failed"
            : (event.status ?? "completed")
        : (event.status ?? "running");
  const update: JsonObject = {
    sessionUpdate:
      event.type === "tool.requested" ? "tool_call" : "tool_call_update",
    toolCallId: event.toolCallId,
    ...(event.toolName ? { title: event.toolName } : {}),
    status,
    ...(event.activity ? { rawInput: event.activity } : {}),
    ...(event.output !== undefined
      ? { rawOutput: event.output }
      : event.error?.message
        ? { rawOutput: event.error.message }
        : {}),
  };
  return applySessionUpdate(timeline, update, eventId);
};

const isValidContext = (
  tokens: number | null,
  limit: number | null,
): tokens is number =>
  finiteNonNegative(tokens) !== undefined &&
  finiteNonNegative(limit) !== undefined &&
  (limit as number) > 0;

const resetRunState = (
  projection: SessionUpdateResult,
): Partial<AgentEventProjectionState> => ({
  latestUsage: undefined,
  messageTimelineIds: new Map(),
  deltaOffsets: new Map(),
  timeline: projection.timeline,
});

/**
 * Project one normalized AgentEvent into the existing product timeline.
 *
 * This reducer is engine-neutral. It deliberately does not call Pi, Tauri or
 * Zustand, so both the live Pi stream and the Host event-log replay can use
 * exactly the same projection semantics.
 */
export const projectAgentEvent = (
  state: AgentEventProjectionState,
  event: AgentEventEnvelope,
  expectedSessionId?: string,
): AgentEventProjectionResult => {
  const normalizedEvent = event.event;
  const eventType = normalizedEvent?.type;
  if (typeof event.eventId !== "string" || !event.eventId.trim()) {
    return unchanged(state, event, {
      ignored: true,
      diagnostic: {
        kind: "invalid-event",
        eventType,
        reason: "eventId must not be empty",
      },
    });
  }
  if (
    expectedSessionId &&
    (event.streamSessionId ?? event.sessionId) !== undefined &&
    (event.streamSessionId ?? event.sessionId) !== expectedSessionId
  ) {
    return unchanged(state, event, {
      ignored: true,
      diagnostic: {
        kind: "session-mismatch",
        eventType,
        expectedSessionId,
        actualSessionId: event.streamSessionId ?? event.sessionId,
      },
    });
  }

  if (
    eventType?.startsWith("tool.") &&
    "toolName" in normalizedEvent &&
    typeof normalizedEvent.toolName === "string" &&
    normalizedEvent.toolName.startsWith("melody_internal_")
  ) {
    return unchanged(state, event, { ignored: true });
  }

  if (eventType === "run.accepted") {
    const projection = { timeline: state.timeline };
    return withProjection(state, event, projection, resetRunState(projection), {
      lifecycle: "run-accepted",
    });
  }

  if (eventType === "run.started") {
    const projection: SessionUpdateResult = {
      timeline: state.timeline,
      streaming: true,
    };
    return withProjection(state, event, projection, resetRunState(projection), {
      lifecycle: "run-started",
    });
  }

  if (eventType === "run.queue_updated") {
    // Queue contents are owned by the native engine. They do not create a
    // timeline row, but keeping the normalized event handled makes the
    // snapshot available to live/replay consumers without reporting a false
    // protocol gap.
    return unchanged(state, event, { auxiliaryEvent: normalizedEvent });
  }

  if (eventType === "run.finished") {
    const billingUsage = state.latestUsage
      ? toBillingUsage(state.latestUsage)
      : undefined;
    if (
      normalizedEvent.status === "cancelled" ||
      normalizedEvent.status === "interrupted"
    ) {
      const projection: SessionUpdateResult = {
        timeline: settleSessionProjection(state.timeline),
        completed: true,
      };
      return withProjection(
        state,
        event,
        projection,
        resetRunState(projection),
        {
          billingUsage,
          lifecycle: "run-finished",
        },
      );
    }
    const update: JsonObject = {
      sessionUpdate: "turn_completed",
      stopReason:
        normalizedEvent.stopReason ??
        (normalizedEvent.status === "failed" ? "error" : "end_turn"),
      ...(normalizedEvent.error?.message
        ? { agentResult: normalizedEvent.error.message }
        : {}),
      ...(billingUsage ? { usage: usageUpdate(billingUsage) } : {}),
    };
    const projection = applySessionUpdate(
      state.timeline,
      update,
      event.eventId,
    );
    return withProjection(state, event, projection, resetRunState(projection), {
      billingUsage,
      lifecycle: "run-finished",
    });
  }

  if (eventType === "message.delta") {
    const key = `${normalizedEvent.messageId}\u0000${normalizedEvent.partId}`;
    const expectedOffset = state.deltaOffsets.get(key) ?? 0;
    if (normalizedEvent.offset < expectedOffset) {
      return unchanged(state, event, {
        diagnostic: {
          kind: "duplicate-message-delta",
          eventType,
          messageId: normalizedEvent.messageId,
          partId: normalizedEvent.partId,
          receivedOffset: normalizedEvent.offset,
          expectedOffset,
        },
      });
    }
    const projection = applySessionUpdate(
      state.timeline,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: normalizedEvent.text },
      },
      event.eventId,
    );
    const deltaOffsets = new Map(state.deltaOffsets);
    deltaOffsets.set(key, normalizedEvent.offset + normalizedEvent.text.length);
    return withProjection(
      state,
      event,
      projection,
      {
        messageTimelineIds: messageMapAfterDelta(
          state.messageTimelineIds,
          normalizedEvent.messageId,
          projection.timeline,
        ),
        deltaOffsets,
      },
      {
        diagnostic:
          normalizedEvent.offset > expectedOffset
            ? {
                kind: "message-offset-gap",
                eventType,
                messageId: normalizedEvent.messageId,
                partId: normalizedEvent.partId,
                receivedOffset: normalizedEvent.offset,
                expectedOffset,
              }
            : undefined,
      },
    );
  }

  if (eventType === "thought.delta") {
    const projection = applySessionUpdate(
      state.timeline,
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: normalizedEvent.text },
      },
      event.eventId,
    );
    return withProjection(state, event, projection);
  }

  if (eventType === "message.started") {
    if (normalizedEvent.role !== "user" || !normalizedEvent.content) {
      return unchanged(state, event);
    }
    const projection = applySessionUpdate(
      state.timeline,
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: normalizedEvent.content },
      },
      event.eventId,
    );
    return withProjection(state, event, projection);
  }

  if (eventType === "message.completed") {
    if (normalizedEvent.role === "user") {
      const withUser = normalizedEvent.content
        ? applySessionUpdate(
            state.timeline,
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: normalizedEvent.content },
            },
            event.eventId,
          ).timeline
        : state.timeline;
      const projection: SessionUpdateResult = {
        timeline: settleSessionProjection(withUser),
      };
      const messageState = removeMessageState(state, normalizedEvent.messageId);
      return withProjection(state, event, projection, messageState);
    }
    const projection: SessionUpdateResult = {
      timeline: completeAssistantMessage(
        state.timeline,
        state.messageTimelineIds.get(normalizedEvent.messageId),
        normalizedEvent.content,
        normalizedEvent.assistantMetadata,
        normalizedEvent.nativeEntryId,
      ),
    };
    const messageState = removeMessageState(state, normalizedEvent.messageId);
    return withProjection(state, event, projection, messageState);
  }

  if (
    eventType === "tool.requested" ||
    eventType === "tool.started" ||
    eventType === "tool.progress" ||
    eventType === "tool.finished"
  ) {
    return withProjection(
      state,
      event,
      toolProjection(state.timeline, normalizedEvent, event.eventId),
    );
  }

  if (eventType === "usage.updated") {
    const latestUsage = mergeUsage(state.latestUsage, normalizedEvent.usage);
    return withProjection(
      state,
      event,
      { timeline: state.timeline },
      { latestUsage },
      { billingUsage: toBillingUsage(latestUsage) },
    );
  }

  if (eventType === "context.updated") {
    if (!isValidContext(normalizedEvent.tokens, normalizedEvent.limit)) {
      return unchanged(state, event, {
        contextConfidence: normalizedEvent.confidence,
        diagnostic: {
          kind: "invalid-context",
          eventType,
          tokens: normalizedEvent.tokens,
          limit: normalizedEvent.limit,
        },
      });
    }
    const projection = applySessionUpdate(
      state.timeline,
      {
        sessionUpdate: "usage_update",
        used: normalizedEvent.tokens,
        size: normalizedEvent.limit,
      },
      event.eventId,
    );
    return withProjection(
      state,
      event,
      projection,
      {},
      { contextConfidence: normalizedEvent.confidence },
    );
  }

  if (eventType === "runtime.warning") {
    return withProjection(
      state,
      event,
      {
        timeline: state.timeline,
        statusMessage: normalizedEvent.error.message,
      },
      {},
      { lifecycle: "runtime-warning", auxiliaryEvent: normalizedEvent },
    );
  }

  if (eventType === "runtime.error") {
    const timeline = appendSessionError(
      state.timeline,
      normalizedEvent.error.message,
    );
    return withProjection(
      state,
      event,
      {
        timeline,
        error: normalizedEvent.error.message,
        ...(normalizedEvent.error.scope === "run" ||
        normalizedEvent.error.scope === "session"
          ? { completed: true }
          : {}),
      },
      {},
      {
        lifecycle: "runtime-error",
        auxiliaryEvent: normalizedEvent,
      },
    );
  }

  if (eventType === "session.compacting") {
    return unchanged(state, event, {
      lifecycle: "session-compacting",
      auxiliaryEvent: normalizedEvent,
    });
  }

  if (eventType === "session.compacted") {
    return unchanged(state, event, {
      lifecycle: "session-compacted",
      auxiliaryEvent: normalizedEvent,
    });
  }

  if (eventType === "task.changed" || eventType === "subagent.changed") {
    const subagentProjection = projectSubagentEvent(
      { subagents: state.subagents },
      normalizedEvent,
      event.sessionId ?? expectedSessionId,
    );
    if (!subagentProjection.handled) {
      return unchanged(state, event, {
        auxiliaryEvent: normalizedEvent,
        subagentProjection,
        ...(subagentProjection.notApplicable
          ? {}
          : {
              diagnostic: {
                kind: "invalid-subagent" as const,
                eventType,
                reason: subagentProjection.reason,
              },
            }),
      });
    }
    return withProjection(
      state,
      event,
      { timeline: state.timeline },
      { subagents: subagentProjection.state.subagents },
      { auxiliaryEvent: normalizedEvent, subagentProjection },
    );
  }

  if (
    eventType === "interaction.requested" ||
    eventType === "interaction.resolved" ||
    eventType === "interaction.expired"
  ) {
    const interaction = projectInteractionEvent(state.timeline, event);
    if (!interaction.handled) {
      return unchanged(state, event, {
        auxiliaryEvent: normalizedEvent,
        diagnostic: {
          kind: "invalid-interaction",
          eventType,
          interactionKind: normalizedEvent.kind,
          reason: interaction.reason ?? "interaction payload 无法投影。",
        },
      });
    }
    return withProjection(
      state,
      event,
      interaction.projection,
      {},
      { auxiliaryEvent: normalizedEvent },
    );
  }

  if (eventType === "protocol.unhandled") {
    return unchanged(state, event, {
      diagnostic: {
        kind: "protocol-unhandled",
        eventType,
        ...(normalizedEvent.method ? { method: normalizedEvent.method } : {}),
        payload: normalizedEvent.payload,
      },
      auxiliaryEvent: normalizedEvent,
    });
  }

  if (
    eventType === "runtime.ready" ||
    eventType === "session.opened" ||
    eventType === "session.closed" ||
    eventType === "session.configured" ||
    eventType === "session.imported" ||
    // Host-owned schedule state is not timeline content: it is surfaced through
    // the schedule inventory rather than as a chat row, so it stays an
    // auxiliary event instead of being reported as an unknown one.
    eventType === "schedule.changed" ||
    eventType === "schedule.fired" ||
    eventType === "task.notification"
  ) {
    if (eventType === "schedule.changed" || eventType === "schedule.fired") {
      // Schedule rows are Host-owned; bump a revision so the UI re-reads the
      // inventory instead of keeping a parallel copy.
      return unchanged(
        { ...state, scheduleRevision: state.scheduleRevision + 1 },
        event,
        { auxiliaryEvent: normalizedEvent },
      );
    }
    if (eventType !== "task.notification") {
      return unchanged(state, event, { auxiliaryEvent: normalizedEvent });
    }
    // A monitor line accumulates into its own bounded feed instead of the
    // chat timeline; the UI can then show a stream without diluting messages.
    return unchanged(
      {
        ...state,
        notifications: appendMonitorNotification(
          state.notifications,
          normalizedEvent as Extract<AgentEvent, { type: "task.notification" }>,
          Date.now(),
        ),
      },
      event,
      { auxiliaryEvent: normalizedEvent },
    );
  }

  if (eventType === "runtime.models") {
    const refreshErrors = normalizedEvent.refreshErrors
      ? Object.fromEntries(
          Object.entries(normalizedEvent.refreshErrors).flatMap(
            ([key, value]) => (typeof value === "string" ? [[key, value]] : []),
          ),
        )
      : undefined;
    return unchanged(state, event, {
      auxiliaryEvent: normalizedEvent,
      modelCatalogProjection: projectPiModelCatalog({
        revision: normalizedEvent.revision,
        models: normalizedEvent.models,
        ...(refreshErrors && Object.keys(refreshErrors).length > 0
          ? { refreshErrors }
          : {}),
      }),
    });
  }

  return unchanged(state, event, {
    diagnostic: { kind: "unknown-event", eventType: String(eventType) },
  });
};
