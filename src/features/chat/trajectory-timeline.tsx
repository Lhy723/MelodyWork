import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import type {
  TrajectoryTimelineModel,
  TrajectoryRow,
} from "./trajectory-model";

interface TrajectoryTimelineProps {
  timeline: TrajectoryTimelineModel | undefined;
  turnStarts: number[];
  matchIds: Set<string> | undefined;
  actualDuration: boolean;
  selectedRowId: string | undefined;
  onSelectRow: (rowId: string) => void;
}

export function TrajectoryTimeline({
  timeline,
  turnStarts,
  matchIds,
  actualDuration,
  selectedRowId,
  onSelectRow,
}: TrajectoryTimelineProps) {
  return (
    <div className="harness-trajectory-timeline" aria-label="事件时间线">
      <div className="harness-trajectory-lane-labels">
        <span>Input</span>
        <span>Model</span>
        <span>Tools</span>
      </div>
      <div className="harness-trajectory-lanes">
        {turnStarts.map((start) => (
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
          const isSearchMatch = matchIds?.has(span.row.id);
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
                matchIds === undefined
                  ? undefined
                  : isSearchMatch
                    ? "true"
                    : "false"
              }
              key={span.row.id}
              onClick={() => onSelectRow(span.row.id)}
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
  );
}

export const rowMatchesQuery = (row: TrajectoryRow, query: string) =>
  `${row.label} ${row.summary} ${row.detail}`.toLowerCase().includes(query);
