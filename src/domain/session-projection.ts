import type { TimelineEntry } from "@/domain/acp";

export const TIMELINE_PROJECTION_VERSION = 2;

export interface NotificationMetadata {
  eventId?: string;
  isReplay: boolean;
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

export const timelineProjectionVersion = (timeline: TimelineEntry[]) =>
  timeline.every(
    (entry) => entry.kind !== "tool" || entry.activity !== undefined,
  )
    ? TIMELINE_PROJECTION_VERSION
    : TIMELINE_PROJECTION_VERSION - 1;

export const notificationMetadata = (
  params: Record<string, unknown> | undefined,
): NotificationMetadata => {
  const value = params?._meta;
  const meta =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    eventId:
      typeof meta?.eventId === "string" ? meta.eventId : undefined,
    isReplay: meta?.isReplay === true,
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
  readonly #eventIds = new Map<
    string,
    { order: string[]; values: Set<string> }
  >();

  constructor(capacityPerSession = 4096) {
    this.capacityPerSession = capacityPerSession;
  }

  reset(sessionId: string) {
    this.#eventIds.delete(sessionId);
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
    this.#eventIds.set(sessionId, tracked);
    return true;
  }
}
