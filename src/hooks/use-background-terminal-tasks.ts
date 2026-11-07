import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyCancelResult,
  type BackgroundCancelOutcome,
  type BackgroundTerminalTaskSnapshot,
} from "@/domain/agent/background-task-list";
import { rawErrorMessage } from "@/domain/app-error";
import { RequestGate } from "@/domain/request-gate";
import {
  cancelBackgroundTerminalTask,
  listBackgroundTerminalTasks,
} from "@/lib/melody-bridge-background-tasks";
import { isTauriRuntime } from "@/lib/melody-bridge-runtime";

/** Poll fast while work is running; an idle session costs one slow refresh. */
const RUNNING_POLL_MS = 4_000;
const IDLE_POLL_MS = 20_000;

interface PanelState {
  tasks: readonly BackgroundTerminalTaskSnapshot[];
  /** Product task id → the message shown on that row. */
  errors: Readonly<Record<string, string>>;
}

const EMPTY_STATE: PanelState = { tasks: [], errors: {} };

/**
 * Host-owned background terminal tasks for one product session.
 *
 * The list is the Host registry (no client cache), refreshed on a timer and
 * immediately after a switch or a stop. Stop results are merged with the pure
 * `applyCancelResult` rule so a task that finishes during the request lands on
 * its terminal state instead of an error.
 */
export const useBackgroundTerminalTasks = (sessionId: string | undefined) => {
  const [state, setState] = useState<PanelState>(EMPTY_STATE);
  const [stoppingTaskIds, setStoppingTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const gate = useRef(new RequestGate());
  const inFlight = useRef(new Set<string>());
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const refresh = useCallback(async () => {
    if (!sessionId || !isTauriRuntime()) {
      setState(EMPTY_STATE);
      return undefined;
    }
    const token = gate.current.begin();
    try {
      const next = await listBackgroundTerminalTasks(sessionId);
      if (!gate.current.isCurrent(token)) {
        return next;
      }
      setState((previous) => ({ ...previous, tasks: next }));
      return next;
    } catch {
      // A failed read is not a stop failure: keep the list the user is reading
      // and retry on the next tick.
      return undefined;
    }
  }, [sessionId]);

  const cancelTask = useCallback(
    async (taskId: string) => {
      if (!sessionId || inFlight.current.has(taskId)) {
        return;
      }
      inFlight.current.add(taskId);
      setStoppingTaskIds(new Set(inFlight.current));
      setState((previous) => {
        if (!(taskId in previous.errors)) {
          return previous;
        }
        const { [taskId]: _cleared, ...errors } = previous.errors;
        return { ...previous, errors };
      });

      let outcome: BackgroundCancelOutcome;
      try {
        outcome = {
          ok: true,
          task: await cancelBackgroundTerminalTask(sessionId, taskId),
        };
      } catch (reason) {
        outcome = {
          ok: false,
          message: rawErrorMessage(reason) || "停止后台任务失败。",
        };
      } finally {
        inFlight.current.delete(taskId);
        setStoppingTaskIds(new Set(inFlight.current));
      }
      if (sessionRef.current !== sessionId) {
        return;
      }
      setState((previous) => {
        const { tasks, error } = applyCancelResult(
          previous.tasks,
          taskId,
          outcome,
        );
        if (!error) {
          if (!(taskId in previous.errors)) {
            return { tasks, errors: previous.errors };
          }
          const { [taskId]: _cleared, ...errors } = previous.errors;
          return { tasks, errors };
        }
        return { tasks, errors: { ...previous.errors, [taskId]: error } };
      });
      void refresh();
    },
    [sessionId, refresh],
  );

  useEffect(() => {
    if (!sessionId || !isTauriRuntime()) {
      setState(EMPTY_STATE);
      return;
    }
    gate.current.invalidate();
    setState((previous) => ({ tasks: previous.tasks, errors: {} }));
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await refresh();
      if (disposed) {
        return;
      }
      const running = (next ?? []).some((task) => task.status === "running");
      timer = setTimeout(tick, running ? RUNNING_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
    // `sessionId` participates so switching sessions drops the previous list and
    // re-reads the registry for the session on screen.
  }, [sessionId, refresh]);

  return {
    tasks: state.tasks,
    errors: state.errors,
    stoppingTaskIds,
    refresh,
    cancelTask,
  };
};
