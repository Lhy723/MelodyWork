import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  Clock3Icon,
  ListTreeIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import {
  formatDuration,
  formatTime,
  operationLabel,
  type TrajectoryRowState,
  type TrajectoryTurn,
} from "./trajectory-model";

interface TrajectoryTurnListProps {
  turns: TrajectoryTurn[];
  collapsedTurns: Set<string>;
  selectedRowId: string | undefined;
  searchQuery: string;
  onToggleTurn: (turnId: string) => void;
  onSelectRow: (rowId: string) => void;
}

const stateIcon = (state: TrajectoryRowState) => {
  if (state === "failed") return CircleAlertIcon;
  if (state === "done") return CircleCheckIcon;
  if (state === "pending") return CircleDotIcon;
  return Clock3Icon;
};

export function TrajectoryTurnList({
  turns,
  collapsedTurns,
  selectedRowId,
  searchQuery,
  onToggleTurn,
  onSelectRow,
}: TrajectoryTurnListProps) {
  return (
    <div
      className="harness-trajectory-table harness-trajectory-table--wipe"
      role="table"
      aria-label="轨迹事件列表"
    >
      {turns.length === 0 ? (
        <div className="harness-trajectory-empty">
          <ListTreeIcon className="size-5" />
          <span>{searchQuery ? "没有匹配的事件" : "暂无轨迹事件"}</span>
        </div>
      ) : (
        turns.map((turn) => {
          const collapsed = collapsedTurns.has(turn.id);
          return (
            <section className="harness-trajectory-turn" key={turn.id}>
              <button
                aria-expanded={!collapsed}
                className="harness-trajectory-turn-header"
                onClick={() => onToggleTurn(turn.id)}
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
                          onClick={() => onSelectRow(row.id)}
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
  );
}
