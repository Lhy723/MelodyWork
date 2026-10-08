import type { AgentEventEnvelope } from "./contract.ts";

/**
 * In-memory representation of the durable event cursor.
 *
 * The Rust host will persist the same fields once the worker transport is
 * introduced. Keeping the transition pure here makes replay and duplicate
 * handling testable without starting a model or a Tauri process.
 */
export interface AgentEventCheckpoint {
  workerEpoch?: string;
  lastSeq: number;
  eventIds: string[];
}

export type AgentEventAcceptanceReason =
  | "accepted"
  | "duplicate"
  | "stale-worker"
  | "missing-worker-epoch"
  | "out-of-order"
  | "invalid-event-id"
  | "invalid-seq";

export interface AgentEventAcceptance {
  accepted: boolean;
  reason: AgentEventAcceptanceReason;
  checkpoint: AgentEventCheckpoint;
}

export interface AgentEventCheckpointOptions {
  /** Bound memory used by the exact event-id replay set. */
  maxEventIds?: number;
  /** Legacy adapters may omit workerEpoch until the worker boundary exists. */
  allowMissingWorkerEpoch?: boolean;
}

const DEFAULT_MAX_EVENT_IDS = 256;

const boundedEventIds = (
  eventIds: readonly string[],
  maxEventIds: number,
): string[] => {
  if (eventIds.length <= maxEventIds) return [...eventIds];
  return eventIds.slice(eventIds.length - maxEventIds);
};

const normalizedMaxEventIds = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_EVENT_IDS;

export const createAgentEventCheckpoint = (
  workerEpoch?: string,
): AgentEventCheckpoint => ({
  ...(workerEpoch ? { workerEpoch } : {}),
  lastSeq: -1,
  eventIds: [],
});

/**
 * Start a new worker generation. Events from the previous process must not be
 * allowed to advance the new stream's cursor, so the sequence and replay set
 * are reset together with the epoch.
 */
export const resetAgentEventCheckpoint = (
  _checkpoint: AgentEventCheckpoint,
  workerEpoch?: string,
): AgentEventCheckpoint => createAgentEventCheckpoint(workerEpoch);

/**
 * Accept one normalized event and return a new checkpoint.
 *
 * This function deliberately does not mutate its input. A caller can persist
 * the returned checkpoint only after the event has been committed to its
 * product log; rejecting an event therefore cannot accidentally advance the
 * recovery cursor.
 */
export const acceptAgentEvent = (
  checkpoint: AgentEventCheckpoint,
  event: AgentEventEnvelope,
  options: AgentEventCheckpointOptions = {},
): AgentEventAcceptance => {
  const maxEventIds = normalizedMaxEventIds(options.maxEventIds);
  const current = {
    ...checkpoint,
    eventIds: boundedEventIds(checkpoint.eventIds, maxEventIds),
  };
  const eventId = event.eventId.trim();
  if (!eventId) {
    return {
      accepted: false,
      reason: "invalid-event-id",
      checkpoint: current,
    };
  }

  if (current.workerEpoch && !event.workerEpoch) {
    if (!options.allowMissingWorkerEpoch) {
      return {
        accepted: false,
        reason: "missing-worker-epoch",
        checkpoint: current,
      };
    }
  }
  if (
    current.workerEpoch &&
    event.workerEpoch &&
    current.workerEpoch !== event.workerEpoch
  ) {
    return {
      accepted: false,
      reason: "stale-worker",
      checkpoint: current,
    };
  }

  if (current.eventIds.includes(eventId)) {
    return {
      accepted: false,
      reason: "duplicate",
      checkpoint: current,
    };
  }

  if (
    event.seq !== undefined &&
    (!Number.isSafeInteger(event.seq) || event.seq < 0)
  ) {
    return {
      accepted: false,
      reason: "invalid-seq",
      checkpoint: current,
    };
  }
  if (event.seq !== undefined && event.seq <= current.lastSeq) {
    return {
      accepted: false,
      reason: "out-of-order",
      checkpoint: current,
    };
  }

  const nextEventIds = [...current.eventIds, eventId];
  return {
    accepted: true,
    reason: "accepted",
    checkpoint: {
      ...(current.workerEpoch || event.workerEpoch
        ? { workerEpoch: current.workerEpoch ?? event.workerEpoch }
        : {}),
      lastSeq: event.seq ?? current.lastSeq,
      eventIds: boundedEventIds(nextEventIds, maxEventIds),
    },
  };
};
