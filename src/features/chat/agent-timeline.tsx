import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
} from "@/components/ai-elements/attachments";
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
import type {
  AgentPlanDecision,
  TimelineEntry,
} from "@/domain/acp";
import type { ProjectReference } from "@/domain/message-citations";
import { groupTurnActivity } from "@/domain/timeline-groups";
import { MessageCitations } from "@/features/chat/message-citations";
import { MessageCodeBlock } from "@/features/chat/message-code-block";
import { PlanTimelineEntry } from "@/features/chat/plan-timeline-entry";
import { ProjectInlineCitation } from "@/features/chat/project-inline-citation";
import { TurnActivityGroup } from "@/features/chat/turn-activity-group";
import { useMemo, type ComponentProps } from "react";

interface AgentTimelineProps {
  cwd: string;
  entries: TimelineEntry[];
  onPermission: (entryId: string, optionId: string) => void;
  onPlanDecision: (
    entryId: string,
    outcome: AgentPlanDecision,
    feedback?: string,
  ) => void;
  onOpenProjectReference: (reference: ProjectReference) => void;
  projectRoot: string;
}

export function AgentTimeline({
  cwd,
  entries,
  onPermission,
  onPlanDecision,
  onOpenProjectReference,
  projectRoot,
}: AgentTimelineProps) {
  const messageComponents = useMemo(
    () => ({
      code: MessageCodeBlock,
      inlineCode: (props: ComponentProps<"code"> & { node?: unknown }) => (
        <ProjectInlineCitation
          {...props}
          cwd={cwd}
          onOpenReference={onOpenProjectReference}
          projectRoot={projectRoot}
        />
      ),
    }),
    [cwd, onOpenProjectReference, projectRoot],
  );
  const renderEntries = useMemo(
    () => groupTurnActivity(entries),
    [entries],
  );

  return (
    <Conversation className="min-h-0">
      <ConversationContent className="mx-auto w-full max-w-5xl gap-3 px-4 py-8 sm:px-6">
        {renderEntries.map((entry, index) => {
          const motionStyle = {
            animationDelay: `${Math.min(index, 6) * 24}ms`,
          };

          if (entry.kind === "message") {
            return (
              <Message
                className="motion-list-item"
                from={entry.role}
                key={entry.id}
                style={motionStyle}
              >
                <MessageContent>
                  {entry.attachments?.length ? (
                    <Attachments
                      className={entry.role === "user" ? "justify-end" : ""}
                      variant="inline"
                    >
                      {entry.attachments.map((attachment) => (
                        <Attachment
                          data={attachment}
                          key={attachment.id}
                        >
                          <AttachmentPreview />
                          <AttachmentInfo />
                        </Attachment>
                      ))}
                    </Attachments>
                  ) : null}
                  <MessageResponse components={messageComponents}>
                    {entry.content}
                  </MessageResponse>
                  {entry.role === "assistant" ? (
                    <MessageCitations content={entry.content} />
                  ) : null}
                </MessageContent>
              </Message>
            );
          }

          if (entry.kind === "plan") {
            return (
              <div
                className="motion-list-item w-full"
                key={entry.id}
                style={motionStyle}
              >
                <PlanTimelineEntry
                  entry={entry}
                  onDecision={onPlanDecision}
                  renderedContent={
                    <MessageResponse components={messageComponents}>
                      {entry.content}
                    </MessageResponse>
                  }
                />
              </div>
            );
          }

          return (
            <div
              className="motion-list-item w-full"
              key={entry.id}
              style={motionStyle}
            >
              <TurnActivityGroup
                cwd={cwd}
                endedAt={entry.endedAt}
                items={entry.items}
                onPermission={onPermission}
                projectRoot={projectRoot}
                running={entry.running}
                startedAt={entry.startedAt}
              />
            </div>
          );
        })}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
