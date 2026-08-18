import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  Clock3Icon,
  ListCollapseIcon,
  ListTreeIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import type { TimelineEntry } from "@/domain/acp";
import type { AgentToolOperation } from "@/domain/acp";
import { cn } from "@/lib/utils";

type TrajectoryRowKind = "input" | "model" | "think" | "tool" | "plan";
type TrajectoryRowState = "running" | "done" | "failed" | "pending";

interface TrajectoryRow {
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

interface TrajectoryTurn {
  id: string;
  number: number;
  rows: TrajectoryRow[];
  startedAt?: number;
  completedAt?: number;
}

type TrajectoryLane = 0 | 1 | 2;

interface TrajectoryTimelineSpan {
  row: TrajectoryRow;
  start: number;
  end: number;
  lane: TrajectoryLane;
}

interface TrajectoryTimelineModel {
  start: number;
  end: number;
  spans: TrajectoryTimelineSpan[];
}

const firstLine = (value: string) =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "";

const operationLabel = (operation: AgentToolOperation | undefined) => {
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

const deriveTurns = (entries: TimelineEntry[], now: number) => {
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

const formatDuration = (durationMs: number | undefined) => {
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

const formatTime = (timestamp: number | undefined) =>
  timestamp === undefined
    ? "—"
    : new Date(timestamp).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

const stateIcon = (state: TrajectoryRowState) => {
  if (state === "failed") {
    return CircleAlertIcon;
  }
  if (state === "done") {
    return CircleCheckIcon;
  }
  if (state === "pending") {
    return CircleDotIcon;
  }
  return Clock3Icon;
};

const laneForRow = (row: TrajectoryRow): TrajectoryLane => {
  if (row.kind === "input") {
    return 0;
  }
  if (row.kind === "model" || row.kind === "think" || row.kind === "plan") {
    return 1;
  }
  return 2;
};

/**
 * Project the ledger into the same compact three-lane model as Harness.
 *
 * The old implementation used CSS grid columns as a proxy for time. That
 * made every row occupy a full grid cell and let the grid's implicit sizing
 * stretch the plot vertically. A timeline needs one continuous numeric
 * domain instead: every span gets a start/end offset and a lane, then CSS
 * only positions it by percentage.
 */
const buildTimeline = (
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

interface TrajectoryViewProps {
  entries: TimelineEntry[];
  running: boolean;
}

export function TrajectoryView({ entries, running }: TrajectoryViewProps) {
  const [now, setNow] = useState(() => Date.now());
  const [actualDuration, setActualDuration] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(new Set());
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<string>();

  const turns = useMemo(() => deriveTurns(entries, now), [entries, now]);
  const allRows = useMemo(() => turns.flatMap((turn) => turn.rows), [turns]);
  const hasRunningRows =
    running || allRows.some((row) => row.state === "running");

  useEffect(() => {
    if (!hasRunningRows) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningRows]);

  const visibleTurns = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return turns
      .map((turn) => ({
        ...turn,
        rows: turn.rows.filter((row) => {
          if (callsCollapsed && row.kind === "tool") {
            return false;
          }
          if (!query) {
            return true;
          }
          return `${row.label} ${row.summary} ${row.detail}`
            .toLowerCase()
            .includes(query);
        }),
      }))
      .filter((turn) => turn.rows.length > 0);
  }, [callsCollapsed, searchQuery, turns]);

  const timeline = useMemo(
    () => buildTimeline(turns, actualDuration),
    [actualDuration, turns],
  );
  const timelineMatchIds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return undefined;
    }
    return new Set(
      allRows
        .filter((row) =>
          `${row.label} ${row.summary} ${row.detail}`
            .toLowerCase()
            .includes(query),
        )
        .map((row) => row.id),
    );
  }, [allRows, searchQuery]);

  const timelineTurnStarts = useMemo(() => {
    if (!timeline || turns.length < 2) {
      return [];
    }
    const startByRowId = new Map(
      timeline.spans.map((span) => [span.row.id, span.start]),
    );
    return turns.slice(1).flatMap((turn) => {
      const start = turn.rows[0]
        ? startByRowId.get(turn.rows[0].id)
        : undefined;
      return start === undefined ? [] : [start];
    });
  }, [timeline, turns]);

  const toggleTurn = (turnId: string) => {
    setCollapsedTurns((current) => {
      const next = new Set(current);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  };

  const allTurnsCollapsed =
    turns.length > 0 && turns.every((turn) => collapsedTurns.has(turn.id));

  return (
    <section className="harness-trajectory" aria-label="会话轨迹">
      <div
        className="harness-trajectory-toolbar"
        role="toolbar"
        aria-label="轨迹工具栏"
      >
        <div className="harness-trajectory-actions">
          <button
            aria-pressed={actualDuration}
            className="harness-trajectory-action"
            onClick={() => setActualDuration((value) => !value)}
            title={actualDuration ? "切换为等宽事件" : "按实际耗时显示"}
            type="button"
          >
            <Clock3Icon className="size-3.5" />
            Duration
          </button>
          <button
            aria-pressed={allTurnsCollapsed}
            className="harness-trajectory-action"
            onClick={() =>
              setCollapsedTurns(
                allTurnsCollapsed
                  ? new Set()
                  : new Set(turns.map((turn) => turn.id)),
              )
            }
            type="button"
          >
            <ListCollapseIcon className="size-3.5" />
            Turns
          </button>
          <button
            aria-pressed={callsCollapsed}
            className="harness-trajectory-action"
            onClick={() => setCallsCollapsed((value) => !value)}
            type="button"
          >
            <TerminalIcon className="size-3.5" />
            Calls
          </button>
        </div>
        <label className="harness-trajectory-search">
          <SearchIcon className="size-3.5" />
          <span className="sr-only">搜索轨迹</span>
          <input
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索"
            type="search"
            value={searchQuery}
          />
        </label>
      </div>

      <div className="harness-trajectory-timeline" aria-label="事件时间线">
        <div className="harness-trajectory-lane-labels">
          <span>Input</span>
          <span>Model</span>
          <span>Tools</span>
        </div>
        <div className="harness-trajectory-lanes">
          {timelineTurnStarts.map((start) => (
            <span
              aria-hidden="true"
              className="harness-trajectory-turn-boundary"
              key={start}
              style={{
                left: `${((start - (timeline?.start ?? 0)) / Math.max(1, (timeline?.end ?? 1) - (timeline?.start ?? 0))) * 100}%`,
              }}
            />
          ))}
          {timeline?.spans.map((span) => {
            const domain = Math.max(1, timeline.end - timeline.start);
            const isSearchMatch = timelineMatchIds?.has(span.row.id);
            return (
              <button
                aria-label={`${span.row.label} ${span.row.summary}`}
                className={cn(
                  "harness-trajectory-span",
                  span.row.id === selectedRowId && "is-selected",
                  span.row.state === "failed" && "is-error",
                )}
                data-equal-duration={!actualDuration || undefined}
                data-lane={span.lane}
                data-search-match={
                  timelineMatchIds === undefined
                    ? undefined
                    : isSearchMatch
                      ? "true"
                      : "false"
                }
                key={span.row.id}
                onClick={() => setSelectedRowId(span.row.id)}
                style={
                  {
                    "--trajectory-span-left": `${((span.start - timeline.start) / domain) * 100}%`,
                    "--trajectory-span-lane": span.lane,
                    "--trajectory-span-width": `${((span.end - span.start) / domain) * 100}%`,
                  } as CSSProperties
                }
                type="button"
              />
            );
          })}
          {!timeline ? (
            <div className="harness-trajectory-empty-lane">暂无轨迹事件</div>
          ) : null}
        </div>
      </div>

      <div
        className="harness-trajectory-table"
        role="table"
        aria-label="轨迹事件列表"
      >
        {visibleTurns.length === 0 ? (
          <div className="harness-trajectory-empty">
            <ListTreeIcon className="size-5" />
            <span>{searchQuery ? "没有匹配的事件" : "暂无轨迹事件"}</span>
          </div>
        ) : (
          visibleTurns.map((turn) => {
            const collapsed = collapsedTurns.has(turn.id);
            return (
              <section className="harness-trajectory-turn" key={turn.id}>
                <button
                  aria-expanded={!collapsed}
                  className="harness-trajectory-turn-header"
                  onClick={() => toggleTurn(turn.id)}
                  type="button"
                >
                  {collapsed ? (
                    <ChevronRightIcon className="size-3.5" />
                  ) : (
                    <ChevronDownIcon className="size-3.5" />
                  )}
                  <strong>Turn {turn.number}</strong>
                  <span>{turn.rows.length} 个事件</span>
                  <span className="harness-trajectory-turn-time">
                    {formatTime(turn.startedAt)}
                  </span>
                </button>
                {!collapsed ? (
                  <div className="harness-trajectory-turn-body">
                    <div className="harness-trajectory-column-head">
                      <span>Event</span>
                      <span>Summary</span>
                      <span>Duration</span>
                    </div>
                    {turn.rows.map((row) => {
                      const Icon = stateIcon(row.state);
                      const selected = selectedRowId === row.id;
                      return (
                        <div className="harness-trajectory-record" key={row.id}>
                          <button
                            aria-expanded={selected}
                            className={cn(
                              "harness-trajectory-row",
                              selected && "is-selected",
                              row.state === "failed" && "is-failed",
                            )}
                            onClick={() =>
                              setSelectedRowId((current) =>
                                current === row.id ? undefined : row.id,
                              )
                            }
                            type="button"
                          >
                            <span className="harness-trajectory-row-index">
                              {row.index + 1}
                            </span>
                            <span
                              className={cn(
                                "harness-trajectory-tag",
                                `tag-${row.kind}`,
                              )}
                            >
                              {row.label}
                            </span>
                            <span className="harness-trajectory-row-summary">
                              <span className="font-medium">{row.summary}</span>
                              {row.kind === "tool" && row.operation ? (
                                <span className="harness-trajectory-row-meta">
                                  · {operationLabel(row.operation)}
                                </span>
                              ) : null}
                            </span>
                            <span
                              className="harness-trajectory-row-state"
                              title={row.state}
                            >
                              <Icon className="size-3.5" />
                            </span>
                            <span className="harness-trajectory-row-duration">
                              {formatDuration(row.durationMs)}
                            </span>
                          </button>
                          {selected ? (
                            <div className="harness-trajectory-record-detail">
                              <div className="harness-trajectory-detail-meta">
                                <span>{row.label}</span>
                                <span>{formatTime(row.startedAt)}</span>
                                <span>{formatDuration(row.durationMs)}</span>
                              </div>
                              <pre>{row.detail || row.summary}</pre>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </div>
    </section>
  );
}
