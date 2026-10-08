import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AgentGoalPolicy } from "@melody/agent-contract";
import { Type, type Static } from "typebox";

/** Durable, non-context entry used for the active Melody goal lifecycle. */
export const GOAL_STATE_ENTRY = "melody.goal_state" as const;
export const PI_UPDATE_GOAL = "update_goal" as const;

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

export interface GoalExtensionOptions {
  /** Disable mutation while retaining a read-only status surface. */
  enabled?: () => boolean;
  /** Optional host-provided objective used to seed an active goal. */
  initialObjective?: () => string | undefined;
  /** Number of consecutive blocked reports before auto-pausing. */
  maxBlockedAttempts?: number;
  /** Host-projected deterministic token/stall safeguards for new goals. */
  policy?: () => AgentGoalPolicy | undefined;
  /** Cumulative Pi session tokens, available after the session is registered. */
  getTokenUsage?: () => number | undefined;
  /** Injectable clock for deterministic guard tests. */
  now?: () => number;
}

const MAX_OBJECTIVE_CHARS = 8_000;
const MAX_MESSAGE_CHARS = 8_000;
const DEFAULT_MAX_BLOCKED_ATTEMPTS = 3;
const MAX_GOAL_TOKEN_BUDGET = 100_000_000;
const MAX_GOAL_STALL_TIMEOUT_SECS = 7 * 24 * 60 * 60;
const MAX_GOAL_BLOCKED_ATTEMPTS = 100;
const DEFAULT_GOAL_STALL_TIMEOUT_SECS = 5 * 60;

const goalParameters = Type.Object({
  completed: Type.Optional(
    Type.Boolean({
      description:
        "Set to true ONLY when the goal is fully achieved. Use together with message for a completion summary.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      maxLength: MAX_MESSAGE_CHARS,
      description:
        "Optional short progress or completion message. Do not claim work is complete unless completed is true.",
    }),
  ),
  blocked_reason: Type.Optional(
    Type.String({
      maxLength: MAX_MESSAGE_CHARS,
      description:
        "Use only when truly stuck after repeated attempts. This is a failure signal, not a success message.",
    }),
  ),
});

type GoalParameters = Static<typeof goalParameters>;

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
  const message = bounded(record.message, MAX_MESSAGE_CHARS);
  const blockedReason = bounded(record.blockedReason, MAX_MESSAGE_CHARS);
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

  const message = bounded(input.message, MAX_MESSAGE_CHARS);
  const blockedReason = bounded(input.blocked_reason, MAX_MESSAGE_CHARS);
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

const finiteGuardTokens = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;

const tokenUsageFromMessage = (value: unknown): number | undefined => {
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
  const state = cloneGoalState(current);
  if (state.status !== "active") {
    return { state, changed: false, shouldAbort: false };
  }
  const now = safeNonNegativeInteger(observation.now) ?? Date.now();
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
    state.revision = nextRevision(state);
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
    state.revision = nextRevision(state);
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

const clearedGoalState = (
  previous: GoalStateEntryData | undefined,
): GoalStateEntryData => ({
  status: "cleared",
  objective: previous?.objective ?? "",
  blockedAttempts: previous?.blockedAttempts ?? 0,
  completionAttempts: previous?.completionAttempts ?? 0,
  revision: Math.min(Number.MAX_SAFE_INTEGER, (previous?.revision ?? 0) + 1),
});

const notify = (ctx: ExtensionCommandContext, text: string): void => {
  ctx.ui.notify(text, "info");
};

/**
 * First-party Pi implementation of Melody's basic goal state contract.
 *
 * The extension intentionally does not run the old adversarial completion
 * classifier or hidden planner subagents. Those policies require a complete
 * orchestration snapshot and remain an explicit ACP capability diagnostic.
 * The durable state, blocked-attempt guard, `/goal` lifecycle command and
 * model-facing `update_goal` tool are safe to own in Pi today.
 */
export const createGoalExtension = (
  getSessionMode: () => string = () => "default",
  getCapabilityMode: () => string = () => "all",
  options: GoalExtensionOptions = {},
): InlineExtension => ({
  name: "melody-goal",
  hidden: true,
  factory: (pi: ExtensionAPI) => {
    const enabled = options.enabled ?? (() => true);
    const initialObjective = options.initialObjective;
    const maxBlockedAttempts =
      options.maxBlockedAttempts ??
      normalizeGoalPolicy(options.policy?.())?.maxBlockedAttempts ??
      DEFAULT_MAX_BLOCKED_ATTEMPTS;
    const now = options.now ?? (() => Date.now());
    let state: GoalStateEntryData | undefined;
    let turnRevisionAtStart: number | undefined;

    const reconstruct = (ctx: ExtensionContext): void => {
      state = reconstructGoalState(ctx.sessionManager.getBranch());
      if (state || !initialObjective) return;
      const objective = bounded(initialObjective(), MAX_OBJECTIVE_CHARS);
      if (!objective) return;
      state = startGoalState(
        objective,
        options.policy?.(),
        options.getTokenUsage?.(),
        now(),
      );
      pi.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY, state);
    };

    const persist = (next: GoalStateEntryData): void => {
      pi.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY, next);
      state = next;
    };

    pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
    pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
    pi.on("turn_start", async (_event) => {
      turnRevisionAtStart = state?.revision;
    });
    pi.on("turn_end", async (event, ctx) => {
      if (!state || state.status !== "active") {
        turnRevisionAtStart = undefined;
        return;
      }
      let totalTokens: number | undefined;
      try {
        totalTokens = finiteGuardTokens(options.getTokenUsage?.());
      } catch {
        // A missing/invalid Host stats bridge must never break a model turn.
        totalTokens = undefined;
      }
      const usageTokens =
        totalTokens === undefined
          ? tokenUsageFromMessage(event.message)
          : undefined;
      const result = enforceGoalGuards(state, {
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(usageTokens !== undefined ? { usageTokens } : {}),
        ...(turnRevisionAtStart !== undefined ? { turnRevisionAtStart } : {}),
        now: now(),
      });
      turnRevisionAtStart = undefined;
      if (!result.changed) return;
      persist(result.state);
      if (result.shouldAbort && result.summary) {
        ctx.ui.notify(result.summary, "warning");
        ctx.abort();
      }
    });

    pi.registerTool({
      name: PI_UPDATE_GOAL,
      label: "Goal",
      description:
        "Report progress on the active goal, mark it completed, or flag a repeated blocker.",
      promptSnippet: "report active goal progress",
      parameters: goalParameters,
      executionMode: "sequential",
      async execute(
        _toolCallId,
        params: GoalParameters,
        _signal,
        _onUpdate,
        _ctx,
      ) {
        if (!enabled()) {
          throw new Error("update_goal is disabled for this session.");
        }
        if (getSessionMode() === "ask") {
          throw new Error("update_goal is unavailable in ask mode.");
        }
        if (getCapabilityMode() === "read-only") {
          throw new Error("update_goal is unavailable in read-only mode.");
        }
        if (!state) {
          throw new Error(
            "update_goal is unavailable outside an active goal. Start one with /goal start <objective>.",
          );
        }
        const result = transitionGoalState(state, params, maxBlockedAttempts);
        persist(result.state);
        return {
          content: [{ type: "text", text: result.summary }],
          details: {
            status: result.state.status,
            revision: result.state.revision,
            blockedAttempts: result.state.blockedAttempts,
            completionAttempts: result.state.completionAttempts,
            ...(result.state.tokenBudget !== undefined
              ? {
                  tokensUsed: result.state.tokensUsed ?? 0,
                  tokenBudget: result.state.tokenBudget,
                }
              : {}),
          },
        };
      },
    });

    pi.registerCommand("goal", {
      description:
        "Start, resume, pause, clear, or inspect the current goal lifecycle. Start accepts a trailing --budget <tokens> safeguard.",
      handler: async (args, ctx) => {
        const input = args.trim();
        const [verb, ...rest] = input.split(/\s+/u);
        const argument = rest.join(" ").trim();
        const normalizedVerb = (verb ?? "status").toLowerCase();

        if (normalizedVerb === "status" && !argument) {
          notify(ctx, summarizeGoalState(state));
          return;
        }

        if (normalizedVerb === "start") {
          if (!argument) {
            notify(ctx, "Usage: /goal start <objective> [--budget <tokens>]");
            return;
          }
          if (state?.status === "active") {
            notify(
              ctx,
              "An active goal already exists; pause or clear it first.",
            );
            return;
          }
          const parsed = parseGoalObjective(argument);
          const policy = normalizeGoalPolicy(options.policy?.()) ?? {};
          persist(
            startGoalState(
              parsed.objective,
              {
                ...policy,
                ...(parsed.tokenBudget !== undefined
                  ? { tokenBudget: parsed.tokenBudget }
                  : {}),
              },
              options.getTokenUsage?.(),
              now(),
            ),
          );
          notify(ctx, summarizeGoalState(state));
          return;
        }

        if (normalizedVerb === "resume") {
          if (!state || !["blocked", "paused"].includes(state.status)) {
            notify(ctx, "Only a blocked or paused goal can be resumed.");
            return;
          }
          persist({
            ...state,
            status: "active",
            ...(state.stallDetection || state.stallTimeoutSecs !== undefined
              ? { stallTurns: 0, lastProgressAt: now() }
              : {}),
            revision: nextRevision(state),
          });
          notify(ctx, summarizeGoalState(state));
          return;
        }

        if (normalizedVerb === "pause") {
          if (!state || state.status !== "active") {
            notify(ctx, "Only an active goal can be paused.");
            return;
          }
          persist({
            ...state,
            status: "paused",
            ...(argument
              ? { message: bounded(argument, MAX_MESSAGE_CHARS) }
              : {}),
            revision: nextRevision(state),
          });
          notify(ctx, summarizeGoalState(state));
          return;
        }

        if (normalizedVerb === "clear") {
          persist(clearedGoalState(state));
          state = undefined;
          notify(ctx, "Goal cleared.");
          return;
        }

        // `/goal <objective>` is a convenient shorthand for starting a goal
        // and mirrors Melody's prompt-oriented command without making a
        // model-facing tool infer whether a sentence is an objective.
        if (!state && input) {
          const parsed = parseGoalObjective(input);
          const policy = normalizeGoalPolicy(options.policy?.()) ?? {};
          persist(
            startGoalState(
              parsed.objective,
              {
                ...policy,
                ...(parsed.tokenBudget !== undefined
                  ? { tokenBudget: parsed.tokenBudget }
                  : {}),
              },
              options.getTokenUsage?.(),
              now(),
            ),
          );
          notify(ctx, summarizeGoalState(state));
          return;
        }

        notify(ctx, summarizeGoalState(state));
      },
    });
  },
});
