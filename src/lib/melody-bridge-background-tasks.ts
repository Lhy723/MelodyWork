import { invoke } from "@tauri-apps/api/core";

import type {
  BackgroundTerminalTaskSnapshot,
  BackgroundTerminalTaskStatus,
} from "@/domain/agent/background-task-list";

import { isTauriRuntime } from "./melody-bridge-runtime";

/**
 * Host-owned background terminal tasks (`pi-terminal-task:*`).
 *
 * The Host registry is the only source of truth: a task is created by
 * `run_terminal_command` with `background: true` and stays listed after it
 * finishes until the bounded registry prunes it. Entries deliberately exclude
 * captured output so polling the panel stays cheap; the model reads output
 * through `get_command_or_subagent_output`.
 */

const KNOWN_STATUS: Record<string, true> = {
  running: true,
  completed: true,
  failed: true,
  cancelled: true,
};

/**
 * The Rust command returns raw JSON with snake_case keys. Normalise once here so
 * no feature component has to know the wire spelling.
 */
const toSnapshot = (value: unknown): BackgroundTerminalTaskSnapshot => {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const taskId = record?.task_id;
  const command = record?.command;
  const status = record?.status;
  const startedAt = record?.started_at;
  if (
    typeof taskId !== "string" ||
    !taskId.trim() ||
    typeof command !== "string" ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt)
  ) {
    throw new Error("宿主返回的后台终端任务格式无效。");
  }
  return {
    taskId,
    command,
    status:
      typeof status === "string" && KNOWN_STATUS[status] === true
        ? (status as BackgroundTerminalTaskStatus)
        : "unknown",
    startedAt,
  };
};

export const listBackgroundTerminalTasks = async (
  sessionId: string,
): Promise<BackgroundTerminalTaskSnapshot[]> => {
  if (!isTauriRuntime() || !sessionId) {
    return [];
  }
  const entries = await invoke<unknown[]>("list_background_terminal_tasks", {
    sessionId,
  });
  return Array.isArray(entries) ? entries.map(toSnapshot) : [];
};

export const cancelBackgroundTerminalTask = async (
  sessionId: string,
  taskId: string,
): Promise<BackgroundTerminalTaskSnapshot> => {
  if (!isTauriRuntime()) {
    throw new Error("后台终端任务只在桌面端可用。");
  }
  return toSnapshot(
    await invoke<unknown>("cancel_background_terminal_task", {
      sessionId,
      taskId,
    }),
  );
};
