import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { AgentContextUsage, TimelineEntry } from "@/domain/acp";
import { ActivityIcon, ChevronDownIcon } from "lucide-react";

interface SessionStatsLineProps {
  contextUsage?: AgentContextUsage;
  entries: TimelineEntry[];
  modelName?: string;
}

const formatDuration = (durationMs: number) => {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
};

const formatTokens = (tokens: number | undefined) => {
  if (tokens === undefined) {
    return "—";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
};

export function SessionStatsLine({
  contextUsage,
  entries,
  modelName,
}: SessionStatsLineProps) {
  const turns = entries.filter(
    (entry) => entry.kind === "message" && entry.role === "user",
  ).length;
  const modelSteps = entries.filter(
    (entry) => entry.kind === "message" && entry.role === "assistant",
  ).length;
  const toolCalls = entries.filter((entry) => entry.kind === "tool").length;
  const llmDuration = entries.reduce((total, entry) => {
    if (entry.kind !== "message" || entry.role !== "assistant") {
      return total;
    }
    return (
      total +
      (entry.startedAt !== undefined && entry.completedAt !== undefined
        ? Math.max(0, entry.completedAt - entry.startedAt)
        : 0)
    );
  }, 0);
  const toolDuration = entries.reduce((total, entry) => {
    if (entry.kind !== "tool") {
      return total;
    }
    return (
      total +
      (entry.startedAt !== undefined && entry.completedAt !== undefined
        ? Math.max(0, entry.completedAt - entry.startedAt)
        : 0)
    );
  }, 0);
  const contextPercent = contextUsage
    ? Math.round(
        (contextUsage.usedTokens / Math.max(1, contextUsage.maxTokens)) * 100,
      )
    : undefined;
  const contextProgress =
    contextPercent === undefined
      ? undefined
      : Math.min(100, Math.max(0, contextPercent));

  return (
    <Collapsible
      aria-label="会话运行统计"
      className="harness-stats-card"
      defaultOpen
    >
      <CollapsibleTrigger asChild>
        <button className="harness-stats-card-trigger group" type="button">
          <span className="harness-stats-card-heading">
            <span className="harness-stats-card-icon" aria-hidden="true">
              <ActivityIcon className="size-3.5" />
            </span>
            <span>运行统计</span>
          </span>
          <span className="harness-stats-card-summary">
            {turns} 轮 · {modelSteps} 步 · {toolCalls} 次工具
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className="harness-stats-card-chevron size-4"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="harness-stats-card-content">
        <div className="harness-stats-card-content-inner">
          <div className="harness-stats-metric-grid" aria-label="会话指标">
            <SessionMetric label="轮次" value={turns} />
            <SessionMetric label="步骤" value={modelSteps} />
            <SessionMetric label="工具调用" value={toolCalls} />
          </div>
          <div className="harness-stats-duration-grid">
            <SessionMetric
              label="LLM 耗时"
              value={formatDuration(llmDuration)}
            />
            <SessionMetric
              label="工具耗时"
              value={formatDuration(toolDuration)}
            />
          </div>
          {modelName ? (
            <div className="harness-stats-meta-row">
              <span>模型</span>
              <span title={modelName}>{modelName}</span>
            </div>
          ) : null}
          {contextPercent !== undefined ? (
            <div
              aria-label={`上下文使用 ${contextPercent}%`}
              className="harness-stats-context"
            >
              <div className="harness-stats-context-heading">
                <span>上下文用量</span>
                <span>{contextPercent}%</span>
              </div>
              <div
                aria-label="上下文使用"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={contextProgress}
                className="harness-stats-context-track"
                role="progressbar"
              >
                <span
                  className="harness-stats-context-fill"
                  style={{ width: `${contextProgress}%` }}
                />
              </div>
              <div className="harness-stats-context-caption">
                {formatTokens(contextUsage?.usedTokens)} /{" "}
                {formatTokens(contextUsage?.maxTokens)} tok
              </div>
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SessionMetric({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="harness-stats-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
