import type {
  AgentBillingUsage,
  AgentContextUsage,
  TimelineEntry,
} from "./acp.ts";

type JsonObject = Record<string, unknown>;

export interface SessionUpdateResult {
  timeline: TimelineEntry[];
  error?: string;
  completed?: boolean;
  streaming?: boolean;
  contextUsage?: AgentContextUsage;
}

export interface SessionUpdateDependencies {
  objectValue: (value: unknown) => JsonObject | undefined;
  stringValue: (value: unknown) => string | undefined;
  appendUserChunk: (
    timeline: TimelineEntry[],
    update: JsonObject,
    eventId?: string,
  ) => TimelineEntry[];
  appendAgentChunk: (
    timeline: TimelineEntry[],
    text: string,
  ) => TimelineEntry[];
  appendThoughtChunk: (
    timeline: TimelineEntry[],
    text: string,
  ) => TimelineEntry[];
  appendAgentError: (
    timeline: TimelineEntry[],
    message: string,
  ) => TimelineEntry[];
  settleStreamingEntries: (timeline: TimelineEntry[]) => TimelineEntry[];
  stampLatestTurnAnalytics: (
    timeline: TimelineEntry[],
    usage: AgentContextUsage | undefined,
    billingUsage: AgentBillingUsage | undefined,
    reasoningEffort: string | undefined,
    sessionModeId: string | undefined,
  ) => TimelineEntry[];
  upsertTool: (timeline: TimelineEntry[], tool: JsonObject) => TimelineEntry[];
  contextUsageValue: (
    value: JsonObject | undefined,
  ) => AgentContextUsage | undefined;
  billingUsageValue: (
    value: JsonObject | undefined,
  ) => AgentBillingUsage | undefined;
}

/**
 * Apply one ACP session/update without touching the store or performing I/O.
 * The store supplies its timeline-normalization helpers; this module keeps
 * the event routing itself directly testable.
 */
export const applySessionUpdate = (
  timeline: TimelineEntry[],
  update: JsonObject | undefined,
  eventId: string | undefined,
  dependencies: SessionUpdateDependencies,
): SessionUpdateResult => {
  const updateType = dependencies.stringValue(update?.sessionUpdate);

  if (updateType === "usage_update") {
    return {
      timeline,
      contextUsage: dependencies.contextUsageValue(update),
    };
  }

  if (updateType === "user_message_chunk" && update) {
    return {
      timeline: dependencies.appendUserChunk(timeline, update, eventId),
    };
  }

  if (updateType === "agent_message_chunk") {
    const content = dependencies.objectValue(update?.content);
    const text = dependencies.stringValue(content?.text);
    if (text) {
      return {
        timeline: dependencies.appendAgentChunk(timeline, text),
        streaming: true,
      };
    }
    return { timeline };
  }

  if (updateType === "agent_thought_chunk") {
    const content = dependencies.objectValue(update?.content);
    const text = dependencies.stringValue(content?.text);
    if (text) {
      return {
        timeline: dependencies.appendThoughtChunk(timeline, text),
        streaming: true,
      };
    }
    return { timeline };
  }

  if (
    updateType === "retry_state" &&
    dependencies.stringValue(update?.type) === "failed"
  ) {
    const detail =
      dependencies.stringValue(update?.message) ?? "模型请求失败。";
    return {
      timeline: dependencies.appendAgentError(timeline, detail),
      error: detail,
    };
  }

  if (updateType === "turn_completed") {
    const billingUsage = dependencies.billingUsageValue(
      dependencies.objectValue(update?.usage),
    );
    const stopReason =
      dependencies.stringValue(update?.stopReason) ??
      dependencies.stringValue(update?.stop_reason);
    const detail =
      dependencies.stringValue(update?.agentResult) ??
      dependencies.stringValue(update?.agent_result);
    if (stopReason === "error") {
      const failure = detail ?? "本轮 Melody 对话发生错误。";
      return {
        timeline: dependencies.stampLatestTurnAnalytics(
          dependencies.appendAgentError(timeline, failure),
          undefined,
          billingUsage,
          undefined,
          undefined,
        ),
        error: failure,
        completed: true,
      };
    }
    return {
      timeline: dependencies.stampLatestTurnAnalytics(
        timeline,
        undefined,
        billingUsage,
        undefined,
        undefined,
      ),
      completed: true,
    };
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    return {
      timeline: dependencies.upsertTool(
        dependencies.settleStreamingEntries(timeline),
        update ?? {},
      ),
    };
  }

  return { timeline };
};
