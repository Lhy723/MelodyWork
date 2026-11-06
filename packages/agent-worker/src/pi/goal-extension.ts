import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AgentGoalPolicy } from "@melody/agent-contract";
import { Type, type Static } from "typebox";
import {
  enforceGoalGuards,
  finiteGuardTokens,
  tokenUsageFromMessage,
} from "./goal-guards.ts";
import {
  clearGoalState,
  DEFAULT_MAX_BLOCKED_ATTEMPTS,
  GOAL_STATE_ENTRY,
  MAX_GOAL_MESSAGE_CHARS,
  normalizeGoalPolicy,
  parseGoalObjective,
  pauseGoalState,
  reconstructGoalState,
  resumeGoalState,
  startGoalState,
  summarizeGoalState,
  transitionGoalState,
} from "./goal-state.ts";
import type { GoalStateEntryData } from "./goal-state.ts";

export const PI_UPDATE_GOAL = "update_goal" as const;

/**
 * The goal state helpers and guards were inlined in this module before the
 * state split. They remain part of this extension's public surface: tests and
 * callers observe goal transitions through it, not through the internal files.
 */
export {
  clearGoalState,
  GOAL_STATE_ENTRY,
  normalizeGoalPolicy,
  parseGoalObjective,
  pauseGoalState,
  reconstructGoalState,
  resumeGoalState,
  startGoalState,
  summarizeGoalState,
  transitionGoalState,
} from "./goal-state.ts";
export {
  enforceGoalGuards,
  finiteGuardTokens,
  tokenUsageFromMessage,
} from "./goal-guards.ts";

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

const goalParameters = Type.Object({
  completed: Type.Optional(
    Type.Boolean({
      description:
        "Set to true ONLY when the goal is fully achieved. Use together with message for a completion summary.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      maxLength: MAX_GOAL_MESSAGE_CHARS,
      description:
        "Optional short progress or completion message. Do not claim work is complete unless completed is true.",
    }),
  ),
  blocked_reason: Type.Optional(
    Type.String({
      maxLength: MAX_GOAL_MESSAGE_CHARS,
      description:
        "Use only when truly stuck after repeated attempts. This is a failure signal, not a success message.",
    }),
  ),
});

type GoalParameters = Static<typeof goalParameters>;

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
      const objective = initialObjective();
      if (typeof objective !== "string" || !objective.trim()) return;
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
          persist(resumeGoalState(state, now()));
          notify(ctx, summarizeGoalState(state));
          return;
        }

        if (normalizedVerb === "pause") {
          if (!state || state.status !== "active") {
            notify(ctx, "Only an active goal can be paused.");
            return;
          }
          persist(pauseGoalState(state, argument || undefined));
          notify(ctx, summarizeGoalState(state));
          return;
        }

        if (normalizedVerb === "clear") {
          persist(clearGoalState(state));
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
