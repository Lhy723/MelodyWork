import type { TimelineEntry } from "@/domain/acp";

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

export const parseTimelineProjection = (
  timelineJson?: string,
): TimelineEntry[] => {
  if (!timelineJson) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(timelineJson);
    return Array.isArray(value) ? (value as TimelineEntry[]) : [];
  } catch {
    return [];
  }
};

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
    ? parseTimelineProjection(timelineJson)
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
