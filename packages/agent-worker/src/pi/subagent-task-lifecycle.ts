import type { WorkerEmitter } from "../protocol.ts";
import type {
  PiSubagentIsolation,
  PiSubagentType,
} from "./subagent-policy-normalization.ts";
import { asError } from "./session-errors.ts";
import type { PiSessionContext } from "./session-runtime-types.ts";

export interface PiSubagentTaskHandle extends PiSessionContext {
  taskId: string;
  parentSessionId: string;
  parentTaskId?: string;
  subagentType: PiSubagentType;
  role?: string;
  persona?: string;
  agent?: string;
  isolation: PiSubagentIsolation;
  permissionMode: "ask" | "auto" | "always-approve";
  worktreePath?: string;
  resumedFrom?: string;
  childSessionId: string;
  sessionFile?: string;
  promise: Promise<{ output: string }>;
  cancel: () => Promise<void>;
  unsubscribe: () => void;
  output: string;
  status: "running" | "completed" | "failed" | "cancelled";
}

export interface PiSubagentTaskLifecycleInput {
  task: PiSubagentTaskHandle;
  initialPrompt: string;
  resolvePrompt: () => string;
  emit: WorkerEmitter;
  observePiEvent: (sessionId: string, event: unknown) => Promise<void>;
  persistRecord: (task: PiSubagentTaskHandle) => Promise<void>;
}

/**
 * Owns the post-session-creation run lifecycle for a prepared Pi child task.
 * The runtime retains task admission, session creation, task-map ownership,
 * and foreground/background result selection.
 */
export const startPiSubagentTaskLifecycle = ({
  task,
  initialPrompt,
  resolvePrompt,
  emit,
  observePiEvent,
  persistRecord,
}: PiSubagentTaskLifecycleInput): void => {
  const { session, childSessionId, rootSessionId } = task;

  task.cancel = async () => {
    if (task.status !== "running") return;
    const wasRunning = !task.runFinished;
    task.status = "cancelled";
    task.runFinished = true;
    session.clearQueue();
    if (session.isStreaming) await session.abort().catch(() => undefined);
    if (wasRunning && task.runId) {
      await emit({
        sessionId: rootSessionId,
        streamSessionId: childSessionId,
        runId: task.runId,
        event: {
          type: "run.finished",
          promptId: task.promptId,
          status: "cancelled",
          stopReason: "parent_cancelled",
        },
      });
    }
  };

  task.unsubscribe = session.subscribe((event) => {
    task.eventTail = task.eventTail
      .then(() => observePiEvent(childSessionId, event))
      .catch(async (error) => {
        task.runFinished = true;
        task.status = "failed";
        await emit({
          sessionId: rootSessionId,
          streamSessionId: childSessionId,
          runId: task.runId,
          event: { type: "runtime.error", error: asError(error) },
        });
        await emit({
          sessionId: rootSessionId,
          streamSessionId: childSessionId,
          runId: task.runId,
          event: {
            type: "run.finished",
            promptId: task.promptId,
            status: "failed",
            stopReason: "pi_event_error",
            error: asError(error, "run"),
          },
        });
      });
  });

  task.promise = (async () => {
    try {
      await emit({
        sessionId: rootSessionId,
        event: {
          type: "subagent.changed",
          taskId: task.taskId,
          status: "running",
          ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
          childSessionId,
          payload: {
            prompt: initialPrompt,
            parentSessionId: rootSessionId,
            subagentType: task.subagentType,
            ...(task.role ? { role: task.role } : {}),
            ...(task.persona ? { persona: task.persona } : {}),
            ...(task.agent ? { agent: task.agent } : {}),
            capabilityMode: task.capabilityMode,
            permissionMode: task.permissionMode,
            isolation: task.isolation,
            ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
            ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
            ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
            ...(task.modelId ? { modelId: task.modelId } : {}),
            reasoningEffort: task.reasoningEffort,
          },
        },
      });
      // A cancellation can arrive while the initial status event is being
      // delivered. Do not start a provider request after that cancellation
      // has already marked the task terminal.
      if (task.status !== "running") return { output: task.output };
      await emit({
        sessionId: rootSessionId,
        streamSessionId: childSessionId,
        runId: task.runId,
        event: { type: "run.accepted", promptId: task.promptId },
      });
      if (task.status !== "running") return { output: task.output };
      await task.refreshResources?.();
      await task.refreshModelSettings?.();
      if (task.status !== "running") return { output: task.output };
      await session.prompt(resolvePrompt());
      await task.eventTail;
      if (task.status === "running") task.status = "completed";
      if (!task.runFinished && task.runId) {
        task.runFinished = true;
        await emit({
          sessionId: rootSessionId,
          streamSessionId: childSessionId,
          runId: task.runId,
          event: {
            type: "run.finished",
            promptId: task.promptId,
            status: "completed",
            stopReason: "pi_idle",
          },
        });
      }
    } catch (error) {
      if (task.status === "running") task.status = "failed";
      if (!task.runFinished && task.runId) {
        task.runFinished = true;
        // When the writer itself fails, the terminal event cannot be
        // delivered either. Keep cleanup deterministic and preserve the
        // original failure instead of leaking a live task handle.
        try {
          await emit({
            sessionId: rootSessionId,
            streamSessionId: childSessionId,
            runId: task.runId,
            event: {
              type: "run.finished",
              promptId: task.promptId,
              status: "failed",
              stopReason: "pi_prompt_error",
              error: asError(error, "run"),
            },
          });
        } catch {
          // A failed writer cannot accept the terminal event; cleanup below
          // is still required so the task does not remain live in memory.
        }
      }
      if (!task.output) {
        task.output = error instanceof Error ? error.message : String(error);
      }
    } finally {
      try {
        task.unsubscribe();
      } catch {
        // Cleanup must continue even if a replacement session removed it.
      }
      try {
        session.dispose();
      } catch {
        // Pi dispose is best effort after abort/provider failure.
      }
      try {
        await persistRecord(task);
      } catch (error) {
        // A completed child remains usable in this worker if its sidecar write
        // fails; surface the durability loss so resume cannot look successful.
        try {
          await emit({
            sessionId: rootSessionId,
            event: {
              type: "runtime.warning",
              error: {
                ...asError(error, "runtime"),
                code: "pi.resume_persist_failed",
                message:
                  "Pi 子代理恢复记录保存失败：" +
                  (error instanceof Error ? error.message : String(error)),
              },
            },
          });
        } catch {
          // Preserve terminal task cleanup when the event writer is down.
        }
      }
      try {
        await emit({
          sessionId: rootSessionId,
          event: {
            type: "subagent.changed",
            taskId: task.taskId,
            status: task.status,
            ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
            childSessionId,
            payload: {
              output: task.output,
              parentSessionId: rootSessionId,
              subagentType: task.subagentType,
              ...(task.agent ? { agent: task.agent } : {}),
              capabilityMode: task.capabilityMode,
              permissionMode: task.permissionMode,
              isolation: task.isolation,
              ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
              ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
              ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
              ...(task.modelId ? { modelId: task.modelId } : {}),
              reasoningEffort: task.reasoningEffort,
            },
          },
        });
      } catch {
        // The status is local; the worker supervisor handles an unavailable writer.
      }
      try {
        await emit({
          sessionId: rootSessionId,
          event: {
            type: "task.changed",
            taskId: task.taskId,
            status: task.status,
            childSessionId,
            payload: {
              output: task.output,
              parentSessionId: rootSessionId,
              subagentType: task.subagentType,
              ...(task.role ? { role: task.role } : {}),
              ...(task.persona ? { persona: task.persona } : {}),
              ...(task.agent ? { agent: task.agent } : {}),
              capabilityMode: task.capabilityMode,
              permissionMode: task.permissionMode,
              isolation: task.isolation,
              ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
              ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
            },
          },
        });
      } catch {
        // See the cleanup note above.
      }
    }
    return { output: task.output };
  })();

  // Background work must never become an unhandled rejection after return.
  void task.promise.catch(() => undefined);
};
