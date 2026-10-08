import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentScheduleRecord,
  AgentScheduleRunRecord,
} from "@melody/agent-contract";

import {
  createAgentSchedule,
  deleteAgentSchedule,
  listAgentScheduleRuns,
  listAgentSchedules,
  setAgentScheduleStatus,
  type CreateAgentScheduleInput,
} from "@/lib/melody-bridge-schedules";

export interface UseAgentSchedulesResult {
  schedules: AgentScheduleRecord[];
  loading: boolean;
  error?: string;
  create: (
    input: Omit<
      CreateAgentScheduleInput,
      "scheduleId" | "sessionId" | "projectId"
    >,
  ) => Promise<void>;
  setStatus: (
    scheduleId: string,
    status: "active" | "paused" | "cancelled",
  ) => Promise<void>;
  remove: (scheduleId: string) => Promise<void>;
  loadRuns: (scheduleId: string) => Promise<AgentScheduleRunRecord[]>;
}

const newScheduleId = () =>
  `schedule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Host-owned schedules for one product session.
 *
 * The Host persists and fires timers, so this hook never computes a fire time
 * and never mutates the queue locally: every action re-reads the authoritative
 * rows. `revision` comes from the event projection, so a change made elsewhere
 * (a trigger, another window, the dispatcher) refreshes this list too.
 */
export const useAgentSchedules = (
  sessionId: string | undefined,
  projectId: string | undefined,
  revision: number,
): UseAgentSchedulesResult => {
  const [schedules, setSchedules] = useState<AgentScheduleRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const refresh = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) {
      setSchedules([]);
      return;
    }
    setLoading(true);
    try {
      const rows = await listAgentSchedules(current);
      // A slower response for a previous session must not overwrite the list
      // that is on screen now.
      if (sessionRef.current === current) {
        setSchedules(rows);
        setError(undefined);
      }
    } catch (cause) {
      if (sessionRef.current === current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (sessionRef.current === current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, sessionId, revision]);

  const create = useCallback<UseAgentSchedulesResult["create"]>(
    async (input) => {
      const session = sessionRef.current;
      if (!session || !projectId) {
        setError("当前会话或项目不可用，无法创建调度。");
        return;
      }
      await createAgentSchedule({
        ...input,
        scheduleId: newScheduleId(),
        sessionId: session,
        projectId,
      });
      await refresh();
    },
    [projectId, refresh],
  );

  const setStatus = useCallback<UseAgentSchedulesResult["setStatus"]>(
    async (scheduleId, status) => {
      await setAgentScheduleStatus(scheduleId, status);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback<UseAgentSchedulesResult["remove"]>(
    async (scheduleId) => {
      await deleteAgentSchedule(scheduleId);
      await refresh();
    },
    [refresh],
  );

  return {
    schedules,
    loading,
    error,
    create,
    setStatus,
    remove,
    loadRuns: listAgentScheduleRuns,
  };
};
