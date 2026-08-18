import type { AgentContextUsage, TimelineEntry } from "@/domain/acp";

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

  return (
    <div className="harness-stats-line" aria-label="会话统计">
      <span>
        {turns} 轮 · {modelSteps} 步
      </span>
      <span className="harness-stats-divider">|</span>
      <span>{toolCalls} 次工具</span>
      <span className="harness-stats-divider">|</span>
      <span>
        LLM {formatDuration(llmDuration)} · 工具 {formatDuration(toolDuration)}
      </span>
      {modelName ? (
        <span className="harness-stats-muted">· {modelName}</span>
      ) : null}
      {contextPercent !== undefined ? (
        <>
          <span className="harness-stats-divider">|</span>
          <span>上下文 {contextPercent}%</span>
          <span className="harness-stats-muted">
            {formatTokens(contextUsage?.usedTokens)} /{" "}
            {formatTokens(contextUsage?.maxTokens)} tok
          </span>
        </>
      ) : null}
    </div>
  );
}
