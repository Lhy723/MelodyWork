import { useCallback, useEffect, useState } from "react";

import {
  cancelAgentMonitor,
  listAgentMonitors,
  type AgentMonitorSnapshot,
} from "@/lib/melody-bridge-monitors";

/** Poll cadence while monitors are running; idle sessions do not poll at all. */
const RUNNING_POLL_MS = 4_000;
/** Slow refresh that notices monitors started by a model turn. */
const IDLE_POLL_MS = 20_000;

/**
 * Host-owned monitor inventory for one workspace.
 *
 * The stream itself arrives as `task.notification` events (they feed the
 * session feed), so this hook only tracks *which* monitors exist and how much
 * they have emitted. It polls while anything is running and backs off to a slow
 * refresh otherwise, so an idle session costs nothing.
 */
export const useAgentMonitors = (cwd: string) => {
  const [monitors, setMonitors] = useState<AgentMonitorSnapshot[]>([]);

  const refresh = useCallback(async () => {
    try {
      const next = await listAgentMonitors();
      setMonitors(next);
      return next;
    } catch {
      // A failed inventory read is not a session failure: keep the last known
      // state instead of clearing a list the user is watching.
      return undefined;
    }
  }, []);

  const cancelMonitor = useCallback(
    async (taskId: string) => {
      try {
        await cancelAgentMonitor(taskId);
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await refresh();
      if (disposed) return;
      const running = (next ?? []).some(
        (monitor) => monitor.status === "running",
      );
      timer = setTimeout(tick, running ? RUNNING_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
    // `cwd` participates so switching projects re-reads the inventory for the
    // workspace that is actually on screen.
  }, [refresh, cwd]);

  return { monitors, refresh, cancelMonitor };
};
