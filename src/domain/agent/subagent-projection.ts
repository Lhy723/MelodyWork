import type { AgentEventEnvelope } from "./contract.ts";
import type { AgentSubagent, AgentSubagentStatus } from "../acp.ts";

/**
 * The normalized protocol keeps task/subagent payloads deliberately open so a
 * worker can add engine-specific metrics without changing the wire contract.
 * This adapter is the one place where those values become the renderer's
 * stable AgentSubagent shape.
 */
export interface SubagentProjectionState {
  subagents: ReadonlyMap<string, AgentSubagent>;
}

export type SubagentProjectionResult =
  | {
      handled: true;
      state: SubagentProjectionState;
      subagent: AgentSubagent;
      previous?: AgentSubagent;
    }
  | {
      handled: false;
      state: SubagentProjectionState;
      reason: string;
      /** A task event without a child session is not a subagent event. */
      notApplicable?: boolean;
    };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const wireValue = (
  source: Record<string, unknown> | undefined,
  ...keys: string[]
): unknown => {
  if (!source) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
};

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

const statusValue = (value: unknown): AgentSubagentStatus | undefined => {
  const normalized = stringValue(value)?.toLowerCase().replaceAll("-", "_");
  if (!normalized) return undefined;
  if (
    normalized === "running" ||
    normalized === "pending" ||
    normalized === "queued" ||
    normalized === "starting" ||
    normalized === "in_progress" ||
    normalized === "active"
  ) {
    return "running";
  }
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "errored"
  ) {
    return "failed";
  }
  if (
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "aborted" ||
    normalized === "stopped"
  ) {
    return "cancelled";
  }
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "succeeded" ||
    normalized === "success" ||
    normalized === "done" ||
    normalized === "finished"
  ) {
    return "completed";
  }
  return undefined;
};

const metric = (
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined => finiteNonNegative(wireValue(source, ...keys));

const timestamp = (
  source: Record<string, unknown>,
  fallback: number,
  ...keys: string[]
) => metric(source, ...keys) ?? fallback;

const readStatus = (
  event: Extract<
    AgentEventEnvelope["event"],
    { type: "task.changed" | "subagent.changed" }
  >,
  payload: Record<string, unknown> | undefined,
) => statusValue(event.status) ?? statusValue(payload?.status);

const changed = (left: AgentSubagent, right: AgentSubagent): boolean => {
  const keys: Array<keyof AgentSubagent> = [
    "subagentId",
    "parentSessionId",
    "parentTaskId",
    "childSessionId",
    "subagentType",
    "description",
    "status",
    "startedAt",
    "updatedAt",
    "durationMs",
    "turnCount",
    "toolCallCount",
    "tokensUsed",
    "contextWindowTokens",
    "contextUsagePct",
    "errorCount",
    "error",
    "output",
    "model",
    "persona",
    "role",
    "capabilityMode",
    "resumedFrom",
    "isolation",
    "worktreePath",
  ];
  if (keys.some((key) => left[key] !== right[key])) return true;
  return (
    left.toolsUsed.length !== right.toolsUsed.length ||
    left.toolsUsed.some((tool, index) => tool !== right.toolsUsed[index])
  );
};

/**
 * Project one normalized task/subagent event. Generic task events are left as
 * auxiliary events until they carry a child session; this prevents ordinary
 * background tasks from appearing as fake subagents in the UI.
 */
export const projectSubagentEvent = (
  state: SubagentProjectionState,
  event: Extract<
    AgentEventEnvelope["event"],
    { type: "task.changed" | "subagent.changed" }
  >,
  parentSessionId: string | undefined,
  now = Date.now(),
): SubagentProjectionResult => {
  const payload = record(event.payload);
  const subagentId =
    stringValue(
      wireValue(payload, "subagentId", "subagent_id", "taskId", "task_id"),
    ) ?? stringValue(event.taskId);
  const current = subagentId ? state.subagents.get(subagentId) : undefined;
  const childSessionId =
    stringValue(event.childSessionId) ??
    stringValue(
      wireValue(
        payload,
        "childSessionId",
        "child_session_id",
        "sessionId",
        "session_id",
      ),
    ) ??
    current?.childSessionId;

  // A task.changed event can represent a non-agent background task. Do not
  // force it into AgentSubagent just because it has a task id.
  if (!childSessionId && event.type === "task.changed") {
    return {
      handled: false,
      state,
      reason: "task event has no child session",
      notApplicable: true,
    };
  }
  if (!subagentId || !childSessionId) {
    return {
      handled: false,
      state,
      reason: "subagent event is missing a stable id or child session",
    };
  }

  const nextStatus = readStatus(event, payload);
  if (!nextStatus && !current) {
    return {
      handled: false,
      state,
      reason: "subagent event has no recognized status",
    };
  }

  const source = payload ?? {};
  const durationMs =
    metric(source, "durationMs", "duration_ms") ?? current?.durationMs;
  const turnCount =
    metric(source, "turnCount", "turn_count", "turns") ?? current?.turnCount;
  const toolCallCount =
    metric(
      source,
      "toolCallCount",
      "tool_call_count",
      "toolCalls",
      "tool_calls",
    ) ?? current?.toolCallCount;
  const tokensUsed =
    metric(source, "tokensUsed", "tokens_used") ?? current?.tokensUsed;
  const contextWindowTokens =
    metric(source, "contextWindowTokens", "context_window_tokens") ??
    current?.contextWindowTokens;
  const contextUsagePct =
    metric(source, "contextUsagePct", "context_usage_pct") ??
    current?.contextUsagePct;
  const errorCount =
    metric(source, "errorCount", "error_count") ?? current?.errorCount;
  const parentTaskId =
    stringValue(wireValue(source, "parentTaskId", "parent_task_id")) ??
    stringValue(event.parentTaskId) ??
    current?.parentTaskId;

  const next: AgentSubagent = {
    subagentId,
    parentSessionId:
      stringValue(wireValue(source, "parentSessionId", "parent_session_id")) ??
      current?.parentSessionId ??
      parentSessionId ??
      "",
    ...(parentTaskId ? { parentTaskId } : {}),
    childSessionId,
    subagentType:
      stringValue(wireValue(source, "subagentType", "subagent_type", "type")) ??
      current?.subagentType ??
      "general-purpose",
    description:
      stringValue(
        wireValue(
          source,
          "description",
          "name",
          "title",
          "taskName",
          "task_name",
        ),
      ) ??
      current?.description ??
      "Subagent",
    status: nextStatus ?? current?.status ?? "running",
    startedAt: timestamp(
      source,
      current?.startedAt ?? now,
      "startedAt",
      "started_at",
    ),
    updatedAt: timestamp(
      source,
      now,
      "updatedAt",
      "updated_at",
      "finishedAt",
      "finished_at",
    ),
    toolsUsed:
      stringList(wireValue(source, "toolsUsed", "tools_used")) ??
      current?.toolsUsed ??
      [],
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(toolCallCount !== undefined ? { toolCallCount } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(contextUsagePct !== undefined ? { contextUsagePct } : {}),
    ...(errorCount !== undefined ? { errorCount } : {}),
  };

  const optionalStrings: Array<[keyof AgentSubagent, string[]]> = [
    ["error", ["error", "errorMessage", "error_message"]],
    ["output", ["output", "result"]],
    ["model", ["model", "modelId", "model_id"]],
    ["persona", ["persona"]],
    ["role", ["role"]],
    ["capabilityMode", ["capabilityMode", "capability_mode"]],
    ["resumedFrom", ["resumedFrom", "resumed_from"]],
    ["isolation", ["isolation"]],
    ["worktreePath", ["worktreePath", "worktree_path"]],
  ];
  for (const [key, keys] of optionalStrings) {
    const value = stringValue(wireValue(source, ...keys));
    if (value !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = value;
    } else if (current?.[key] !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = current[key];
    }
  }

  if (current && !changed(current, next)) {
    return { handled: true, state, subagent: current, previous: current };
  }
  const subagents = new Map(state.subagents);
  subagents.set(subagentId, next);
  return {
    handled: true,
    state: { subagents },
    subagent: next,
    ...(current ? { previous: current } : {}),
  };
};

export const createSubagentProjectionState = (
  subagents: Record<string, AgentSubagent> = {},
): SubagentProjectionState => ({
  subagents: new Map(Object.entries(subagents)),
});
