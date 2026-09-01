import {
  Clock3Icon,
  ListCollapseIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { TimelineEntry } from "@/domain/acp";

import { TrajectoryTimeline, rowMatchesQuery } from "./trajectory-timeline";
import { buildTimeline, deriveTurns } from "./trajectory-model";
import { TrajectoryTurnList } from "./trajectory-turn-list";

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

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleTurns = useMemo(
    () =>
      turns
        .map((turn) => ({
          ...turn,
          rows: turn.rows.filter((row) => {
            if (callsCollapsed && row.kind === "tool") {
              return false;
            }
            return !normalizedQuery || rowMatchesQuery(row, normalizedQuery);
          }),
        }))
        .filter((turn) => turn.rows.length > 0),
    [callsCollapsed, normalizedQuery, turns],
  );

  const timeline = useMemo(
    () => buildTimeline(turns, actualDuration),
    [actualDuration, turns],
  );
  const timelineMatchIds = useMemo(() => {
    if (!normalizedQuery) {
      return undefined;
    }
    return new Set(
      allRows
        .filter((row) => rowMatchesQuery(row, normalizedQuery))
        .map((row) => row.id),
    );
  }, [allRows, normalizedQuery]);

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
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
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

      <TrajectoryTimeline
        actualDuration={actualDuration}
        matchIds={timelineMatchIds}
        onSelectRow={setSelectedRowId}
        selectedRowId={selectedRowId}
        timeline={timeline}
        turnStarts={timelineTurnStarts}
      />
      <TrajectoryTurnList
        collapsedTurns={collapsedTurns}
        onSelectRow={(rowId) =>
          setSelectedRowId((current) => (current === rowId ? undefined : rowId))
        }
        onToggleTurn={toggleTurn}
        searchQuery={searchQuery}
        selectedRowId={selectedRowId}
        turns={visibleTurns}
      />
    </section>
  );
}
