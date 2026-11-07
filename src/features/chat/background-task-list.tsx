import { useId } from "react";

import type { BackgroundTaskRow } from "@/domain/agent/background-task-list";
import { cn } from "@/lib/utils";

interface BackgroundTaskListProps {
  className?: string;
  rows: BackgroundTaskRow[];
  stoppingTaskIds: ReadonlySet<string>;
  errors: Readonly<Record<string, string>>;
  onCancel: (taskId: string) => void;
}

const STATUS_TONE: Record<BackgroundTaskRow["status"], string> = {
  running: "text-primary",
  completed: "text-muted-foreground",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/**
 * Host-owned background terminal tasks for the session-info panel.
 *
 * Rows mirror the Host registry: only a running task can be stopped, and a stop
 * in flight disables its own button. Copy errors sit under the row they belong
 * to (`aria-describedby`) instead of a global banner, so stopping one task never
 * reads as a failure of the session.
 */
export function BackgroundTaskList({
  className,
  rows,
  stoppingTaskIds,
  errors,
  onCancel,
}: BackgroundTaskListProps) {
  const errorIdBase = useId();
  const running = rows.filter((row) => row.running);
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className={cn("w-full min-w-0 space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">后台终端任务</span>
        <span className="text-muted-foreground">
          {running.length > 0 ? `${running.length} 个运行中` : "无运行中任务"}
        </span>
      </div>
      <ul className="space-y-1 text-xs">
        {rows.map((row, index) => {
          const stopping = stoppingTaskIds.has(row.taskId);
          const error = errors[row.taskId];
          const errorId = `${errorIdBase}-${index}`;
          return (
            <li
              className="flex min-w-0 items-start justify-between gap-2"
              key={row.taskId}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono" title={row.command}>
                  {row.label}
                </span>
                {error ? (
                  <span className="block text-destructive" id={errorId}>
                    {error}
                  </span>
                ) : null}
              </span>
              <span
                className={cn(
                  "shrink-0",
                  error ? "text-destructive" : STATUS_TONE[row.status],
                )}
              >
                {stopping ? "停止中" : row.statusLabel}
              </span>
              {row.running ? (
                <button
                  aria-busy={stopping || undefined}
                  aria-describedby={error ? errorId : undefined}
                  aria-label={`停止后台任务：${row.command}`}
                  className="shrink-0 text-muted-foreground underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={stopping}
                  onClick={() => onCancel(row.taskId)}
                  type="button"
                >
                  停止
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
