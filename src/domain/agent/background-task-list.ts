/**
 * Pure view model for Host-owned background terminal tasks.
 *
 * The Host registry is the source of truth; this module only decides what the
 * session panel shows. It stays framework-free so the ordering and the
 * stop-result merge can be tested without a React tree or a Tauri bridge.
 */

export type BackgroundTerminalTaskStatus =
  "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface BackgroundTerminalTaskSnapshot {
  taskId: string;
  command: string;
  status: BackgroundTerminalTaskStatus;
  /** Unix milliseconds recorded when the Host accepted the task. */
  startedAt: number;
}

export interface BackgroundTaskRow {
  taskId: string;
  /** Full command, used for the accessible name and the native tooltip. */
  command: string;
  /** Single-line, length-bounded command shown in the row. */
  label: string;
  status: BackgroundTerminalTaskStatus;
  statusLabel: string;
  running: boolean;
}

/** The panel keeps a short tail of finished work so "已停止" has a place to land. */
export const FINISHED_TASK_LIMIT = 5;

const LABEL_MAX_CHARS = 72;

const STATUS_LABELS: Record<BackgroundTerminalTaskStatus, string> = {
  running: "运行中",
  completed: "已结束",
  failed: "失败",
  cancelled: "已停止",
  unknown: "未知",
};

const rowLabel = (command: string): string => {
  const singleLine = command.replaceAll(/\s+/gu, " ").trim();
  if (singleLine.length <= LABEL_MAX_CHARS) {
    return singleLine;
  }
  return `${singleLine.slice(0, LABEL_MAX_CHARS - 1)}…`;
};

/** Running tasks first (newest first), then the most recent finished ones. */
export const backgroundTaskRows = (
  tasks: readonly BackgroundTerminalTaskSnapshot[],
): BackgroundTaskRow[] => {
  const newestFirst = [...tasks].sort(
    (left, right) => right.startedAt - left.startedAt,
  );
  const running = newestFirst.filter((task) => task.status === "running");
  const finished = newestFirst
    .filter((task) => task.status !== "running")
    .slice(0, FINISHED_TASK_LIMIT);
  return [...running, ...finished].map((task) => ({
    taskId: task.taskId,
    command: task.command,
    label: rowLabel(task.command),
    status: task.status,
    statusLabel: STATUS_LABELS[task.status],
    running: task.status === "running",
  }));
};

export type BackgroundCancelOutcome =
  | { ok: true; task: BackgroundTerminalTaskSnapshot }
  | { ok: false; message: string };

/**
 * Merge one stop request into the visible rows.
 *
 * Success replaces the row with the Host's snapshot, which is how a stop that
 * races a natural exit still lands on "已结束" instead of an error. Failure
 * leaves the rows untouched and hands the caller a message for that row.
 */
export const applyCancelResult = (
  tasks: readonly BackgroundTerminalTaskSnapshot[],
  taskId: string,
  outcome: BackgroundCancelOutcome,
): { tasks: BackgroundTerminalTaskSnapshot[]; error?: string } => {
  if (!outcome.ok) {
    return { tasks: [...tasks], error: outcome.message };
  }
  const index = tasks.findIndex((task) => task.taskId === taskId);
  if (index < 0) {
    return { tasks: [...tasks] };
  }
  return {
    tasks: tasks.map((task, taskIndex) =>
      taskIndex === index ? outcome.task : task,
    ),
  };
};
