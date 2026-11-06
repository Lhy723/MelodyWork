import type { AgentGoalPolicy } from "@melody/agent-contract";

/** Durable, non-context entry used for the active Melody goal lifecycle. */
export const GOAL_STATE_ENTRY = "melody.goal_state" as const;
export const MAX_GOAL_MESSAGE_CHARS = 8_000;

export type MelodyGoalStatus =
  "active" | "blocked" | "paused" | "completed" | "cleared";

export interface GoalStateEntryData {
  status: MelodyGoalStatus;
  objective: string;
  message?: string;
  blockedReason?: string;
  blockedAttempts: number;
  completionAttempts: number;
  revision: number;
  /** Optional deterministic token guard, persisted with the goal snapshot. */
  tokenBudget?: number;
  /** Session token total when this goal started. */
  tokenBaseline?: number;
  /** Tokens consumed since tokenBaseline (or observed per-turn when absent). */
  tokensUsed?: number;
  /** Wall-clock stall guard settings captured when the goal starts. */
  stallDetection?: boolean;
  stallTimeoutSecs?: number;
  stallTurns?: number;
  lastProgressAt?: number;
}

export interface UpdateGoalInput {
  completed?: boolean;
  message?: string;
  blocked_reason?: string;
}

export interface GoalTransitionResult {
  state: GoalStateEntryData;
  summary: string;
}

const MAX_OBJECTIVE_CHARS = 8_000;
export const DEFAULT_MAX_BLOCKED_ATTEMPTS = 3;
const MAX_GOAL_TOKEN_BUDGET = 100_000_000;
const MAX_GOAL_STALL_TIMEOUT_SECS = 7 * 24 * 60 * 60;
const MAX_GOAL_BLOCKED_ATTEMPTS = 100;
const DEFAULT_GOAL_STALL_TIMEOUT_SECS = 5 * 60;

const bounded = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
};

const statusIs = (value: unknown): value is MelodyGoalStatus =>
  value === "active" ||
  value === "blocked" ||
  value === "paused" ||
  value === "completed" ||
  value === "cleared";

const safeCounter = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

const safePositiveInteger = (
  value: unknown,
  max: number,
): number | undefined =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= max
    ? value
    : undefined;

const safeNonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/** Normalize the bounded, data-only goal policy crossing the worker boundary. */
export const normalizeGoalPolicy = (
  value: unknown,
): AgentGoalPolicy | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const result: AgentGoalPolicy = {};
  if (record.stallDetection !== undefined) {
    if (typeof record.stallDetection !== "boolean") return undefined;
    result.stallDetection = record.stallDetection;
  }
  const tokenBudget = safePositiveInteger(
    record.tokenBudget,
    MAX_GOAL_TOKEN_BUDGET,
  );
  if (record.tokenBudget !== undefined && tokenBudget === undefined) {
    return undefined;
  }
  if (tokenBudget !== undefined) result.tokenBudget = tokenBudget;
  const stallTimeoutSecs = safePositiveInteger(
    record.stallTimeoutSecs,
    MAX_GOAL_STALL_TIMEOUT_SECS,
  );
  if (record.stallTimeoutSecs !== undefined && stallTimeoutSecs === undefined) {
    return undefined;
  }
  if (stallTimeoutSecs !== undefined) {
    result.stallTimeoutSecs = stallTimeoutSecs;
  }
  const maxBlockedAttempts = safePositiveInteger(
    record.maxBlockedAttempts,
    MAX_GOAL_BLOCKED_ATTEMPTS,
  );
  if (
    record.maxBlockedAttempts !== undefined &&
    maxBlockedAttempts === undefined
  ) {
    return undefined;
  }
  if (maxBlockedAttempts !== undefined) {
    result.maxBlockedAttempts = maxBlockedAttempts;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

/**
 * Parse the same trailing `--budget <tokens>` grammar as Melody-build.
 * Anything that is not a final standalone positive integer remains objective
 * text so prose mentioning the flag cannot be silently rewritten.
 */
export const parseGoalObjective = (
  value: string,
): { objective: string; tokenBudget?: number } => {
  const trimmed = value.trim();
  const match = /^(.*?)(?:\s+)--budget\s+([0-9]+)$/u.exec(trimmed);
  if (match) {
    const parsed = Number(match[2]);
    if (
      Number.isSafeInteger(parsed) &&
      parsed > 0 &&
      parsed <= MAX_GOAL_TOKEN_BUDGET &&
      match[1].trim().length > 0
    ) {
      return { objective: match[1].trim(), tokenBudget: parsed };
    }
  }
  return { objective: trimmed };
};

const persistedGoal = (value: unknown): GoalStateEntryData | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const objective = bounded(record.objective, MAX_OBJECTIVE_CHARS);
  if (!statusIs(status) || !objective) return undefined;
  const message = bounded(record.message, MAX_GOAL_MESSAGE_CHARS);
  const blockedReason = bounded(record.blockedReason, MAX_GOAL_MESSAGE_CHARS);
  const tokenBudget = safePositiveInteger(
    record.tokenBudget,
    MAX_GOAL_TOKEN_BUDGET,
  );
  const tokenBaseline = safeNonNegativeInteger(record.tokenBaseline);
  const tokensUsed = safeNonNegativeInteger(record.tokensUsed);
  const stallTimeoutSecs = safePositiveInteger(
    record.stallTimeoutSecs,
    MAX_GOAL_STALL_TIMEOUT_SECS,
  );
  const stallTurns = safeNonNegativeInteger(record.stallTurns);
  const lastProgressAt = safeNonNegativeInteger(record.lastProgressAt);
  return {
    status,
    objective,
    ...(message ? { message } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    blockedAttempts: safeCounter(record.blockedAttempts),
    completionAttempts: safeCounter(record.completionAttempts),
    revision: safeCounter(record.revision),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(tokenBaseline !== undefined ? { tokenBaseline } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(typeof record.stallDetection === "boolean"
      ? { stallDetection: record.stallDetection }
      : {}),
    ...(stallTimeoutSecs !== undefined ? { stallTimeoutSecs } : {}),
    ...(stallTurns !== undefined ? { stallTurns } : {}),
    ...(lastProgressAt !== undefined ? { lastProgressAt } : {}),
  };
};

/** Reconstruct the latest valid goal snapshot on the active Pi branch. */
export const reconstructGoalState = (
  entries: readonly unknown[],
): GoalStateEntryData | undefined => {
  let state: GoalStateEntryData | undefined;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (
      candidate.type !== "custom" ||
      candidate.customType !== GOAL_STATE_ENTRY
    ) {
      continue;
    }
    const next = persistedGoal(candidate.data);
    if (!next) continue;
    state = next;
    if (next.status === "cleared") state = undefined;
  }
  return state;
};

const cloneGoalState = (state: GoalStateEntryData): GoalStateEntryData => ({
  ...state,
});

/** Create a new active goal without mutating any existing branch snapshot. */
export const startGoalState = (
  objective: string,
  rawPolicy?: AgentGoalPolicy,
  initialTokenUsage?: number,
  now = Date.now(),
): GoalStateEntryData => {
  const normalized = bounded(objective, MAX_OBJECTIVE_CHARS);
  if (!normalized) throw new Error("A goal objective is required.");
  const policy = normalizeGoalPolicy(rawPolicy);
  const tokenBudget = policy?.tokenBudget;
  const stallDetection =
    policy?.stallDetection ?? policy?.stallTimeoutSecs !== undefined;
  const state: GoalStateEntryData = {
    status: "active",
    objective: normalized,
    blockedAttempts: 0,
    completionAttempts: 0,
    revision: 1,
  };
  if (tokenBudget !== undefined) {
    state.tokenBudget = tokenBudget;
    state.tokensUsed = 0;
    const baseline = safeNonNegativeInteger(initialTokenUsage);
    if (baseline !== undefined) state.tokenBaseline = baseline;
  }
  if (stallDetection || policy?.stallTimeoutSecs !== undefined) {
    state.stallDetection = stallDetection;
    state.stallTimeoutSecs =
      policy?.stallTimeoutSecs ?? DEFAULT_GOAL_STALL_TIMEOUT_SECS;
    state.stallTurns = 0;
    state.lastProgressAt = now;
  }
  return state;
};

const nextRevision = (state: GoalStateEntryData): number =>
  Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1);

const withProgressTimestamp = (
  state: GoalStateEntryData,
): GoalStateEntryData =>
  state.stallDetection || state.stallTimeoutSecs !== undefined
    ? { ...state, stallTurns: 0, lastProgressAt: Date.now() }
    : state;

/**
 * Apply Melody's model-facing update_goal contract to a durable state.
 *
 * The classifier is deliberately not hidden behind this function: callers
 * can see exactly which transition Pi owns and can route configured
 * classifier/retry policies to ACP before the session starts. Three
 * consecutive blocked reports auto-pause the goal, matching the old harness
 * safety rule while avoiding an unbounded self-driving loop.
 */
export const transitionGoalState = (
  current: GoalStateEntryData,
  input: UpdateGoalInput,
  maxBlockedAttempts = DEFAULT_MAX_BLOCKED_ATTEMPTS,
): GoalTransitionResult => {
  if (current.status !== "active") {
    throw new Error(
      `update_goal is unavailable while the goal is ${current.status}. Resume or start an active goal first.`,
    );
  }

  const message = bounded(input.message, MAX_GOAL_MESSAGE_CHARS);
  const blockedReason = bounded(input.blocked_reason, MAX_GOAL_MESSAGE_CHARS);
  if (input.message !== undefined && !message) {
    throw new Error("message must not be empty.");
  }
  if (input.blocked_reason !== undefined && !blockedReason) {
    throw new Error("blocked_reason must not be empty.");
  }
  if (input.completed === true && blockedReason) {
    throw new Error("completed and blocked_reason cannot be used together.");
  }
  if (input.completed === undefined && !message && !blockedReason) {
    throw new Error(
      "update_goal requires completed, message, or blocked_reason.",
    );
  }

  if (blockedReason) {
    const blockedAttempts = Math.min(
      Number.MAX_SAFE_INTEGER,
      current.blockedAttempts + 1,
    );
    const limit = Math.max(1, Math.floor(maxBlockedAttempts));
    const blocked = blockedAttempts >= limit;
    const state: GoalStateEntryData = {
      ...withProgressTimestamp(cloneGoalState(current)),
      status: blocked ? "blocked" : "active",
      ...(message ? { message } : {}),
      blockedReason,
      blockedAttempts,
      revision: nextRevision(current),
    };
    return {
      state,
      summary: blocked
        ? `Goal paused as blocked after ${blockedAttempts} consecutive blocked reports: ${blockedReason}`
        : `Blocked attempt ${blockedAttempts}/${limit} recorded; continue investigating before reporting another blocker.`,
    };
  }

  if (input.completed === true) {
    const state: GoalStateEntryData = {
      ...withProgressTimestamp(cloneGoalState(current)),
      status: "completed",
      ...(message ? { message } : {}),
      completionAttempts: Math.min(
        Number.MAX_SAFE_INTEGER,
        current.completionAttempts + 1,
      ),
      revision: nextRevision(current),
    };
    return {
      state,
      summary: message ?? "Goal marked completed.",
    };
  }

  const state: GoalStateEntryData = {
    ...withProgressTimestamp(cloneGoalState(current)),
    ...(message ? { message } : {}),
    revision: nextRevision(current),
  };
  return {
    state,
    summary: message ?? "Goal remains active.",
  };
};

export const resumeGoalState = (
  state: GoalStateEntryData,
  now = Date.now(),
): GoalStateEntryData => ({
  ...state,
  status: "active",
  ...(state.stallDetection || state.stallTimeoutSecs !== undefined
    ? { stallTurns: 0, lastProgressAt: now }
    : {}),
  revision: nextRevision(state),
});

export const pauseGoalState = (
  state: GoalStateEntryData,
  message?: string,
): GoalStateEntryData => ({
  ...state,
  status: "paused",
  ...(message ? { message: bounded(message, MAX_GOAL_MESSAGE_CHARS) } : {}),
  revision: nextRevision(state),
});

export const clearGoalState = (
  previous: GoalStateEntryData | undefined,
): GoalStateEntryData => ({
  status: "cleared",
  objective: previous?.objective ?? "",
  blockedAttempts: previous?.blockedAttempts ?? 0,
  completionAttempts: previous?.completionAttempts ?? 0,
  revision: Math.min(Number.MAX_SAFE_INTEGER, (previous?.revision ?? 0) + 1),
});

export const summarizeGoalState = (
  state: GoalStateEntryData | undefined,
): string => {
  if (!state) return "No active goal.";
  const status = state.status === "cleared" ? "cleared" : state.status;
  const lines = [`[${status}] ${state.objective}`];
  if (state.message) lines.push(state.message);
  if (state.blockedReason) lines.push(`Blocked: ${state.blockedReason}`);
  if (state.blockedAttempts > 0) {
    lines.push(`Blocked attempts: ${state.blockedAttempts}`);
  }
  if (state.tokenBudget !== undefined) {
    lines.push(`Tokens: ${state.tokensUsed ?? 0}/${state.tokenBudget}`);
  }
  if (state.stallTimeoutSecs !== undefined && state.stallDetection !== false) {
    lines.push(`Stall guard: ${state.stallTimeoutSecs}s`);
  }
  return lines.join("\n");
};
