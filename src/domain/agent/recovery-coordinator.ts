import type { PiRecoveryPlan } from "./recovery.ts";
import type { AgentEventEnvelope } from "./contract.ts";
import type {
  AgentEventLogReplayOptions,
  AgentEventLogReplayResult,
} from "./event-log.ts";
import type { AgentEventStream } from "./event-stream.ts";

/** What the renderer is allowed to do after a recovery inspection. */
export type PiSessionResumeAction = "noop" | "replay" | "manual";

export interface ResumePiSessionOptions extends AgentEventLogReplayOptions {
  /** Share the live/replay barrier with an already-installed Pi subscription. */
  stream?: AgentEventStream;
}

export interface ResumePiSessionResult {
  plan: PiRecoveryPlan;
  action: PiSessionResumeAction;
  /** Present only when a bounded event-log replay was actually performed. */
  replay?: AgentEventLogReplayResult;
}

export type PiRecoveryEventListener = (event: AgentEventEnvelope) => void;

export interface PiRecoveryCoordinatorDependencies {
  inspect: (sessionId: string) => Promise<PiRecoveryPlan>;
  replay: (
    sessionId: string,
    onEvent: PiRecoveryEventListener,
    options: AgentEventLogReplayOptions,
    stream?: AgentEventStream,
  ) => Promise<AgentEventLogReplayResult>;
}

/**
 * Convert an untrusted recovery recommendation into a safe renderer action.
 *
 * The Host is the source of the recommendation, but the renderer still
 * re-checks the invariants that make replay side-effect free. A contradictory
 * or incomplete summary therefore falls back to manual reconciliation rather
 * than replaying a potentially active run.
 */
export const classifyPiRecovery = (
  plan: PiRecoveryPlan,
): PiSessionResumeAction => {
  if (
    plan.recommendedAction === "replay" &&
    plan.scanComplete &&
    plan.activeRuns.length === 0 &&
    plan.pendingTools.length === 0 &&
    plan.pendingInteractions.length === 0 &&
    plan.activeTasks.length === 0 &&
    plan.activeMessages.length === 0 &&
    !plan.compactionInProgress
  ) {
    return "replay";
  }
  if (
    plan.recommendedAction === "clean" ||
    plan.recommendedAction === "not-applicable"
  ) {
    return "noop";
  }
  return "manual";
};

/**
 * Run the side-effect-free portion of Pi recovery with injected transport
 * functions. Keeping the orchestration here makes the safety policy
 * independently testable and keeps Tauri details out of the domain layer.
 */
export const coordinatePiRecovery = async (
  sessionId: string,
  onEvent: PiRecoveryEventListener,
  options: ResumePiSessionOptions,
  dependencies: PiRecoveryCoordinatorDependencies,
): Promise<ResumePiSessionResult> => {
  const plan = await dependencies.inspect(sessionId);
  if (plan.sessionId !== sessionId) {
    throw new Error("Pi 恢复检查返回了另一个会话。 ");
  }

  const action = classifyPiRecovery(plan);
  if (action !== "replay") {
    return { plan, action };
  }

  const replayOptions: AgentEventLogReplayOptions = {
    ...(options.afterOrdinal !== undefined
      ? { afterOrdinal: options.afterOrdinal }
      : {}),
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxEvents !== undefined
      ? { maxEvents: options.maxEvents }
      : {}),
  };
  const replay = await dependencies.replay(
    sessionId,
    onEvent,
    replayOptions,
    options.stream,
  );
  return { plan, action: "replay", replay };
};
