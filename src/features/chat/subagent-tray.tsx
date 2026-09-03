import { PresenceAvatars } from "@/components/interior/presence-avatars";
import type { AgentSubagent } from "@/domain/acp";
import { cn } from "@/lib/utils";
import { SubagentAvatar } from "./subagent-avatar";

interface SubagentTrayProps {
  className?: string;
  onOpenSubagent: (subagent: AgentSubagent) => void;
  subagents: AgentSubagent[];
}

const durationLabel = (durationMs?: number) => {
  if (durationMs === undefined) {
    return "刚刚";
  }
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
};

const statusLabel = (subagent: AgentSubagent) => {
  if (subagent.status === "running") {
    return `运行中 · ${durationLabel(subagent.durationMs)}`;
  }
  if (subagent.status === "failed") {
    return "运行失败";
  }
  if (subagent.status === "cancelled") {
    return "已取消";
  }
  return `已完成 · ${durationLabel(subagent.durationMs)}`;
};

export function SubagentTray({
  className,
  onOpenSubagent,
  subagents,
}: SubagentTrayProps) {
  const running = subagents.filter((subagent) => subagent.status === "running");
  const completed = subagents.filter(
    (subagent) => subagent.status !== "running",
  );

  return (
    <div className={cn("w-full min-w-0 overflow-hidden", className)}>
      <div className="flex min-w-0 items-center gap-2 px-2 py-1">
        <PresenceAvatars
          className="shrink-0"
          label="Subagents"
          max={4}
          people={subagents.map((subagent) => ({
            id: subagent.subagentId,
            name: subagent.description,
          }))}
          renderAvatar={(person) => {
            const subagent = subagents.find(
              (candidate) => candidate.subagentId === person.id,
            );
            return subagent ? (
              <button
                aria-label={`打开 Subagent：${subagent.description}`}
                className="block rounded-[22%] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpenSubagent(subagent)}
                title={`${subagent.description} · ${statusLabel(subagent)}`}
                type="button"
              >
                <SubagentAvatar decorative size="xs" subagent={subagent} />
              </button>
            ) : null;
          }}
          onOverflowSelect={(people) => {
            const subagent = subagents.find(
              (candidate) => candidate.subagentId === people[0]?.id,
            );
            if (subagent) onOpenSubagent(subagent);
          }}
          size="xs"
          overlap="tight"
        />
        <span className="min-w-0 truncate font-medium text-sm">Subagents</span>
        {running.length > 0 ? (
          <span className="flex min-w-0 shrink-0 items-center gap-1 text-primary text-xs">
            <span className="size-1.5 animate-pulse rounded-full bg-current" />
            {running.length} 运行中
            {completed.length > 0 ? (
              <span className="text-muted-foreground">
                · {completed.length} 已结束
              </span>
            ) : null}
          </span>
        ) : completed.length > 0 ? (
          <span className="shrink-0 text-muted-foreground text-xs">
            {completed.length} 已结束
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground text-xs">暂无</span>
        )}
      </div>
    </div>
  );
}
