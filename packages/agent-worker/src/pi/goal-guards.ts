import type { GoalStateEntryData } from "./goal-state.ts";

export interface GoalGuardObservation {
  /** Cumulative Pi session token total, when the SDK can provide it. */
  totalTokens?: number;
  /** Per-turn usage fallback for direct extension tests or older Pi builds. */
  usageTokens?: number;
  /** Revision observed at `turn_start`, used for deterministic progress checks. */
  turnRevisionAtStart?: number;
  now?: number;
}

export interface GoalGuardResult {
  state: GoalStateEntryData;
  changed: boolean;
  shouldAbort: boolean;
  reason?: "token_budget" | "stall";
  summary?: string;
}

export const finiteGuardTokens = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;

export const tokenUsageFromMessage = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const usage = (value as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const fields = [
    record.totalTokens,
    record.input,
    record.output,
    record.cacheRead,
    record.cacheWrite,
  ].map(finiteGuardTokens);
  if (fields[0] !== undefined) return fields[0];
  const sum = fields
    .slice(1)
    .reduce<number>((total, item) => total + (item ?? 0), 0);
  return sum > 0 ? sum : undefined;
};

/**
 * Apply Pi's deterministic goal safety rails at the end of a turn.
 *
 * The guard never claims to classify completion. It only accounts for the
 * measured session usage (or a per-turn fallback) and pauses a goal once its
 * explicit budget or wall-clock no-progress window is exhausted.
 */
export const enforceGoalGuards = (
  current: GoalStateEntryData,
  observation: GoalGuardObservation,
): GoalGuardResult => {
  const state = { ...current };
  if (state.status !== "active") {
    return { state, changed: false, shouldAbort: false };
  }
  const now =
    typeof observation.now === "number" &&
    Number.isSafeInteger(observation.now) &&
    observation.now >= 0
      ? observation.now
      : Date.now();
  let changed = false;
  const totalTokens = finiteGuardTokens(observation.totalTokens);
  const perTurnTokens = finiteGuardTokens(observation.usageTokens);
  // A cumulative provider total is only meaningful when a budget is active.
  // Stall-only goals should not acquire synthetic tokenBaseline/tokensUsed
  // fields on every turn; doing so would create needless durable entries and
  // make the status snapshot look as if a token budget had been configured.
  if (totalTokens !== undefined && state.tokenBudget !== undefined) {
    const baseline = state.tokenBaseline ?? totalTokens;
    const used = Math.max(
      state.tokensUsed ?? 0,
      Math.max(0, totalTokens - baseline),
    );
    if (state.tokenBaseline !== baseline || state.tokensUsed !== used) {
      state.tokenBaseline = baseline;
      state.tokensUsed = used;
      changed = true;
    }
  } else if (perTurnTokens !== undefined && state.tokenBudget !== undefined) {
    const used = Math.min(
      Number.MAX_SAFE_INTEGER,
      (state.tokensUsed ?? 0) + perTurnTokens,
    );
    if (state.tokensUsed !== used) {
      state.tokensUsed = used;
      changed = true;
    }
  }

  const progressObserved =
    observation.turnRevisionAtStart !== undefined &&
    observation.turnRevisionAtStart !== state.revision;
  const stallEnabled =
    state.stallDetection === true || state.stallTimeoutSecs !== undefined;
  if (stallEnabled) {
    const nextStallTurns = progressObserved ? 0 : (state.stallTurns ?? 0) + 1;
    const nextProgressAt = progressObserved
      ? now
      : (state.lastProgressAt ?? now);
    if (
      state.stallTurns !== nextStallTurns ||
      state.lastProgressAt !== nextProgressAt
    ) {
      state.stallTurns = nextStallTurns;
      state.lastProgressAt = nextProgressAt;
      changed = true;
    }
  }

  if (
    state.tokenBudget !== undefined &&
    (state.tokensUsed ?? 0) >= state.tokenBudget
  ) {
    state.status = "paused";
    state.message = `Token budget reached (${state.tokensUsed ?? 0} of ${state.tokenBudget} tokens).`;
    state.revision = Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1);
    return {
      state,
      changed: true,
      shouldAbort: true,
      reason: "token_budget",
      summary: `${state.message} Resume or clear the goal before continuing.`,
    };
  }

  const timeoutSecs = state.stallTimeoutSecs;
  if (
    stallEnabled &&
    timeoutSecs !== undefined &&
    now - (state.lastProgressAt ?? now) >= timeoutSecs * 1_000
  ) {
    state.status = "paused";
    state.blockedReason =
      "No goal progress was reported during the stall window.";
    state.message = `Goal paused after no progress for ${timeoutSecs} seconds.`;
    state.revision = Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1);
    return {
      state,
      changed: true,
      shouldAbort: true,
      reason: "stall",
      summary: `${state.message} Resume after addressing the blocker.`,
    };
  }

  return { state, changed, shouldAbort: false };
};
