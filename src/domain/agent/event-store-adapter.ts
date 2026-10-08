import type { AgentEventEnvelope } from "./contract.ts";
import { AgentEventProjector } from "./event-projector.ts";
import {
  createAgentEventProjectionState,
  type AgentEventProjectionResult,
} from "./event-to-session-update.ts";
import {
  projectAgentEventToStorePatch,
  type AgentProjectionStorePatch,
  type AgentProjectionStoreSnapshot,
} from "./projection-store-patch.ts";

const DEFAULT_MAX_SESSIONS = 64;

export interface AgentEventStoreAdapterOptions {
  /** Keep a bounded number of product-session projectors in memory. */
  maxSessions?: number;
}

export interface AgentEventStoreAdapterResult {
  result: AgentEventProjectionResult;
  patch: AgentProjectionStorePatch;
}

const sessionKeyFor = (
  event: AgentEventEnvelope,
  snapshot: AgentProjectionStoreSnapshot,
): string =>
  event.streamSessionId ??
  event.sessionId ??
  snapshot.currentSessionId ??
  "__unscoped-agent-runtime__";

const timelineForSession = (
  event: AgentEventEnvelope,
  snapshot: AgentProjectionStoreSnapshot,
): AgentProjectionStoreSnapshot["timeline"] => {
  if (
    (event.streamSessionId ?? event.sessionId) === undefined ||
    (event.streamSessionId ?? event.sessionId) === snapshot.currentSessionId
  ) {
    return snapshot.timeline;
  }
  const streamSessionId = event.streamSessionId ?? event.sessionId;
  return streamSessionId
    ? (snapshot.backgroundTimelines[streamSessionId] ?? [])
    : [];
};

const subagentsForSession = (
  sessionId: string,
  snapshot: AgentProjectionStoreSnapshot,
) =>
  Object.fromEntries(
    Object.entries(snapshot.subagents).filter(
      ([, subagent]) => subagent.parentSessionId === sessionId,
    ),
  );

/**
 * Own one normalized projector per product session and turn its result into a
 * renderer patch. The adapter is deliberately independent from Zustand: a
 * store, a replay inspector, or a test harness can all consume the same
 * result without duplicating session routing logic.
 */
export class AgentEventStoreAdapter {
  private readonly projectors = new Map<string, AgentEventProjector>();
  private readonly maxSessions: number;

  public constructor(options: AgentEventStoreAdapterOptions = {}) {
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
      throw new Error("maxSessions 必须是正整数。 ");
    }
    this.maxSessions = maxSessions;
  }

  public consume(
    event: AgentEventEnvelope,
    snapshot: AgentProjectionStoreSnapshot,
  ): AgentEventStoreAdapterResult {
    const key = sessionKeyFor(event, snapshot);
    let projector = this.projectors.get(key);
    if (!projector) {
      const expectedSessionId =
        event.streamSessionId ?? event.sessionId ?? snapshot.currentSessionId;
      const subagents = expectedSessionId
        ? subagentsForSession(expectedSessionId, snapshot)
        : {};
      projector = new AgentEventProjector(undefined, {
        ...(expectedSessionId ? { expectedSessionId } : {}),
        initialState: createAgentEventProjectionState(
          timelineForSession(event, snapshot),
          new Map(Object.entries(subagents)),
        ),
      });
      this.projectors.set(key, projector);
      this.evictOldestIfNeeded();
    }

    const result = projector.consume(event);
    return {
      result,
      patch: projectAgentEventToStorePatch(snapshot, result),
    };
  }

  public reset(sessionId?: string): void {
    if (sessionId) {
      this.projectors.delete(sessionId);
      return;
    }
    this.projectors.clear();
  }

  public size(): number {
    return this.projectors.size;
  }

  private evictOldestIfNeeded(): void {
    while (this.projectors.size > this.maxSessions) {
      const oldest = this.projectors.keys().next().value;
      if (oldest === undefined) return;
      this.projectors.delete(oldest);
    }
  }
}
