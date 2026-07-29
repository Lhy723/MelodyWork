import {
  BotIcon,
  CheckCircle2Icon,
  CircleXIcon,
  LoaderCircleIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AgentSubagent } from "@/domain/acp";
import { cn } from "@/lib/utils";

interface SubagentTrayProps {
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

const StatusIcon = ({ status }: Pick<AgentSubagent, "status">) => {
  if (status === "running") {
    return <LoaderCircleIcon className="size-3.5 animate-spin text-primary" />;
  }
  if (status === "completed") {
    return <CheckCircle2Icon className="size-3.5 text-emerald-600" />;
  }
  return <CircleXIcon className="size-3.5 text-destructive" />;
};

export function SubagentTray({
  onOpenSubagent,
  subagents,
}: SubagentTrayProps) {
  const running = subagents.filter((subagent) => subagent.status === "running");
  const completed = subagents.filter(
    (subagent) => subagent.status !== "running",
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl justify-end px-4 pb-2 sm:px-6">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            className="gap-1.5 rounded-full bg-background/90 shadow-sm backdrop-blur"
            size="sm"
            variant="outline"
          >
            <BotIcon />
            <span>Subagents</span>
            {running.length > 0 ? (
              <span className="flex items-center gap-1 text-primary">
                <span className="size-1.5 animate-pulse rounded-full bg-current" />
                {running.length} 运行中
              </span>
            ) : (
              <span className="text-muted-foreground">
                {completed.length > 0 ? `${completed.length} 已完成` : "0"}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(25rem,calc(100vw-2rem))] p-2"
          side="top"
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <div>
              <h2 className="font-medium text-sm">Subagents</h2>
              <p className="text-muted-foreground text-xs">
                点击查看独立会话历史
              </p>
            </div>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums">
              {subagents.length}
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {subagents.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <BotIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
                <p className="font-medium text-xs">还没有 Subagent</p>
                <p className="mt-1 text-muted-foreground text-[11px]">
                  主代理委派任务后，会在这里显示运行状态。
                </p>
              </div>
            ) : null}
            {running.length > 0 ? (
              <section>
                <p className="px-2 py-1.5 font-medium text-muted-foreground text-[11px] uppercase tracking-wide">
                  正在运行
                </p>
                {running.map((subagent) => (
                  <SubagentRow
                    key={subagent.subagentId}
                    onOpen={onOpenSubagent}
                    subagent={subagent}
                  />
                ))}
              </section>
            ) : null}
            {completed.length > 0 ? (
              <section>
                <p
                  className={cn(
                    "px-2 py-1.5 font-medium text-muted-foreground text-[11px] uppercase tracking-wide",
                    running.length > 0 && "mt-1 border-t pt-2.5",
                  )}
                >
                  已结束
                </p>
                {completed.map((subagent) => (
                  <SubagentRow
                    key={subagent.subagentId}
                    onOpen={onOpenSubagent}
                    subagent={subagent}
                  />
                ))}
              </section>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SubagentRow({
  onOpen,
  subagent,
}: {
  onOpen: (subagent: AgentSubagent) => void;
  subagent: AgentSubagent;
}) {
  return (
    <button
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(subagent)}
      type="button"
    >
      <span className="mt-0.5">
        <StatusIcon status={subagent.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-xs">
          {subagent.description}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-[11px]">
          <span>{subagent.subagentType}</span>
          <span aria-hidden="true">·</span>
          <span>{statusLabel(subagent)}</span>
        </span>
      </span>
      {subagent.toolCallCount !== undefined ? (
        <span className="mt-0.5 shrink-0 text-muted-foreground text-[11px] tabular-nums">
          {subagent.toolCallCount} 工具
        </span>
      ) : null}
    </button>
  );
}
