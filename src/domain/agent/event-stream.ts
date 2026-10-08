import type { AgentEventEnvelope } from "./contract.ts";
import {
  acceptAgentEvent,
  createAgentEventCheckpoint,
  resetAgentEventCheckpoint,
  type AgentEventCheckpoint,
  type AgentEventCheckpointOptions,
} from "./event-checkpoint.ts";
import {
  replayAgentEventLog,
  type AgentEventLogReplayOptions,
  type AgentEventLogReplayResult,
} from "./event-log.ts";

const runtimeCheckpointKey = "__runtime__";

export type AgentEventLogPageReader = (
  sessionId: string,
  afterOrdinal: number,
  limit: number,
) => Promise<unknown[]>;

export type AgentEventStreamOptions = AgentEventCheckpointOptions;

/**
 * Coordinate a live normalized event subscription with bounded replay.
 *
 * The Host event log is append-only, but a renderer can still receive a live
 * event while it is paging older rows. Buffering live deliveries at this
 * boundary gives replay a small barrier: persisted rows are projected first,
 * then buffered live rows are passed through the same checkpoint. Exact event
 * IDs and sequence numbers make the overlap idempotent.
 */
export class AgentEventStream {
  private readonly checkpoints = new Map<string, AgentEventCheckpoint>();
  private readonly replaying = new Map<
    string,
    Promise<AgentEventLogReplayResult>
  >();
  private readonly buffered = new Map<string, AgentEventEnvelope[]>();
  private readonly replayStarted = new Set<string>();
  private readonly checkpointOptions: AgentEventCheckpointOptions;
  private readonly onEvent: (event: AgentEventEnvelope) => void;

  public constructor(
    onEvent: (event: AgentEventEnvelope) => void,
    options: AgentEventStreamOptions = {},
  ) {
    this.onEvent = onEvent;
    this.checkpointOptions = {
      allowMissingWorkerEpoch: options.allowMissingWorkerEpoch ?? false,
      ...(options.maxEventIds !== undefined
        ? { maxEventIds: options.maxEventIds }
        : {}),
    };
  }

  /**
   * Consume one event from the live transport. Returns false when the event
   * was buffered or rejected by the checkpoint.
   */
  public consume(event: AgentEventEnvelope): boolean {
    const key = event.sessionId ?? runtimeCheckpointKey;
    if (this.replaying.has(key)) {
      const pending = this.buffered.get(key) ?? [];
      pending.push(event);
      this.buffered.set(key, pending);
      return false;
    }
    return this.deliver(event);
  }

  /**
   * Replay a bounded Host log slice. Concurrent calls for one session share
   * the same promise, so two reconnect paths cannot interleave their cursors.
   */
  public replay(
    sessionId: string,
    readPage: AgentEventLogPageReader,
    options: AgentEventLogReplayOptions = {},
  ): Promise<AgentEventLogReplayResult> {
    const existing = this.replaying.get(sessionId);
    if (existing) return existing;

    const operation = this.runReplay(sessionId, readPage, options);
    this.replaying.set(sessionId, operation);
    return operation;
  }

  /** Stop retaining checkpoints and buffered events for a closed session. */
  public clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.checkpoints.clear();
      this.buffered.clear();
      this.replayStarted.clear();
      return;
    }
    this.checkpoints.delete(sessionId);
    this.buffered.delete(sessionId);
    this.replayStarted.delete(sessionId);
  }

  private deliver(event: AgentEventEnvelope): boolean {
    const key = event.sessionId ?? runtimeCheckpointKey;
    let checkpoint =
      this.checkpoints.get(key) ??
      createAgentEventCheckpoint(event.workerEpoch);
    // A replay is a new delivery of the event log, not a new fact. Reset its
    // exact-ID window once at the beginning so reconnects can rebuild a
    // projection without being filtered by the previous live window.
    if (event.replay && !this.replayStarted.has(key)) {
      checkpoint = resetAgentEventCheckpoint(checkpoint, event.workerEpoch);
      this.replayStarted.add(key);
    } else if (!event.replay) {
      this.replayStarted.delete(key);
    }
    const acceptance = acceptAgentEvent(
      checkpoint,
      event,
      this.checkpointOptions,
    );
    this.checkpoints.set(key, acceptance.checkpoint);
    if (!acceptance.accepted) return false;
    this.onEvent(event);
    return true;
  }

  private async runReplay(
    sessionId: string,
    readPage: AgentEventLogPageReader,
    options: AgentEventLogReplayOptions,
  ): Promise<AgentEventLogReplayResult> {
    let result: AgentEventLogReplayResult | undefined;
    let failure: unknown;
    try {
      result = await replayAgentEventLog(
        sessionId,
        readPage,
        (event) => {
          // Replay rows bypass consume() so that only events from the live
          // transport are placed behind the barrier.
          this.deliver(event);
        },
        options,
      );
    } catch (error) {
      failure = error;
    }

    this.replaying.delete(sessionId);
    const pending = this.buffered.get(sessionId) ?? [];
    this.buffered.delete(sessionId);
    for (const event of pending) {
      try {
        this.deliver(event);
      } catch (error) {
        failure ??= error;
      }
    }
    this.replayStarted.delete(sessionId);

    if (failure !== undefined) throw failure;
    return result as AgentEventLogReplayResult;
  }
}
