import { cn } from "@/lib/utils";
import type { AgentMonitorNotification } from "@/domain/agent/event-to-session-update";
import type { AgentMonitorSnapshot } from "@/lib/melody-bridge-monitors";

interface MonitorFeedProps {
  className?: string;
  monitorNotifications: AgentMonitorNotification[];
  monitors: AgentMonitorSnapshot[];
  onCancelMonitor?: (taskId: string) => void;
}

const statusLabel: Record<AgentMonitorSnapshot["status"], string> = {
  running: "运行中",
  completed: "已结束",
  failed: "失败",
  cancelled: "已停止",
  "auto-stopped": "事件过多已自动停止",
};

const timeLabel = (receivedAt: number) =>
  new Date(receivedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * Host-owned monitor feed for the session-info panel.
 *
 * A monitor streams each output line as an event rather than a chat message, so
 * the lines are rendered here with the monitor's own label. The list is the
 * bounded ring the projection keeps, which means a chatty monitor cannot push
 * message history out of the panel.
 */
export function MonitorFeed({
  className,
  monitorNotifications,
  monitors,
  onCancelMonitor,
}: MonitorFeedProps) {
  const running = monitors.filter((monitor) => monitor.status === "running");
  if (monitors.length === 0 && monitorNotifications.length === 0) {
    return null;
  }
  // Newest first: the newest events are what the user is watching for.
  const recent = [...monitorNotifications].reverse().slice(0, 40);

  return (
    <div className={cn("w-full min-w-0 space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">监视器</span>
        <span className="text-muted-foreground">
          {running.length > 0 ? `${running.length} 个运行中` : "无运行中监视器"}
        </span>
      </div>
      {monitors.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {monitors.map((monitor) => (
            <li
              className="flex min-w-0 items-center justify-between gap-2"
              key={monitor.taskId}
            >
              <span className="min-w-0 truncate" title={monitor.description}>
                {monitor.description}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {statusLabel[monitor.status]} · {monitor.emitted} 行
              </span>
              {monitor.status === "running" && onCancelMonitor ? (
                <button
                  className="shrink-0 text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => onCancelMonitor(monitor.taskId)}
                  type="button"
                >
                  停止
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {recent.length > 0 ? (
        <ul className="space-y-1 font-mono text-[11px] leading-relaxed">
          {recent.map((notification) => (
            <li
              className="flex min-w-0 gap-2"
              key={`${notification.taskId}:${notification.sequence}`}
            >
              <span className="shrink-0 text-muted-foreground">
                {timeLabel(notification.receivedAt)}
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-words">
                <span className="text-muted-foreground">
                  [{notification.description}]
                </span>{" "}
                {notification.line}
                {notification.truncated ? " …" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
