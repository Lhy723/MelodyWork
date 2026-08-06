import {
  BotIcon,
  CheckCircle2Icon,
  CircleXIcon,
  LoaderCircleIcon,
} from "lucide-react";

import { MessageResponse } from "@/components/ai-elements/message";
import type { AgentSubagent, TimelineEntry } from "@/domain/acp";
import type { ProjectReference } from "@/domain/message-citations";
import { AgentTimeline } from "@/features/chat/agent-timeline";
import { useAgentStore } from "@/stores/agent-store";

interface SubagentConversationProps {
  active: boolean;
  cwd: string;
  onOpenProjectReference: (reference: ProjectReference) => void;
  projectRoot: string;
  subagent: AgentSubagent;
}

const EMPTY_TIMELINE: TimelineEntry[] = [];

const statusContent = (subagent: AgentSubagent) => {
  if (subagent.status === "running") {
    return {
      icon: <LoaderCircleIcon className="size-3.5 animate-spin text-primary" />,
      label: "正在运行",
    };
  }
  if (subagent.status === "completed") {
    return {
      icon: <CheckCircle2Icon className="size-3.5 text-emerald-600" />,
      label: "已完成",
    };
  }
  return {
    icon: <CircleXIcon className="size-3.5 text-destructive" />,
    label: subagent.status === "failed" ? "运行失败" : "已取消",
  };
};

export function SubagentConversation({
  active,
  cwd,
  onOpenProjectReference,
  projectRoot,
  subagent,
}: SubagentConversationProps) {
  const timeline = useAgentStore(
    (state) =>
      active
        ? (state.backgroundTimelines[subagent.childSessionId] ?? EMPTY_TIMELINE)
        : EMPTY_TIMELINE,
  );
  const status = statusContent(subagent);
  return (
    <section className="flex size-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted">
            <BotIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-medium text-sm">
              {subagent.description}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
              <span className="flex items-center gap-1">
                {status.icon}
                {status.label}
              </span>
              <span>{subagent.subagentType}</span>
              {subagent.model ? <span>{subagent.model}</span> : null}
              {subagent.turnCount !== undefined ? (
                <span>{subagent.turnCount} 轮</span>
              ) : null}
              {subagent.toolCallCount !== undefined ? (
                <span>{subagent.toolCallCount} 次工具调用</span>
              ) : null}
            </div>
          </div>
        </div>
        {subagent.error ? (
          <p className="mt-2 rounded-md bg-destructive/10 px-2.5 py-2 text-destructive text-xs">
            {subagent.error}
          </p>
        ) : null}
      </header>
      {timeline.length > 0 ? (
        <AgentTimeline
          cwd={cwd}
          entries={timeline}
          onOpenProjectReference={onOpenProjectReference}
          onPermission={() => undefined}
          onPlanDecision={() => undefined}
          projectRoot={projectRoot}
          turnRunning={subagent.status === "running"}
        />
      ) : subagent.output ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-2 font-medium text-muted-foreground text-xs">
            最终输出
          </p>
          <MessageResponse>{subagent.output}</MessageResponse>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <div>
            {subagent.status === "running" ? (
              <LoaderCircleIcon className="mx-auto mb-3 size-5 animate-spin text-muted-foreground" />
            ) : (
              <BotIcon className="mx-auto mb-3 size-5 text-muted-foreground" />
            )}
            <p className="font-medium text-sm">
              {subagent.status === "running"
                ? "正在等待会话记录"
                : "没有可显示的会话记录"}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              {subagent.status === "running"
                ? "Subagent 的消息和工具调用会在这里实时显示。"
                : "该 Subagent 没有返回可回放的内容。"}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
