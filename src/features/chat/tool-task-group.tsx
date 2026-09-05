import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Task, TaskContent, TaskTrigger } from "@/components/ai-elements/task";
import type { AgentQuestionResponse } from "@/domain/acp";
import type { ToolTimelineEntry } from "@/domain/timeline-groups";
import { QuestionPrompt } from "@/features/chat/question-prompt";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";

import { FileChangeRow, ToolRow } from "./tool-task-rows";
import { groupTitle, isRunning, operationIcon } from "./tool-task-utils";

interface ToolTaskGroupProps {
  cwd: string;
  onPermission: (entryId: string, optionId: string) => void;
  onQuestion: (
    entryId: string,
    response: AgentQuestionResponse,
  ) => void | Promise<void>;
  onOpenFile: (path: string) => void;
  projectRoot: string;
  turnRunning: boolean;
  tools: ToolTimelineEntry[];
}

export function ToolTaskGroup({
  cwd,
  onPermission,
  onQuestion,
  onOpenFile,
  projectRoot,
  turnRunning,
  tools,
}: ToolTaskGroupProps) {
  const running = tools.some(isRunning);
  const [open, setOpen] = useState(turnRunning);
  const wasTurnRunning = useRef(turnRunning);

  useEffect(() => {
    if (turnRunning && !wasTurnRunning.current) {
      setOpen(true);
    }
    if (!turnRunning && wasTurnRunning.current) {
      const timer = window.setTimeout(() => setOpen(false), 800);
      wasTurnRunning.current = turnRunning;
      return () => window.clearTimeout(timer);
    }
    wasTurnRunning.current = turnRunning;
  }, [turnRunning]);

  const headerOperation =
    tools.find(
      (tool) =>
        tool.activity?.files?.length ||
        tool.activity?.operation === "edit" ||
        tool.activity?.operation === "create",
    )?.activity?.operation ??
    tools[0]?.activity?.operation ??
    "other";
  const HeaderIcon = tools.some((tool) => tool.question)
    ? MessageCircleQuestionIcon
    : operationIcon(headerOperation);
  const title = groupTitle(tools);

  return (
    <Task
      className="harness-tool-group w-full"
      onOpenChange={setOpen}
      open={open}
    >
      <TaskTrigger title={title}>
        <button
          className="harness-tool-trigger group flex min-h-7 w-full items-center gap-2 text-left text-sm leading-5 text-muted-foreground transition-colors hover:text-foreground"
          type="button"
        >
          <HeaderIcon className="size-4 shrink-0" />
          <span className="min-w-0 truncate font-medium">{title}</span>
          {running ? (
            <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
          ) : null}
          <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </TaskTrigger>
      <TaskContent className="harness-tool-content [&>div]:mt-1 [&>div]:space-y-0.5 [&>div]:border-l-0 [&>div]:pl-5 [&>div]:text-sm [&>div]:leading-5">
        {tools.flatMap((tool) => {
          if (tool.question) {
            return [
              <QuestionPrompt
                entry={tool}
                key={`${tool.id}-question`}
                onResolve={onQuestion}
              />,
            ];
          }
          const changes = tool.activity?.files ?? [];
          const changePaths = new Set(changes.map((change) => change.path));
          const extraPaths = (tool.activity?.paths ?? []).filter(
            (path) => !changePaths.has(path),
          );
          const rows = [
            ...changes.map((change) => (
              <FileChangeRow
                change={change}
                cwd={cwd}
                key={`${tool.id}-${change.path}`}
                onOpenFile={onOpenFile}
                projectRoot={projectRoot}
                running={isRunning(tool)}
              />
            )),
            ...extraPaths.map((path) => (
              <ToolRow
                cwd={cwd}
                key={`${tool.id}-${path}`}
                onOpenFile={onOpenFile}
                pathOverride={path}
                projectRoot={projectRoot}
                tool={tool}
              />
            )),
          ];
          if (rows.length === 0) {
            rows.push(
              <ToolRow
                cwd={cwd}
                key={tool.id}
                onOpenFile={onOpenFile}
                projectRoot={projectRoot}
                tool={tool}
              />,
            );
          }
          if (tool.permission !== "pending") {
            return rows;
          }
          return [
            ...rows,
            <Confirmation
              approval={{ id: tool.id }}
              className="motion-view-enter ml-6"
              key={`${tool.id}-permission`}
              state="approval-requested"
            >
              <ConfirmationRequest>
                <ConfirmationTitle>
                  Melody 需要你的授权才能继续执行此步骤。
                </ConfirmationTitle>
                <ConfirmationActions className="max-w-full flex-wrap justify-start">
                  {tool.permissionOptions?.map((option) => (
                    <ConfirmationAction
                      key={option.optionId}
                      onClick={() => onPermission(tool.id, option.optionId)}
                      variant={
                        option.kind.startsWith("reject")
                          ? "ghost"
                          : option.kind === "allow_once"
                            ? "outline"
                            : "default"
                      }
                    >
                      {option.kind === "reject_once"
                        ? "拒绝一次"
                        : option.kind === "reject_always"
                          ? "始终拒绝"
                          : option.kind === "allow_once"
                            ? "允许一次"
                            : "始终允许"}
                    </ConfirmationAction>
                  ))}
                  {tool.permissionOptions?.some((option) =>
                    option.kind.startsWith("reject"),
                  ) ? (
                    <ConfirmationAction
                      onClick={() => onPermission(tool.id, "project:deny")}
                      variant="ghost"
                    >
                      对项目拒绝
                    </ConfirmationAction>
                  ) : null}
                  {tool.permissionOptions?.some((option) =>
                    option.kind.startsWith("allow"),
                  ) ? (
                    <ConfirmationAction
                      onClick={() => onPermission(tool.id, "project:allow")}
                      variant="default"
                    >
                      对项目允许
                    </ConfirmationAction>
                  ) : null}
                </ConfirmationActions>
              </ConfirmationRequest>
            </Confirmation>,
          ];
        })}
      </TaskContent>
    </Task>
  );
}
