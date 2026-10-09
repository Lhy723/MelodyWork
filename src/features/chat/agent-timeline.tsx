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
import { Button } from "@/components/ui/button";
import { CornerUpLeft, GitBranchPlus, LoaderCircle } from "lucide-react";
import type {
  AgentPlanDecision,
  AgentQuestionResponse,
  TimelineEntry,
} from "@/domain/acp";
import type { ProjectReference } from "@/domain/message-citations";
import { groupTurnActivity } from "@/domain/timeline-groups";
import { MessageCitations } from "@/features/chat/message-citations";
import { MessageCodeBlock } from "@/features/chat/message-code-block";
import { ProjectInlineCitation } from "@/features/chat/project-inline-citation";
import { TurnActivityGroup } from "@/features/chat/turn-activity-group";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";

const CJK = /[\u2e80-\u9fff]/u;
const STREAMING_REVEAL_RECENT_COMPLETION_MS = 2_000;

type AssistantMessageEntry = Extract<TimelineEntry, { kind: "message" }>;

type AssistantMessageTextProps = {
  components: ComponentProps<typeof MessageResponse>["components"];
  entry: AssistantMessageEntry;
  turnRunning: boolean;
};

function AssistantMessageText({
  components,
  entry,
  turnRunning,
}: AssistantMessageTextProps) {
  const recentlyCompleted =
    !entry.streaming &&
    entry.completedAt !== undefined &&
    Date.now() - entry.completedAt <= STREAMING_REVEAL_RECENT_COMPLETION_MS;
  const previousContentRef = useRef(entry.content);
  const contentGrew =
    entry.content.length > previousContentRef.current.length &&
    entry.content.startsWith(previousContentRef.current);
  const hasStreamedRef = useRef(Boolean(entry.streaming) || recentlyCompleted);
  const isAnimating =
    Boolean(entry.streaming) ||
    contentGrew ||
    recentlyCompleted ||
    (turnRunning && hasStreamedRef.current);

  const separator: "word" | "char" = CJK.test(entry.content) ? "char" : "word";
  const animated = useMemo(
    () => ({
      animation: "text-reveal" as const,
      duration: 600,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      sep: separator,
      stagger: separator === "char" ? 28 : 55,
    }),
    [separator],
  );

  useEffect(() => {
    if (isAnimating) {
      hasStreamedRef.current = true;
    }
    previousContentRef.current = entry.content;
  }, [entry.content, isAnimating]);

  return (
    <MessageResponse
      animated={animated}
      components={components}
      isAnimating={isAnimating}
    >
      {entry.content}
    </MessageResponse>
  );
}

interface AgentTimelineProps {
  cwd: string;
  entries: TimelineEntry[];
  onPermission: (entryId: string, optionId: string) => void;
  onPlanDecision: (
    entryId: string,
    outcome: AgentPlanDecision,
    feedback?: string,
  ) => void | Promise<void>;
  onQuestion: (
    entryId: string,
    response: AgentQuestionResponse,
  ) => void | Promise<void>;
  onOpenFile: (path: string) => void;
  onOpenProjectReference: (reference: ProjectReference) => void;
  onExplore?: (entry: AssistantMessageEntry) => void | Promise<void>;
  onBringBack?: (entry: AssistantMessageEntry) => void | Promise<void>;
  bringBackAfterNativeEntryId?: string;
  projectRoot: string;
  turnRunning?: boolean;
}

export function AgentTimeline({
  cwd,
  entries,
  onPermission,
  onPlanDecision,
  onQuestion,
  onOpenFile,
  onOpenProjectReference,
  onExplore,
  onBringBack,
  bringBackAfterNativeEntryId,
  projectRoot,
  turnRunning = false,
}: AgentTimelineProps) {
  const [forkingEntryId, setForkingEntryId] = useState<string>();
  const [bringingBackEntryId, setBringingBackEntryId] = useState<string>();
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
    () => groupTurnActivity(entries, turnRunning),
    [entries, turnRunning],
  );
  const messageIndexById = useMemo(() => {
    const indexes = new Map<string, number>();
    entries.forEach((entry, index) => {
      if (entry.kind === "message" && !indexes.has(entry.id)) {
        indexes.set(entry.id, index);
      }
    });
    return indexes;
  }, [entries]);
  const bringBackAnchorIndex = useMemo(
    () =>
      bringBackAfterNativeEntryId
        ? entries.findIndex(
            (entry) =>
              entry.kind === "message" &&
              entry.nativeEntryId === bringBackAfterNativeEntryId,
          )
        : -1,
    [bringBackAfterNativeEntryId, entries],
  );

  const renderMessage = (
    entry: AssistantMessageEntry,
    motionStyle?: ComponentProps<typeof Message>["style"],
  ) => {
    const messageIndex = messageIndexById.get(entry.id) ?? -1;
    const canBringBack =
      Boolean(onBringBack) &&
      entry.role === "assistant" &&
      Boolean(entry.nativeEntryId) &&
      !entry.streaming &&
      bringBackAnchorIndex >= 0 &&
      messageIndex > bringBackAnchorIndex;
    return (
      <Message
        className="harness-chat-message motion-list-item"
        from={entry.role}
        key={entry.id}
        style={
          motionStyle ?? {
            animationDelay: `${Math.min(Math.max(messageIndex, 0), 6) * 24}ms`,
          }
        }
      >
        <MessageContent className="harness-chat-message-content">
          {entry.attachments?.length ? (
            <Attachments
              className={entry.role === "user" ? "justify-end" : ""}
              variant="inline"
            >
              {entry.attachments.map((attachment) => (
                <Attachment data={attachment} key={attachment.id}>
                  <AttachmentPreview />
                  <AttachmentInfo />
                </Attachment>
              ))}
            </Attachments>
          ) : null}
          {entry.role === "assistant" ? (
            <AssistantMessageText
              components={messageComponents}
              entry={entry}
              turnRunning={turnRunning}
            />
          ) : (
            <MessageResponse components={messageComponents}>
              {entry.content}
            </MessageResponse>
          )}
          {entry.streaming ? (
            <span aria-hidden="true" className="motion-streaming-indicator" />
          ) : null}
          {entry.role === "assistant" ? (
            <MessageCitations content={entry.content} />
          ) : null}
        </MessageContent>
        {entry.role === "assistant" &&
        entry.nativeEntryId &&
        !entry.streaming &&
        (onExplore || canBringBack) ? (
          <div className="mt-1 flex justify-end gap-1">
            {onExplore ? (
              <Button
                aria-label="从此处创建探索分支"
                disabled={turnRunning || Boolean(forkingEntryId)}
                onClick={() => {
                  setForkingEntryId(entry.id);
                  void Promise.resolve()
                    .then(() => onExplore(entry))
                    .catch(() => undefined)
                    .finally(() => setForkingEntryId(undefined));
                }}
                size="sm"
                variant="ghost"
              >
                <GitBranchPlus aria-hidden="true" />
                {forkingEntryId === entry.id ? "正在创建…" : "从此处探索"}
              </Button>
            ) : null}
            {canBringBack && onBringBack ? (
              <Button
                aria-label="将探索分支引用插入主会话草稿"
                disabled={turnRunning || Boolean(bringingBackEntryId)}
                onClick={() => {
                  setBringingBackEntryId(entry.id);
                  void Promise.resolve()
                    .then(() => onBringBack(entry))
                    .catch(() => undefined)
                    .finally(() => setBringingBackEntryId(undefined));
                }}
                size="sm"
                variant="ghost"
              >
                {bringingBackEntryId === entry.id ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <CornerUpLeft aria-hidden="true" />
                )}
                {bringingBackEntryId === entry.id
                  ? "正在插入…"
                  : "带回分支引用"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Message>
    );
  };

  return (
    <Conversation className="harness-chat-scroll min-h-0">
      <ConversationContent
        className="harness-chat-content mx-auto w-full max-w-3xl gap-5 px-4 py-8 sm:px-6"
        scrollClassName="harness-chat-scroll-viewport"
      >
        {renderEntries.map((entry, index) => {
          const motionStyle = {
            animationDelay: `${Math.min(index, 6) * 24}ms`,
          };

          if (entry.kind === "message") {
            return renderMessage(entry, motionStyle);
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
                onPlanDecision={onPlanDecision}
                onQuestion={onQuestion}
                onOpenFile={onOpenFile}
                projectRoot={projectRoot}
                messageComponents={messageComponents}
                renderAssistantMessage={renderMessage}
                reviewPending={entry.reviewPending}
                running={entry.running}
                startedAt={entry.startedAt}
              />
            </div>
          );
        })}
      </ConversationContent>
      <ConversationScrollButton className="harness-chat-scroll-button" />
    </Conversation>
  );
}
