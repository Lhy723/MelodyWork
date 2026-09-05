import { Popover } from "@/components/interior/popover";
import { PresenceAvatars } from "@/components/interior/presence-avatars";
import type { AgentSubagent } from "@/domain/acp";
import { cn } from "@/lib/utils";
import { useState } from "react";
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
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null);
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
              <Popover
                align="start"
                className="w-64 p-3"
                label={`Subagent：${subagent.description}`}
                onOpenChange={(open) =>
                  setOpenSubagentId(open ? subagent.subagentId : null)
                }
                open={openSubagentId === subagent.subagentId}
                side="bottom"
                trigger={
                  <SubagentAvatar decorative size="xs" subagent={subagent} />
                }
                triggerAriaLabel={`查看 Subagent：${subagent.description}`}
                triggerClassName="size-5 rounded-[22%] border-0 bg-transparent p-0 shadow-none hover:bg-transparent"
              >
                <div className="space-y-3">
                  <div className="space-y-1">
                    <p className="font-medium text-sm">
                      {subagent.description}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {statusLabel(subagent)}
                    </p>
                  </div>
                  <button
                    className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-primary px-3 font-medium text-primary-foreground text-sm outline-none transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring/40"
                    onClick={() => {
                      setOpenSubagentId(null);
                      onOpenSubagent(subagent);
                    }}
                    type="button"
                  >
                    打开会话
                  </button>
                </div>
              </Popover>
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
