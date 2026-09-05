import type { TimelineEntry } from "./acp.ts";

type JsonObject = Record<string, unknown>;

const objectValue = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object"
    ? (value as JsonObject)
    : undefined;

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

// Melody Build emits this fire-and-forget terminal notification for clients
// that are attached directly to an agent.  It is intentionally separate from
// the durable `turn_completed` session update, so viewers must understand both
// rails in order to leave a prompt in a ready state.
const PROMPT_COMPLETE_METHODS = new Set([
  "x.ai/session/prompt_complete",
  "_x.ai/session/prompt_complete",
]);

export const isSessionUpdateMethod = (method?: string): boolean =>
  method !== undefined && SESSION_UPDATE_METHODS.has(method);

export const isPromptCompleteMethod = (method?: string): boolean =>
  method !== undefined && PROMPT_COMPLETE_METHODS.has(method);

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
  const value = params?._meta ?? params?.meta;
  const meta =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  const stringField = (camelCase: string, snakeCase: string) => {
    const value = meta?.[camelCase] ?? meta?.[snakeCase];
    return typeof value === "string" ? value : undefined;
  };
  return {
    eventId: stringField("eventId", "event_id"),
    isReplay: meta?.isReplay === true || meta?.is_replay === true,
    ...(stringField("promptId", "prompt_id")
      ? { promptId: stringField("promptId", "prompt_id") }
      : {}),
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
