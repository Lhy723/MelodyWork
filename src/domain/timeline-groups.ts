import type { TimelineEntry } from "@/domain/acp";

export type ToolTimelineEntry = Extract<TimelineEntry, { kind: "tool" }>;
export type ThoughtTimelineEntry = Extract<TimelineEntry, { kind: "thought" }>;
export type AssistantMessageTimelineEntry = Extract<
  TimelineEntry,
  { kind: "message" }
> & { role: "assistant" };
export type PlanTimelineEntry = Extract<TimelineEntry, { kind: "plan" }>;
type UserMessageTimelineEntry = Extract<TimelineEntry, { kind: "message" }> & {
  role: "user";
};

const isAssistantMessage = (
  entry: TimelineEntry,
): entry is AssistantMessageTimelineEntry =>
  entry.kind === "message" && entry.role === "assistant";

const isUserMessage = (
  entry: TimelineEntry,
): entry is UserMessageTimelineEntry =>
  entry.kind === "message" && entry.role === "user";

export type TurnActivityItem =
  | ThoughtTimelineEntry
  | AssistantMessageTimelineEntry
  | PlanTimelineEntry
  | {
      id: string;
      kind: "tool-group";
      tools: ToolTimelineEntry[];
    };

export type TimelineRenderEntry =
  | Extract<TimelineEntry, { kind: "message" }>
  | {
      id: string;
      kind: "activity-group";
      items: TurnActivityItem[];
      startedAt?: number;
      endedAt?: number;
      running: boolean;
      reviewPending?: boolean;
    };

const timestampFromId = (id: string): number | undefined => {
  const match = /(?:^|-)(\d{13})(?:-|$)/u.exec(id);
  if (!match) {
    return undefined;
  }
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const entryStartedAt = (
  entry: Extract<TimelineEntry, { kind: "message" | "thought" | "tool" }>,
) => entry.startedAt ?? timestampFromId(entry.id);

const entryCompletedAt = (
  entry: Extract<TimelineEntry, { kind: "message" | "thought" | "tool" }>,
) => entry.completedAt ?? entryStartedAt(entry);

const hasAssistantContent = (entry: AssistantMessageTimelineEntry) =>
  Boolean(entry.content.trim()) || Boolean(entry.attachments?.length);

export const toolIsRunning = (tool: ToolTimelineEntry, turnRunning = true) =>
  turnRunning &&
  tool.permission !== "denied" &&
  tool.status !== "cancelled" &&
  tool.status !== "failed" &&
  tool.status !== "completed";

export const groupTurnActivity = (
  entries: TimelineEntry[],
  turnRunning = false,
): TimelineRenderEntry[] => {
  const result: TimelineRenderEntry[] = [];
  let turnUserMessage: UserMessageTimelineEntry | undefined;
  let turnEntries: TimelineEntry[] = [];

  const flushTurn = (running: boolean, inferRunning = false) => {
    let latestWorkIndex = -1;
    let finalAssistantIndex = -1;
    turnEntries.forEach((entry, index) => {
      if (
        entry.kind === "thought" ||
        entry.kind === "tool" ||
        entry.kind === "plan"
      ) {
        latestWorkIndex = index;
      }
    });
    turnEntries.forEach((entry, index) => {
      if (
        isAssistantMessage(entry) &&
        hasAssistantContent(entry) &&
        index > latestWorkIndex
      ) {
        finalAssistantIndex = index;
      }
    });
    const finalAssistant =
      finalAssistantIndex >= 0
        ? (turnEntries[finalAssistantIndex] as AssistantMessageTimelineEntry)
        : undefined;
    const activityRunning =
      running ||
      Boolean(finalAssistant?.streaming) ||
      (inferRunning &&
        turnEntries.some((entry) =>
          entry.kind === "thought"
            ? Boolean(entry.streaming)
            : entry.kind === "tool"
              ? toolIsRunning(entry)
              : entry.kind === "plan"
                ? entry.status === "streaming"
                : isAssistantMessage(entry) && Boolean(entry.streaming),
        ));
    const hasActivity = turnEntries.some(
      (entry) =>
        entry.kind === "thought" ||
        entry.kind === "tool" ||
        entry.kind === "plan",
    );
    const pendingWithoutActivity = activityRunning && turnEntries.length === 0;

    if (turnUserMessage) {
      result.push(turnUserMessage);
    }

    if (hasActivity || pendingWithoutActivity) {
      const items: TurnActivityItem[] = [];
      let pendingTools: ToolTimelineEntry[] = [];
      const flushTools = () => {
        if (pendingTools.length === 0) {
          return;
        }
        items.push({
          id: `tool-group-${pendingTools[0].id}`,
          kind: "tool-group",
          tools: pendingTools,
        });
        pendingTools = [];
      };

      turnEntries.forEach((entry, index) => {
        if (isAssistantMessage(entry)) {
          if (!hasAssistantContent(entry) || index === finalAssistantIndex)
            return;
          flushTools();
          items.push(entry);
          return;
        }
        if (entry.kind === "message") return;
        if (entry.kind === "tool") {
          pendingTools.push(entry);
          return;
        }
        flushTools();
        items.push(entry);
      });
      flushTools();

      const timedEntries = turnEntries.filter(
        (
          entry,
        ): entry is Extract<
          TimelineEntry,
          { kind: "message" | "thought" | "tool" }
        > =>
          entry.kind === "message" ||
          entry.kind === "thought" ||
          entry.kind === "tool",
      );
      const firstTimedEntry = timedEntries[0];
      const lastTimedEntry = timedEntries.at(-1);
      const startedAt = turnUserMessage
        ? (entryStartedAt(turnUserMessage) ??
          (firstTimedEntry ? entryStartedAt(firstTimedEntry) : undefined))
        : firstTimedEntry
          ? entryStartedAt(firstTimedEntry)
          : undefined;
      const endedAt = finalAssistant
        ? entryCompletedAt(finalAssistant)
        : lastTimedEntry
          ? entryCompletedAt(lastTimedEntry)
          : undefined;
      const reviewPending = items.some(
        (item) => item.kind === "plan" && item.status === "awaiting-approval",
      );

      result.push({
        id:
          items.length === 0 && turnUserMessage
            ? `activity-group-pending-${turnUserMessage.id}`
            : `activity-group-${items[0]?.id ?? turnUserMessage?.id ?? "pending"}`,
        kind: "activity-group",
        items,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
        running: activityRunning,
        ...(reviewPending ? { reviewPending: true } : {}),
      });
    } else {
      turnEntries.forEach((entry, index) => {
        if (
          isAssistantMessage(entry) &&
          hasAssistantContent(entry) &&
          index !== finalAssistantIndex
        ) {
          result.push(entry);
        }
      });
    }

    if (finalAssistant) {
      result.push(finalAssistant);
    }

    turnUserMessage = undefined;
    turnEntries = [];
  };

  for (const entry of entries) {
    if (isUserMessage(entry)) {
      flushTurn(false);
      turnUserMessage = entry;
      continue;
    }
    turnEntries.push(entry);
  }
  flushTurn(turnRunning, true);

  return result;
};
