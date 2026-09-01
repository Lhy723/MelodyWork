import type { AgentToolOperation, TimelineEntry } from "@/domain/acp";

export type TrajectoryRowKind = "input" | "model" | "think" | "tool" | "plan";
export type TrajectoryRowState = "running" | "done" | "failed" | "pending";

export interface TrajectoryRow {
  id: string;
  index: number;
  kind: TrajectoryRowKind;
  label: string;
  summary: string;
  detail: string;
  state: TrajectoryRowState;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  operation?: AgentToolOperation;
}

export interface TrajectoryTurn {
  id: string;
  number: number;
  rows: TrajectoryRow[];
  startedAt?: number;
  completedAt?: number;
}

export type TrajectoryLane = 0 | 1 | 2;

export interface TrajectoryTimelineSpan {
  row: TrajectoryRow;
  start: number;
  end: number;
  lane: TrajectoryLane;
}

export interface TrajectoryTimelineModel {
  start: number;
  end: number;
  spans: TrajectoryTimelineSpan[];
}

const firstLine = (value: string) =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "";

export const operationLabel = (operation: AgentToolOperation | undefined) => {
  switch (operation) {
    case "read":
      return "Read";
    case "search":
      return "Search";
    case "create":
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "execute":
      return "Bash";
    default:
      return "Tool";
  }
};

const operationFromEntry = (entry: Extract<TimelineEntry, { kind: "tool" }>) =>
  entry.activity?.operation;

const toolState = (
  entry: Extract<TimelineEntry, { kind: "tool" }>,
): TrajectoryRowState => {
  if (entry.permission === "pending") {
    return "pending";
  }
  if (entry.permission === "denied" || entry.status === "failed") {
    return "failed";
  }
  if (entry.status === "completed") {
    return "done";
  }
  return "running";
};

const rowFromEntry = (
  entry: TimelineEntry,
  index: number,
  now: number,
): TrajectoryRow | undefined => {
  if (entry.kind === "message" && entry.role === "user") {
    return {
      id: entry.id,
      index,
      kind: "input",
      label: "USER",
      summary: firstLine(entry.content) || "输入消息",
      detail: entry.content,
      state: "done",
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      durationMs:
        entry.startedAt !== undefined && entry.completedAt !== undefined
          ? Math.max(0, entry.completedAt - entry.startedAt)
          : undefined,
    };
  }

  if (entry.kind === "message" && entry.role === "assistant") {
    const state: TrajectoryRowState = entry.streaming ? "running" : "done";
    return {
      id: entry.id,
      index,
      kind: "model",
      label: "MODEL",
      summary: firstLine(entry.content) || "模型响应",
      detail: entry.content,
      state,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      durationMs:
        entry.startedAt !== undefined
          ? Math.max(
              0,
              (entry.completedAt ?? (entry.streaming ? now : entry.startedAt)) -
                entry.startedAt,
            )
          : undefined,
    };
  }

  if (entry.kind === "thought") {
    const state: TrajectoryRowState = entry.streaming ? "running" : "done";
    return {
      id: entry.id,
      index,
      kind: "think",
      label: "THINK",
      summary: firstLine(entry.content) || "思考过程",
      detail: entry.content,
      state,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      durationMs:
        entry.startedAt !== undefined
          ? Math.max(
              0,
              (entry.completedAt ?? (entry.streaming ? now : entry.startedAt)) -
                entry.startedAt,
            )
          : undefined,
    };
  }

  if (entry.kind === "plan") {
    const state: TrajectoryRowState =
      entry.status === "streaming" ? "running" : "done";
    return {
      id: entry.id,
      index,
      kind: "plan",
      label: "PLAN",
      summary: `实施计划 · ${entry.status}`,
      detail: entry.content,
      state,
    };
  }

  if (entry.kind === "tool") {
    const operation = operationFromEntry(entry);
    const path = entry.activity?.path ?? entry.activity?.paths?.[0];
    const command = firstLine(entry.command);
    const output = firstLine(entry.output);
    const summary =
      path ??
      (operation === "search" && entry.activity?.query
        ? entry.activity.query
        : command || output || entry.title || "工具调用");
    const state = toolState(entry);
    return {
      id: entry.id,
      index,
      kind: "tool",
      label: operationLabel(operation).toUpperCase(),
      summary,
      detail: [entry.command, entry.output].filter(Boolean).join("\n\n"),
      state,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      durationMs:
        entry.startedAt !== undefined
          ? Math.max(
              0,
              (entry.completedAt ??
                (state === "running" ? now : entry.startedAt)) -
                entry.startedAt,
            )
          : undefined,
      operation,
    };
  }

  return undefined;
};

export const deriveTurns = (entries: TimelineEntry[], now: number) => {
  const turns: TrajectoryTurn[] = [];
  let current: TrajectoryTurn | undefined;
  let rowIndex = 0;

  const ensureTurn = () => {
    if (!current) {
      current = {
        id: `trajectory-turn-${turns.length + 1}`,
        number: turns.length + 1,
        rows: [],
      };
    }
    return current;
  };

  const finishTurn = () => {
    if (!current || current.rows.length === 0) {
      return;
    }
    current.startedAt = current.rows.find(
      (row) => row.startedAt !== undefined,
    )?.startedAt;
    current.completedAt = [...current.rows]
      .reverse()
      .find((row) => row.completedAt !== undefined)?.completedAt;
    turns.push(current);
    current = undefined;
  };

  for (const entry of entries) {
    if (
      entry.kind === "message" &&
      entry.role === "user" &&
      current?.rows.length
    ) {
      finishTurn();
    }
    const row = rowFromEntry(entry, rowIndex, now);
    rowIndex += 1;
    if (row) {
      ensureTurn().rows.push(row);
    }
  }
  finishTurn();
  return turns;
};

export const formatDuration = (durationMs: number | undefined) => {
  if (durationMs === undefined) {
    return "—";
  }
  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(totalSeconds >= 10 ? 0 : 1)}s`;
  }
  return `${Math.floor(totalSeconds / 60)}m${Math.round(totalSeconds % 60)}s`;
};

export const formatTime = (timestamp: number | undefined) =>
  timestamp === undefined
    ? "—"
    : new Date(timestamp).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

export const laneForRow = (row: TrajectoryRow): TrajectoryLane => {
  if (row.kind === "input") {
    return 0;
  }
  if (row.kind === "model" || row.kind === "think" || row.kind === "plan") {
    return 1;
  }
  return 2;
};

/** Project the ledger into a compact three-lane timeline. */
export const buildTimeline = (
  turns: TrajectoryTurn[],
  actualDuration: boolean,
): TrajectoryTimelineModel | undefined => {
  const rows = turns.flatMap((turn) => turn.rows);
  if (rows.length === 0) {
    return undefined;
  }

  if (!actualDuration) {
    return {
      start: 0,
      end: rows.length,
      spans: rows.map((row, index) => ({
        row,
        start: index,
        end: index + 1,
        lane: laneForRow(row),
      })),
    };
  }

  const hasRecordedTimes = rows.some(
    (row) => row.startedAt !== undefined && row.durationMs !== undefined,
  );
  if (!hasRecordedTimes) {
    return buildTimeline(turns, false);
  }

  let fallbackCursor = 0;
  const rawSpans = rows.map((row) => {
    const start = row.startedAt ?? fallbackCursor;
    const end = Math.max(start + 1, start + (row.durationMs ?? 1));
    fallbackCursor = end;
    return { row, start, end, lane: laneForRow(row) };
  });
  const firstStart = Math.min(...rawSpans.map((span) => span.start));
  let removedIdle = 0;
  let coveredUntil: number | undefined;
  const removedIdleBySpan = new Map<(typeof rawSpans)[number], number>();

  for (const span of [...rawSpans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    if (coveredUntil !== undefined && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil =
      coveredUntil === undefined ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans = rawSpans.map((span) => {
    const idle = removedIdleBySpan.get(span) ?? 0;
    return {
      ...span,
      start: span.start - firstStart - idle,
      end: span.end - firstStart - idle,
    };
  });
  return {
    start: 0,
    end: Math.max(1, ...spans.map((span) => span.end)),
    spans,
  };
};
