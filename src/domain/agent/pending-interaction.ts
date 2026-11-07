import type { TimelineEntry } from "../acp.ts";
import { questionRequestKey } from "../user-question.ts";

export type PendingInteractionKind = "permission" | "plan" | "question";

export interface PendingInteraction {
  /** Stable identity for dedupe across re-renders and re-projections. */
  key: string;
  kind: PendingInteractionKind;
}

/**
 * Precedence when several decisions are pending at once. Permission wins: it
 * blocks the next tool call and its request is the least self-explanatory, so
 * it is the one the user most needs to notice. A plan approval is a whole-turn
 * decision, while a question already explains itself in the timeline.
 */
export const PENDING_INTERACTION_PRECEDENCE: readonly PendingInteractionKind[] =
  ["permission", "plan", "question"];

/** User-facing label for each reason the agent is blocked on the user. */
export const PENDING_INTERACTION_LABELS: Record<
  PendingInteractionKind,
  string
> = {
  permission: "等待你的确认",
  plan: "等待计划确认",
  question: "等待你的回答",
};

/** Product-session identity needed to resolve a runtime timeline key. */
export interface PendingSessionIdentity {
  id: string;
  acpSessionId?: string | null;
}

export interface PendingSessionSources {
  /** Product id of the session whose timeline is currently visible. */
  localSessionId?: string;
  timeline: readonly TimelineEntry[];
  backgroundTimelines: Readonly<Record<string, readonly TimelineEntry[]>>;
  /** Product sessions used to map a runtime key back to its product id. */
  sessions: readonly PendingSessionIdentity[];
}

/**
 * Every decision the agent is blocked on, in timeline order, deduped by key.
 * Pure: callers own the timeline, and the input is never mutated.
 */
export const pendingInteractions = (
  timeline: readonly TimelineEntry[],
): PendingInteraction[] => {
  const pending: PendingInteraction[] = [];
  const seen = new Set<string>();
  const push = (key: string, kind: PendingInteractionKind) => {
    if (seen.has(key)) return;
    seen.add(key);
    pending.push({ key, kind });
  };

  for (const entry of timeline) {
    if (entry.kind === "plan") {
      if (
        entry.status === "awaiting-approval" &&
        entry.requestId !== undefined
      ) {
        push(`plan:${String(entry.requestId)}`, "plan");
      }
      continue;
    }
    if (entry.kind !== "tool") continue;
    if (
      entry.permission === "pending" &&
      entry.permissionRequestId !== undefined
    ) {
      push(`permission:${String(entry.permissionRequestId)}`, "permission");
    }
    if (entry.question?.outcome === "pending") {
      push(`question:${questionRequestKey(entry.question)}`, "question");
    }
  }
  return pending;
};

/** The single most blocking pending interaction, or `undefined` when idle. */
export const pendingInteractionKind = (
  timeline: readonly TimelineEntry[],
): PendingInteractionKind | undefined => {
  const kinds = new Set(pendingInteractions(timeline).map(({ kind }) => kind));
  return PENDING_INTERACTION_PRECEDENCE.find((kind) => kinds.has(kind));
};

/**
 * Resolve a `backgroundTimelines` key to the product session it belongs to.
 *
 * Background timelines are keyed by the event identity
 * (`streamSessionId ?? sessionId`). Pi emits the product session id, so an
 * exact `id` match resolves it; the legacy ACP engine emits its native ACP id,
 * which is persisted on `SessionRecord.acpSessionId`. Nested task streams
 * (`streamSessionId` of a subagent) and any other key that matches neither are
 * deliberately dropped instead of being attributed to an unrelated session.
 */
export const productSessionIdForRuntimeKey = (
  runtimeSessionId: string,
  sessions: readonly PendingSessionIdentity[],
): string | undefined =>
  sessions.find((session) => session.id === runtimeSessionId)?.id ??
  sessions.find((session) => session.acpSessionId === runtimeSessionId)?.id;

const moreBlockingKind = (
  current: PendingInteractionKind | undefined,
  candidate: PendingInteractionKind,
) => {
  if (current === undefined) return candidate;
  return PENDING_INTERACTION_PRECEDENCE.indexOf(current) <=
    PENDING_INTERACTION_PRECEDENCE.indexOf(candidate)
    ? current
    : candidate;
};

export type PendingNotificationTarget = "approval" | "question";

export interface PendingNotificationCandidate extends PendingInteraction {
  /** Background timeline key that produced this candidate, if not visible. */
  runtimeSessionId?: string;
}

export interface PendingNotificationSources {
  timeline: readonly TimelineEntry[];
  backgroundTimelines: Readonly<Record<string, readonly TimelineEntry[]>>;
  /** `approval` covers permission and plan gates; `question` covers questions. */
  target: PendingNotificationTarget;
}

/**
 * Collect notification targets from the visible timeline and every background
 * timeline. Approvals in the background are otherwise silent, so a blocked
 * background session would look like it is still working. The visible timeline
 * wins for a duplicate key, and a resolved interaction is never reported.
 */
export const pendingNotificationCandidates = ({
  timeline,
  backgroundTimelines,
  target,
}: PendingNotificationSources): PendingNotificationCandidate[] => {
  const candidates: PendingNotificationCandidate[] = pendingInteractions(
    timeline,
  ).filter(({ kind }) =>
    target === "question" ? kind === "question" : kind !== "question",
  );
  const seen = new Set(candidates.map(({ key }) => key));
  for (const [runtimeSessionId, entries] of Object.entries(
    backgroundTimelines,
  )) {
    for (const interaction of pendingInteractions(entries)) {
      if (
        target === "question"
          ? interaction.kind !== "question"
          : interaction.kind === "question"
      ) {
        continue;
      }
      if (seen.has(interaction.key)) continue;
      seen.add(interaction.key);
      candidates.push({ ...interaction, runtimeSessionId });
    }
  }
  return candidates;
};

/**
 * Map each product session id to the decision it is blocked on. The visible
 * timeline is authoritative for the active session; background timelines
 * contribute only sessions that can be resolved to a product id, and an
 * interaction already reported by the visible timeline is not counted twice.
 */
export const pendingInteractionsBySession = (
  sources: PendingSessionSources,
): Record<string, PendingInteractionKind> => {
  const kinds: Record<string, PendingInteractionKind> = {};
  const { localSessionId, timeline, backgroundTimelines, sessions } = sources;

  const activeKind = pendingInteractionKind(timeline);
  if (localSessionId && activeKind) {
    kinds[localSessionId] = activeKind;
  }

  for (const [runtimeSessionId, entries] of Object.entries(
    backgroundTimelines,
  )) {
    const productSessionId = productSessionIdForRuntimeKey(
      runtimeSessionId,
      sessions,
    );
    if (!productSessionId || productSessionId === localSessionId) continue;
    const kind = pendingInteractionKind(entries);
    if (!kind) continue;
    kinds[productSessionId] = moreBlockingKind(kinds[productSessionId], kind);
  }
  return kinds;
};
