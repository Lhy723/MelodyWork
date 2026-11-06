import {
  CheckCircle2Icon,
  CircleXIcon,
  LoaderCircleIcon,
  SendIcon,
} from "lucide-react";
import { useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toUserMessage } from "@/domain/app-error";
import type { AgentSubagent, TimelineEntry } from "@/domain/acp";
import type { ProjectReference } from "@/domain/message-citations";
import { AgentTimeline } from "@/features/chat/agent-timeline";
import { SubagentAvatar } from "@/features/chat/subagent-avatar";
import {
  isTauriRuntime,
  sendPiAgentCommand,
} from "@/lib/melody-bridge-runtime";
import { useAgentStore } from "@/stores/agent-store";

interface SubagentConversationProps {
  active: boolean;
  cwd: string;
  onOpenFile: (path: string) => void;
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
  onOpenFile,
  onOpenProjectReference,
  projectRoot,
  subagent,
}: SubagentConversationProps) {
  const [draft, setDraft] = useState("");
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string>();
  const timeline = useAgentStore((state) =>
    active
      ? (state.backgroundTimelines[subagent.childSessionId] ?? EMPTY_TIMELINE)
      : EMPTY_TIMELINE,
  );
  const resolvePermission = useAgentStore((state) => state.resolvePermission);
  const resolveQuestion = useAgentStore((state) => state.resolveQuestion);
  const canContinue =
    active &&
    subagent.status === "completed" &&
    !subagent.parentTaskId &&
    isTauriRuntime();
  const continueChild = async () => {
    const content = draft.trim();
    if (!canContinue || !content || continuing) return;
    setContinuing(true);
    setContinueError(undefined);
    try {
      await sendPiAgentCommand({
        protocolVersion: 1,
        requestId: `pi-child-continue-${crypto.randomUUID()}`,
        sessionId: subagent.parentSessionId,
        command: {
          type: "task.continue",
          sessionId: subagent.parentSessionId,
          taskId: subagent.subagentId,
          content,
        },
      });
      setDraft("");
    } catch (reason) {
      setContinueError(toUserMessage(reason, "无法继续该子会话。"));
    } finally {
      setContinuing(false);
    }
  };
  const status = statusContent(subagent);
  return (
    <section className="flex size-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b px-4 py-3">
        <div className="flex items-start gap-2.5">
          <SubagentAvatar
            className="mt-0.5"
            decorative
            size="md"
            subagent={subagent}
          />
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
          onOpenFile={onOpenFile}
          onOpenProjectReference={onOpenProjectReference}
          onPermission={resolvePermission}
          onQuestion={resolveQuestion}
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
              <SubagentAvatar
                className="mx-auto mb-3"
                decorative
                size="lg"
                subagent={subagent}
              />
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
      {canContinue ? (
        <form
          className="shrink-0 border-t bg-background p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void continueChild();
          }}
        >
          <div className="flex items-end gap-2">
            <Textarea
              aria-label="继续子会话"
              className="max-h-36 min-h-16 resize-y text-sm"
              disabled={continuing}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder="继续这个子会话…"
              value={draft}
            />
            <Button
              aria-label="发送续接消息"
              className="mb-0.5"
              disabled={
                continuing || !draft.trim() || Array.from(draft).length > 12_000
              }
              size="icon"
              type="submit"
            >
              {continuing ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <SendIcon />
              )}
            </Button>
          </div>
          {continueError ? (
            <p className="mt-2 text-destructive text-xs">{continueError}</p>
          ) : null}
          <p className="mt-1 text-muted-foreground text-[11px]">
            续接会恢复同一 Pi transcript 和原有权限上限（
            {Array.from(draft).length}/12000）
          </p>
        </form>
      ) : null}
    </section>
  );
}
