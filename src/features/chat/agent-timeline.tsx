import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
} from "@/components/ai-elements/tool";
import type { TimelineEntry } from "@/domain/acp";

interface AgentTimelineProps {
  entries: TimelineEntry[];
  onPermission: (entryId: string, optionId: string) => void;
}

const toolState = (
  permission: "pending" | "allowed" | "denied" | undefined,
  status: string | undefined,
) => {
  if (permission === "pending") {
    return "approval-requested" as const;
  }
  if (permission === "denied") {
    return "output-denied" as const;
  }
  if (status === "failed") {
    return "output-error" as const;
  }
  if (status === "completed") {
    return "output-available" as const;
  }
  if (permission === "allowed") {
    return "approval-responded" as const;
  }
  return "input-available" as const;
};

export function AgentTimeline({
  entries,
  onPermission,
}: AgentTimelineProps) {
  return (
    <Conversation className="min-h-0">
      <ConversationContent className="mx-auto w-full max-w-3xl gap-7 px-6 py-8">
        {entries.map((entry) => {
          if (entry.kind === "message") {
            return (
              <Message from={entry.role} key={entry.id}>
                <MessageContent>
                  <MessageResponse>{entry.content}</MessageResponse>
                </MessageContent>
              </Message>
            );
          }

          const state = toolState(entry.permission, entry.status);
          return (
            <Tool className="mb-0 rounded-xl" defaultOpen key={entry.id}>
              <ToolHeader
                state={state}
                title={entry.title}
                toolName="run_terminal_command"
                type="dynamic-tool"
              />
              <ToolContent className="flex flex-col gap-4">
                {entry.command || entry.output ? (
                  <pre className="overflow-x-auto rounded-lg bg-muted/50 p-4 font-mono text-xs leading-5">
                    {entry.command ? `$ ${entry.command}\n` : ""}
                    {entry.output}
                  </pre>
                ) : null}
                {entry.permission === "pending" ? (
                  <Confirmation approval={{ id: entry.id }} state={state}>
                    <ConfirmationRequest>
                      <ConfirmationTitle>
                        Melody wants permission to continue this tool call.
                      </ConfirmationTitle>
                      <ConfirmationActions>
                        {entry.permissionOptions?.map((option) => (
                          <ConfirmationAction
                            key={option.optionId}
                            onClick={() =>
                              onPermission(entry.id, option.optionId)
                            }
                            variant={
                              option.kind.startsWith("reject")
                                ? "ghost"
                                : option.kind === "allow_once"
                                  ? "outline"
                                  : "default"
                            }
                          >
                            {option.name}
                          </ConfirmationAction>
                        ))}
                        {entry.permissionOptions?.some((option) =>
                          option.kind.startsWith("reject"),
                        ) ? (
                          <ConfirmationAction
                            onClick={() =>
                              onPermission(entry.id, "project:deny")
                            }
                            variant="ghost"
                          >
                            Deny for project
                          </ConfirmationAction>
                        ) : null}
                        {entry.permissionOptions?.some((option) =>
                          option.kind.startsWith("allow"),
                        ) ? (
                          <ConfirmationAction
                            onClick={() =>
                              onPermission(entry.id, "project:allow")
                            }
                            variant="default"
                          >
                            Allow for project
                          </ConfirmationAction>
                        ) : null}
                      </ConfirmationActions>
                    </ConfirmationRequest>
                  </Confirmation>
                ) : null}
              </ToolContent>
            </Tool>
          );
        })}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
