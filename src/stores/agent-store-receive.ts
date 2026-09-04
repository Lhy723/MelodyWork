import { toUserMessage as reasonMessage } from "@/domain/app-error";
import { upsertPlanApproval } from "@/domain/plan-approval";
import {
  applySessionUpdate,
  contextUsageFromTotalTokens,
  isPromptCompleteMethod,
  isSessionUpdateMethod,
  notificationMetadata,
  stampLatestTurnContextUsage,
  type SessionUpdateResult,
} from "@/domain/session-projection";
import { sessionModeIdFromUpdate } from "@/domain/session-mode";
import {
  isUserQuestionMethod,
  parseUserQuestionRequest,
} from "@/domain/user-question";
import { applySubagentUpdate } from "./agent-store-subagents";
import {
  directSessionUpdate,
  extractSessionUpdateParams,
  objectValue,
  questionEntryForRequest,
  stringValue,
  contextUsageForModel,
  modelOptionsFromUpdate,
  wireValue,
} from "./agent-store-parsing";
import {
  cancelledPromptIds,
  clearTransientState,
  fullReplayStarted,
  markPromptActivity,
  pendingPromptForSession,
  pendingPrompts,
  pendingUserEchoBlocks,
  pruneTransientState,
  removePendingPrompt,
  sessionEventDeduplicator,
} from "./agent-store-runtime";
import {
  handlePermissionRequest,
  handlePromptResponse,
} from "./agent-store-receive-prompts";
import { handleAgentRequestResponse } from "./agent-store-receive-requests";
import type { AgentStore, AgentStoreAccess } from "./agent-store-types";

const promptCompleteUpdate = (params: Record<string, unknown> | undefined) => {
  if (!params) {
    return undefined;
  }
  const stopReason = stringValue(
    wireValue(params, "stopReason", "stop_reason"),
  );
  const agentResult = stringValue(
    wireValue(params, "agentResult", "agent_result"),
  );
  const promptId = stringValue(wireValue(params, "promptId", "prompt_id"));
  const usage = objectValue(wireValue(params, "usage", "usage"));
  return {
    sessionUpdate: "turn_completed",
    ...(promptId ? { promptId } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(agentResult !== undefined ? { agentResult } : {}),
    ...(usage ? { usage } : {}),
  };
};

const handleModelCatalogUpdate = (
  store: AgentStoreAccess,
  message: Parameters<AgentStore["receiveAcp"]>[0],
) => {
  const models = modelOptionsFromUpdate(message);
  if (!models) {
    return false;
  }

  const { get, set } = store;
  const current = get();
  const currentModelStillAvailable = current.selectedModelId
    ? models.availableModels.some(
        (model) => model.id === current.selectedModelId,
      )
    : false;
  const updateSelectedModelStillAvailable = models.selectedModelId
    ? models.availableModels.some(
        (model) => model.id === models.selectedModelId,
      )
    : false;
  // A catalog update carries the shell's default model. Keep an active
  // session's explicit choice when it is still present; only fall back to the
  // update's current model when the previous choice was removed.
  const selectedModelId = currentModelStillAvailable
    ? current.selectedModelId
    : updateSelectedModelStillAvailable
      ? models.selectedModelId
      : models.availableModels[0]?.id;
  const selectedModel = models.availableModels.find(
    (model) => model.id === selectedModelId,
  );
  const modelChanged = selectedModelId !== current.selectedModelId;

  set({
    availableModels: models.availableModels,
    selectedModelId,
    selectedReasoningEffort: modelChanged
      ? selectedModel?.reasoningEffort
      : (current.selectedReasoningEffort ?? selectedModel?.reasoningEffort),
    contextUsage: contextUsageForModel(
      models.availableModels,
      selectedModelId,
      current.contextUsage,
    ),
    ...(current.pendingModelId &&
    models.availableModels.some((model) => model.id === current.pendingModelId)
      ? {}
      : { pendingModelId: undefined }),
  });
  return true;
};

export const receiveAgentAcp = async (
  store: AgentStoreAccess,
  message: Parameters<AgentStore["receiveAcp"]>[0],
) => {
  const { get, set } = store;

  pruneTransientState();
  try {
    if (handleModelCatalogUpdate(store, message)) {
      return;
    }

    if (isUserQuestionMethod(message.method) && message.id !== undefined) {
      const request = parseUserQuestionRequest(message, get().acpSessionId);
      if (!request) {
        return;
      }
      markPromptActivity(request.sessionId);
      const currentAcpSessionId = get().acpSessionId;
      if (currentAcpSessionId && request.sessionId !== currentAcpSessionId) {
        set((state) => ({
          backgroundTimelines: {
            ...state.backgroundTimelines,
            [request.sessionId]: questionEntryForRequest(
              state.backgroundTimelines[request.sessionId] ?? [],
              request,
            ),
          },
        }));
      } else {
        set((state) => ({
          timeline: questionEntryForRequest(state.timeline, request),
          acpPhase: "prompting",
          chatStatus: "streaming",
        }));
      }
      return;
    }

    if (await handleAgentRequestResponse(store, message)) {
      return;
    }

    if (message.method === "x.ai/exit_plan_mode" && message.id !== undefined) {
      const params = message.params ?? {};
      const sessionId = stringValue(params.sessionId);
      markPromptActivity(sessionId ?? get().acpSessionId);
      const toolCallId =
        stringValue(params.toolCallId) ?? `exit-plan-${String(message.id)}`;
      const content =
        stringValue(params.planContent)?.trim() || "Melody 没有返回计划内容。";
      const request = {
        content,
        requestId: message.id,
        toolCallId,
      };
      const currentSessionId = get().acpSessionId;

      if (sessionId && currentSessionId && sessionId !== currentSessionId) {
        set((state) => ({
          backgroundTimelines: {
            ...state.backgroundTimelines,
            [sessionId]: upsertPlanApproval(
              state.backgroundTimelines[sessionId] ?? [],
              request,
            ),
          },
        }));
      } else {
        set((state) => ({
          timeline: upsertPlanApproval(state.timeline, request),
        }));
      }
      return;
    }

    if (await handlePromptResponse(store, message)) {
      return;
    }
    if (await handlePermissionRequest(store, message)) {
      return;
    }

    const isPromptComplete = isPromptCompleteMethod(message.method);
    if (!isPromptComplete && !isSessionUpdateMethod(message.method)) {
      return;
    }

    const updateParams = extractSessionUpdateParams(message);
    const update = isPromptComplete
      ? promptCompleteUpdate(updateParams)
      : directSessionUpdate(updateParams);
    const messageSessionId = updateParams
      ? stringValue(wireValue(updateParams, "sessionId", "session_id"))
      : undefined;
    const currentAcpSessionId = get().acpSessionId;
    const routedSessionId = messageSessionId ?? currentAcpSessionId;
    if (!routedSessionId) {
      return;
    }
    const baseMetadata = notificationMetadata(updateParams);
    const promptId =
      stringValue(wireValue(updateParams, "promptId", "prompt_id")) ??
      baseMetadata.promptId;
    const metadata =
      promptId && !baseMetadata.promptId
        ? { ...baseMetadata, promptId }
        : baseMetadata;
    if (metadata.promptId && cancelledPromptIds.has(metadata.promptId)) {
      return;
    }
    markPromptActivity(routedSessionId);
    let startsFullReplay = false;
    if (metadata.isReplay && !fullReplayStarted.has(routedSessionId)) {
      fullReplayStarted.add(routedSessionId);
      sessionEventDeduplicator.reset(routedSessionId);
      startsFullReplay = true;
    }
    if (!sessionEventDeduplicator.accept(routedSessionId, metadata.eventId)) {
      return;
    }
    const updateType = stringValue(
      wireValue(update, "sessionUpdate", "session_update"),
    );
    const echoBlocks = pendingUserEchoBlocks.get(routedSessionId) ?? 0;
    const skipUserEcho =
      updateType === "user_message_chunk" &&
      !metadata.isReplay &&
      echoBlocks > 0;
    if (skipUserEcho) {
      if (echoBlocks === 1) {
        pendingUserEchoBlocks.delete(routedSessionId);
      } else {
        pendingUserEchoBlocks.set(routedSessionId, echoBlocks - 1);
      }
    }
    set((state) => {
      const nextSubagents = applySubagentUpdate(
        state.subagents,
        update,
        routedSessionId,
        startsFullReplay,
      );
      return nextSubagents === state.subagents
        ? state
        : { subagents: nextSubagents };
    });

    // 后台会话的 update：缓冲到 backgroundTimelines，不污染当前会话。
    if (
      messageSessionId &&
      currentAcpSessionId &&
      messageSessionId !== currentAcpSessionId
    ) {
      const buffered = startsFullReplay
        ? []
        : (get().backgroundTimelines[messageSessionId] ?? []);
      const stateBeforeUpdate = get();
      const fallbackUsage =
        stateBeforeUpdate.backgroundContextUsage[messageSessionId] ??
        contextUsageForModel(
          stateBeforeUpdate.availableModels,
          stateBeforeUpdate.selectedModelId,
        );
      const result: SessionUpdateResult = skipUserEcho
        ? { timeline: buffered }
        : applySessionUpdate(buffered, update, metadata.eventId);
      const reportedUsage =
        result.contextUsage ??
        contextUsageFromTotalTokens(metadata.totalTokens, fallbackUsage);
      const hasReportedUsage =
        result.contextUsage !== undefined || metadata.totalTokens !== undefined;
      const nextTimeline = hasReportedUsage
        ? stampLatestTurnContextUsage(result.timeline, reportedUsage)
        : result.timeline;
      if (result.completed) {
        const pending = metadata.promptId
          ? [...pendingPrompts.entries()].find(
              ([, value]) => value.promptId === metadata.promptId,
            )
          : pendingPromptForSession(messageSessionId);
        if (pending) {
          removePendingPrompt(pending[0]);
        }
      }
      set((state) => ({
        backgroundTimelines: {
          ...state.backgroundTimelines,
          [messageSessionId]: nextTimeline,
        },
        backgroundCursors: metadata.eventId
          ? {
              ...state.backgroundCursors,
              [messageSessionId]: metadata.eventId,
            }
          : state.backgroundCursors,
        backgroundContextUsage: reportedUsage
          ? {
              ...state.backgroundContextUsage,
              [messageSessionId]: reportedUsage,
            }
          : state.backgroundContextUsage,
      }));
      return;
    }

    // 当前会话的 update：正常处理。
    const currentTimeline = startsFullReplay ? [] : get().timeline;
    const stateBeforeUpdate = get();
    const fallbackUsage =
      stateBeforeUpdate.contextUsage ??
      contextUsageForModel(
        stateBeforeUpdate.availableModels,
        stateBeforeUpdate.selectedModelId,
      );
    const authoritativeSessionModeId = sessionModeIdFromUpdate(update);
    const result: SessionUpdateResult = skipUserEcho
      ? { timeline: currentTimeline }
      : applySessionUpdate(currentTimeline, update, metadata.eventId);
    const reportedUsage =
      result.contextUsage ??
      contextUsageFromTotalTokens(metadata.totalTokens, fallbackUsage);
    const hasReportedUsage =
      result.contextUsage !== undefined || metadata.totalTokens !== undefined;
    const nextTimeline = hasReportedUsage
      ? stampLatestTurnContextUsage(result.timeline, reportedUsage)
      : result.timeline;
    if (result.completed) {
      const pending = metadata.promptId
        ? [...pendingPrompts.entries()].find(
            ([, value]) => value.promptId === metadata.promptId,
          )
        : pendingPromptForSession(routedSessionId);
      if (pending) {
        removePendingPrompt(pending[0]);
      }
    }
    set((state) => ({
      timeline: nextTimeline,
      ...(metadata.eventId ? { acpCursor: metadata.eventId } : {}),
      ...(result.streaming ? { chatStatus: "streaming" as const } : {}),
      ...(result.completed
        ? {
            acpPhase: result.error ? ("error" as const) : ("ready" as const),
            chatStatus: result.error ? ("error" as const) : ("ready" as const),
            runningSessions: state.localSessionId
              ? { ...state.runningSessions, [state.localSessionId]: false }
              : state.runningSessions,
          }
        : {}),
      ...(result.statusMessage && !result.error
        ? { status: { ...state.status, message: result.statusMessage } }
        : {}),
      ...(result.error
        ? {
            acpPhase: "error" as const,
            chatStatus: "error" as const,
            status: { ...state.status, message: result.error },
          }
        : {}),
      ...(reportedUsage ? { contextUsage: reportedUsage } : {}),
      ...(authoritativeSessionModeId
        ? {
            selectedSessionModeId: authoritativeSessionModeId,
            pendingSessionModeId: undefined,
          }
        : {}),
    }));
  } catch (reason) {
    const detail = reasonMessage(reason);
    clearTransientState();
    set((state) => ({
      acpPhase: "error",
      chatStatus: "error",
      runningSessions: state.localSessionId
        ? { ...state.runningSessions, [state.localSessionId]: false }
        : state.runningSessions,
      status: {
        ...state.status,
        message: `ACP 事件处理失败：${detail}`,
      },
    }));
  }
};
