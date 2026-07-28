import type { TimelineEntry } from "@/domain/acp";

export type ToolTimelineEntry = Extract<TimelineEntry, { kind: "tool" }>;
export type ThoughtTimelineEntry = Extract<TimelineEntry, { kind: "thought" }>;

export type TurnActivityItem =
  | ThoughtTimelineEntry
  | {
      id: string;
      kind: "tool-group";
      tools: ToolTimelineEntry[];
    };

export type TimelineRenderEntry =
  | Exclude<TimelineEntry, { kind: "tool" | "thought" }>
  | {
      id: string;
      kind: "activity-group";
      items: TurnActivityItem[];
      startedAt?: number;
      endedAt?: number;
      running: boolean;
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

const toolIsRunning = (tool: ToolTimelineEntry) =>
  tool.permission !== "denied" &&
  tool.status !== "failed" &&
  tool.status !== "completed";

export const groupTurnActivity = (
  entries: TimelineEntry[],
): TimelineRenderEntry[] => {
  const result: TimelineRenderEntry[] = [];
  let activity: Array<ThoughtTimelineEntry | ToolTimelineEntry> = [];
  let turnStartedAt: number | undefined;

  const flushActivity = (nextEntry?: TimelineEntry) => {
    if (activity.length === 0) {
      return;
    }

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

    for (const entry of activity) {
      if (entry.kind === "tool") {
        pendingTools.push(entry);
      } else {
        flushTools();
        items.push(entry);
      }
    }
    flushTools();

    const running =
      nextEntry?.kind === "message" && nextEntry.role === "assistant"
        ? Boolean(nextEntry.streaming)
        : nextEntry === undefined &&
          activity.some((entry) =>
            entry.kind === "thought"
              ? Boolean(entry.streaming)
              : toolIsRunning(entry),
          );
    const startedAt = turnStartedAt ?? entryStartedAt(activity[0]);
    const endedAt =
      nextEntry?.kind === "message" && nextEntry.role === "assistant"
        ? entryCompletedAt(nextEntry)
        : undefined;

    result.push({
      id: `activity-group-${activity[0].id}`,
      kind: "activity-group",
      items,
      startedAt,
      endedAt,
      running,
    });
    activity = [];
  };

  for (const entry of entries) {
    if (entry.kind === "tool" || entry.kind === "thought") {
      activity.push(entry);
      continue;
    }
    flushActivity(entry);
    if (entry.kind === "message" && entry.role === "user") {
      turnStartedAt = entryStartedAt(entry);
    }
    result.push(entry);
  }
  flushActivity();
  return result;
};
