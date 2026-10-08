import { invoke } from "@tauri-apps/api/core";
import type {
  AgentScheduleRecord,
  AgentScheduleRunRecord,
} from "@melody/agent-contract";

import { isTauriRuntime } from "./melody-bridge-runtime";

/**
 * Host-owned schedules.
 *
 * The Host persists the timer, decides what a missed trigger means and records
 * what actually happened, so the renderer only creates, inspects and changes
 * state; it never computes a fire time locally.
 */
export interface CreateAgentScheduleInput {
  scheduleId: string;
  sessionId: string;
  projectId: string;
  kind: "once" | "interval" | "cron";
  intervalMs?: number;
  runAt?: number;
  cron?: string;
  prompt: string;
  missedPolicy?: "skip" | "run-once";
  maxRuns?: number;
  expiresAt?: number;
  permissionMode: AgentScheduleRecord["permissionMode"];
  sessionModeId: string;
  modelId?: string;
  reasoningEffort?: string;
}

export const listAgentSchedules = async (
  sessionId?: string,
): Promise<AgentScheduleRecord[]> =>
  isTauriRuntime()
    ? invoke<AgentScheduleRecord[]>("list_agent_schedules", {
        sessionId: sessionId ?? null,
      })
    : [];

export const createAgentSchedule = async (
  input: CreateAgentScheduleInput,
): Promise<AgentScheduleRecord> =>
  invoke<AgentScheduleRecord>("create_agent_schedule", {
    request: {
      ...input,
      // The Host owns the clock: a renderer-computed start would let a stale
      // window shift when an interval begins.
      now: Date.now(),
    },
  });

export const setAgentScheduleStatus = async (
  scheduleId: string,
  status: "active" | "paused" | "cancelled",
): Promise<AgentScheduleRecord> =>
  invoke<AgentScheduleRecord>("set_agent_schedule_status", {
    scheduleId,
    status,
    now: Date.now(),
  });

export const listAgentScheduleRuns = async (
  scheduleId: string,
): Promise<AgentScheduleRunRecord[]> =>
  isTauriRuntime()
    ? invoke<AgentScheduleRunRecord[]>("list_agent_schedule_runs", {
        scheduleId,
      })
    : [];

export const deleteAgentSchedule = async (scheduleId: string): Promise<void> =>
  invoke("delete_agent_schedule", { scheduleId });
