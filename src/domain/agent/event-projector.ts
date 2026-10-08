import type { AgentEventEnvelope } from "./contract.ts";
import type { AgentSubagent } from "../acp.ts";
import {
  createAgentEventProjectionState,
  projectAgentEvent,
  type AgentEventProjectionResult,
  type AgentEventProjectionState,
} from "./event-to-session-update.ts";

export type AgentEventProjectionListener = (
  result: AgentEventProjectionResult,
) => void;

export interface AgentEventProjectorOptions {
  expectedSessionId?: string;
  initialState?: AgentEventProjectionState;
}

/**
 * Stateful bridge between the event stream checkpoint and the pure timeline
 * reducer. `AgentEventStream` decides whether an event is new; this class
 * only advances the projection after that decision, so replay and live events
 * cannot accidentally maintain separate timeline semantics.
 */
export class AgentEventProjector {
  private state: AgentEventProjectionState;
  private replayActive = false;
  private readonly expectedSessionId?: string;
  private readonly onProjection?: AgentEventProjectionListener;

  public constructor(
    onProjection?: AgentEventProjectionListener,
    options: AgentEventProjectorOptions = {},
  ) {
    this.state = options.initialState ?? createAgentEventProjectionState();
    this.expectedSessionId = options.expectedSessionId;
    this.onProjection = onProjection;
  }

  public getState(): AgentEventProjectionState {
    return this.state;
  }

  public consume(event: AgentEventEnvelope): AgentEventProjectionResult {
    // The event stream deliberately lets a replay and live delivery share one
    // checkpoint, but the projector has a second kind of state: message
    // offsets and the latest usage snapshot. A replay starts from persisted
    // history, so carrying those run-local maps over from a previous live
    // subscription could turn the first replay delta into a duplicate/gap or
    // attach stale usage to the next run. Keep the rendered timeline while
    // clearing only the reducer's transient tracking once per replay batch.
    if (event.replay && !this.replayActive) {
      // Subagent rows are session-scoped rather than run-scoped. Keep them
      // while a replay rebuilds message/usage reducer state so the side panel
      // does not briefly lose its live task stack.
      this.reset(this.state.timeline, this.state.subagents);
      this.replayActive = true;
    } else if (!event.replay) {
      this.replayActive = false;
    }
    const result = projectAgentEvent(this.state, event, this.expectedSessionId);
    // Even ignored or diagnostic events advance no timeline state, but the
    // result is still emitted so callers can surface the diagnostic instead of
    // silently losing a future/foreign event.
    this.state = result.state;
    this.onProjection?.(result);
    return result;
  }

  public reset(
    timeline = this.state.timeline,
    subagents: ReadonlyMap<string, AgentSubagent> = new Map(),
  ): void {
    this.state = createAgentEventProjectionState(timeline, subagents);
    this.replayActive = false;
  }
}
