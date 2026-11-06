import { fail } from "./session-errors.ts";
import type { PiSessionHandle } from "./session-runtime-types.ts";
import type { WorkerEmitter } from "../protocol.ts";

type SessionStopReason = "session_closed" | "shutdown";

interface PiSessionCloseDependencies {
  sessions: Map<string, PiSessionHandle>;
  cancelSubagentsForRootSession: (sessionId: string) => Promise<void>;
  emit: WorkerEmitter;
}

/** Own Pi session disposal and its ordered run/session lifecycle events. */
export class PiSessionCloseRuntime {
  private readonly dependencies: PiSessionCloseDependencies;

  public constructor(dependencies: PiSessionCloseDependencies) {
    this.dependencies = dependencies;
  }

  public async close(
    sessionId: string,
    requestId?: string | number,
    stopReason: SessionStopReason = "session_closed",
    emitLifecycle = true,
  ): Promise<void> {
    const handle = this.dependencies.sessions.get(sessionId);
    if (!handle) {
      throw fail(
        "pi.session_not_found",
        `Pi session 不存在：${sessionId}。`,
        "session",
      );
    }
    const runId = handle.runId;
    await this.dependencies.cancelSubagentsForRootSession(sessionId);
    const wasRunning = Boolean(runId && !handle.runFinished);
    // Mark the run before aborting. Pi may synchronously emit agent_settled
    // while abort unwinds; that event must not turn a user stop into a false
    // successful completion.
    if (wasRunning) handle.runFinished = true;
    handle.session.clearQueue();
    if (handle.session.isStreaming) {
      try {
        await handle.session.abort();
      } catch {
        // Disposal below is still required when an in-flight provider rejects
        // its abort request.
      }
    }
    handle.unsubscribe();
    handle.session.dispose();
    handle.idempotency.clear();
    this.dependencies.sessions.delete(sessionId);
    if (wasRunning && runId) {
      await this.dependencies.emit({
        requestId,
        sessionId,
        runId,
        event: {
          type: "run.finished",
          ...(handle.promptId ? { promptId: handle.promptId } : {}),
          status: "cancelled",
          stopReason,
        },
      });
    }
    if (emitLifecycle) {
      await this.dependencies.emit({
        requestId,
        sessionId,
        event: { type: "session.closed" },
      });
    }
  }
}
