import type { AgentSubagent } from "@/domain/acp";

import {
  numberValue,
  stringValue,
  wireValue,
} from "./agent-store-parsing";

export const applySubagentUpdate = (
  subagents: Record<string, AgentSubagent>,
  update: Record<string, unknown> | undefined,
  routedSessionId: string,
  startsFullReplay: boolean,
): Record<string, AgentSubagent> => {
  const updateType = stringValue(update?.sessionUpdate);
  let next = subagents;
  if (startsFullReplay) {
    next = Object.fromEntries(
      Object.entries(subagents).filter(
        ([, subagent]) => subagent.parentSessionId !== routedSessionId,
      ),
    );
  }
  if (
    updateType !== "subagent_spawned" &&
    updateType !== "subagent_progress" &&
    updateType !== "subagent_finished"
  ) {
    return next;
  }

  const subagentId = stringValue(
    wireValue(update, "subagentId", "subagent_id"),
  );
  const childSessionId = stringValue(
    wireValue(update, "childSessionId", "child_session_id"),
  );
  if (!subagentId || !childSessionId) {
    return next;
  }

  const now = Date.now();
  const current = next[subagentId];
  if (updateType === "subagent_spawned") {
    const parentSessionId =
      stringValue(wireValue(update, "parentSessionId", "parent_session_id")) ??
      routedSessionId;
    return {
      ...next,
      [subagentId]: {
        subagentId,
        parentSessionId,
        childSessionId,
        subagentType:
          stringValue(wireValue(update, "subagentType", "subagent_type")) ??
          "general-purpose",
        description: stringValue(update?.description) ?? "Subagent",
        status: "running",
        startedAt: current?.startedAt ?? now,
        updatedAt: now,
        toolsUsed: current?.toolsUsed ?? [],
        model: stringValue(update?.model),
        persona: stringValue(update?.persona),
        role: stringValue(update?.role),
        capabilityMode: stringValue(
          wireValue(update, "capabilityMode", "capability_mode"),
        ),
        resumedFrom: stringValue(
          wireValue(update, "resumedFrom", "resumed_from"),
        ),
      },
    };
  }

  if (!current) {
    return next;
  }
  if (updateType === "subagent_progress") {
    const toolsUsed = wireValue(update, "toolsUsed", "tools_used");
    return {
      ...next,
      [subagentId]: {
        ...current,
        updatedAt: now,
        durationMs: numberValue(wireValue(update, "durationMs", "duration_ms")),
        turnCount: numberValue(wireValue(update, "turnCount", "turn_count")),
        toolCallCount: numberValue(
          wireValue(update, "toolCallCount", "tool_call_count"),
        ),
        tokensUsed: numberValue(wireValue(update, "tokensUsed", "tokens_used")),
        contextWindowTokens: numberValue(
          wireValue(update, "contextWindowTokens", "context_window_tokens"),
        ),
        contextUsagePct: numberValue(
          wireValue(update, "contextUsagePct", "context_usage_pct"),
        ),
        toolsUsed: Array.isArray(toolsUsed)
          ? toolsUsed.filter((tool): tool is string => typeof tool === "string")
          : current.toolsUsed,
        errorCount: numberValue(wireValue(update, "errorCount", "error_count")),
      },
    };
  }

  const status = stringValue(update?.status);
  return {
    ...next,
    [subagentId]: {
      ...current,
      status:
        status === "failed" || status === "cancelled" ? status : "completed",
      updatedAt: now,
      durationMs:
        numberValue(wireValue(update, "durationMs", "duration_ms")) ??
        current.durationMs,
      turnCount:
        numberValue(update?.turns) ??
        numberValue(wireValue(update, "turnCount", "turn_count")) ??
        current.turnCount,
      toolCallCount:
        numberValue(wireValue(update, "toolCalls", "tool_calls")) ??
        numberValue(wireValue(update, "toolCallCount", "tool_call_count")) ??
        current.toolCallCount,
      tokensUsed:
        numberValue(wireValue(update, "tokensUsed", "tokens_used")) ??
        current.tokensUsed,
      error: stringValue(update?.error),
      output: stringValue(update?.output),
    },
  };
};
