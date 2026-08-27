import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Task, TaskContent, TaskTrigger } from "@/components/ai-elements/task";
import type { AgentQuestionResponse } from "@/domain/acp";
import type { TurnActivityItem } from "@/domain/timeline-groups";
import { ToolTaskGroup } from "@/features/chat/tool-task-group";
import { cn } from "@/lib/utils";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

interface TurnActivityGroupProps {
  cwd: string;
  endedAt?: number;
  items: TurnActivityItem[];
  onPermission: (entryId: string, optionId: string) => void;
  onQuestion: (
    entryId: string,
    response: AgentQuestionResponse,
  ) => void | Promise<void>;
  onOpenFile: (path: string) => void;
  projectRoot: string;
  running: boolean;
  startedAt?: number;
}

const formatDuration = (durationMs: number | undefined) => {
  if (durationMs === undefined) {
    return undefined;
  }
  if (durationMs < 1000) {
    return "不足 1 秒";
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
};

export const TurnActivityGroup = memo(function TurnActivityGroup({
  cwd,
  endedAt,
  items,
  onPermission,
  onQuestion,
  onOpenFile,
  projectRoot,
  running,
  startedAt,
}: TurnActivityGroupProps) {
  const [open, setOpen] = useState(running);
  const [now, setNow] = useState(() => Date.now());
  const [completionPulse, setCompletionPulse] = useState(false);
  const wasRunning = useRef(running);

  useEffect(() => {
    if (!running) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (running && !wasRunning.current) {
      setCompletionPulse(false);
      setOpen(true);
    }
    if (!running && wasRunning.current) {
      setCompletionPulse(true);
      const closeTimer = window.setTimeout(() => setOpen(false), 800);
      const pulseTimer = window.setTimeout(
        () => setCompletionPulse(false),
        480,
      );
      wasRunning.current = running;
      return () => {
        window.clearTimeout(closeTimer);
        window.clearTimeout(pulseTimer);
      };
    }
    wasRunning.current = running;
  }, [running]);

  const duration =
    startedAt === undefined
      ? undefined
      : Math.max(0, (running ? now : (endedAt ?? now)) - startedAt);
  const durationLabel = formatDuration(duration);
  const title = running
    ? `正在处理${durationLabel ? ` · 已用时 ${durationLabel}` : ""}`
    : `已完成${durationLabel ? ` · 总用时 ${durationLabel}` : ""}`;

  return (
    <Task
      className="harness-activity-group w-full"
      data-completion-pulse={completionPulse ? "true" : undefined}
      onOpenChange={setOpen}
      open={open}
    >
      <TaskTrigger title={title}>
        <button
          className="harness-activity-trigger group flex min-h-7 w-full items-center gap-2 text-left text-sm leading-5 text-muted-foreground transition-colors hover:text-foreground"
          type="button"
        >
          {running ? (
            <LoaderCircleIcon
              aria-hidden="true"
              className="motion-activity-state-icon size-4 shrink-0 animate-spin"
            />
          ) : (
            <CheckCircle2Icon
              aria-hidden="true"
              className="motion-activity-state-icon size-4 shrink-0"
            />
          )}
          <span className="font-medium">{title}</span>
          <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </TaskTrigger>
      <TaskContent className="harness-activity-content [&>div]:mt-1.5 [&>div]:space-y-2 [&>div]:border-l-0 [&>div]:pl-4">
        {items.map((item) =>
          item.kind === "thought" ? (
            <Reasoning
              className={cn("mb-0", item.streaming && "py-0.5")}
              isStreaming={item.streaming}
              key={item.id}
            >
              <ReasoningTrigger
                className="min-h-6 text-sm"
                getThinkingMessage={(isStreaming, thoughtDuration) =>
                  isStreaming
                    ? "正在思考…"
                    : thoughtDuration === undefined
                      ? "思考过程"
                      : `思考了 ${thoughtDuration} 秒`
                }
              />
              <ReasoningContent className="mt-2">
                {item.content}
              </ReasoningContent>
            </Reasoning>
          ) : (
            <ToolTaskGroup
              cwd={cwd}
              key={item.id}
              onPermission={onPermission}
              onQuestion={onQuestion}
              onOpenFile={onOpenFile}
              projectRoot={projectRoot}
              turnRunning={running}
              tools={item.tools}
            />
          ),
        )}
      </TaskContent>
    </Task>
  );
});
