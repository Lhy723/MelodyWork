import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "./melody-bridge-runtime";

/**
 * Host-owned monitor snapshots.
 *
 * A monitor is a long-running command whose merged stdout/stderr lines are
 * delivered as `task.notification` events. The snapshot is only an inspection
 * surface: the stream itself arrives through the normal agent event channel.
 */
export interface AgentMonitorSnapshot {
  taskId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "auto-stopped";
  description: string;
  persistent: boolean;
  emitted: number;
  output: string;
}

export interface StartAgentMonitorInput {
  sessionId: string;
  cwd: string;
  command: string;
  description: string;
  persistent?: boolean;
}

export const listAgentMonitors = async (): Promise<AgentMonitorSnapshot[]> =>
  isTauriRuntime() ? invoke<AgentMonitorSnapshot[]>("list_agent_monitors") : [];

export const startAgentMonitor = async ({
  sessionId,
  cwd,
  command,
  description,
  persistent = false,
}: StartAgentMonitorInput): Promise<AgentMonitorSnapshot> =>
  invoke<AgentMonitorSnapshot>("start_agent_monitor", {
    sessionId,
    cwd,
    command,
    description,
    persistent,
  });

export const cancelAgentMonitor = async (
  taskId: string,
): Promise<AgentMonitorSnapshot> =>
  invoke<AgentMonitorSnapshot>("cancel_agent_monitor", { taskId });
