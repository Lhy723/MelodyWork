import { create } from "zustand";

import { toUserMessage as reasonMessage } from "@/domain/app-error";
import { settlePlanApproval } from "@/domain/plan-approval";
import {
  appendSessionError,
  settleSessionProjection,
} from "@/domain/session-projection";
import {
  isTauriRuntime,
  sendAcp,
  upsertPermissionRule,
} from "@/lib/melody-bridge";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  contextUsageForModel,
  permissionToolKey,
  updateQuestionEntry,
} from "./agent-store-parsing";
import {
  clearTransientState,
  pendingPromptForSession,
  removePendingPrompt,
  rememberCancelledPrompt,
  SET_MODEL_REQUEST_ID,
  SET_REASONING_EFFORT_REQUEST_ID,
  SET_SESSION_MODE_REQUEST_ID,
  previewTimeline,
} from "./agent-store-runtime";
import type { AgentStore } from "./agent-store-types";
import { beginAgentSession } from "./agent-store-session";
import { receiveAgentAcp } from "./agent-store-receive";
import { submitAgentPrompt } from "./agent-store-submit";

export const useAgentStore = create<AgentStore>((set, get) => ({
  activeSessionId: isTauriRuntime() ? "" : "implement-acp-bridge",
  cwd: ".",
  status: {
    phase: "stopped",
    message: "正在启动桌面连接…",
  },
  acpPhase: "idle",
  timeline: isTauriRuntime() ? [] : previewTimeline,
  backgroundTimelines: {},
  backgroundCursors: {},
  backgroundContextUsage: {},
  subagents: {},
  stderr: [],
  availableModels: [],
  availableSessionModes: [],
  permissionMode: useAppSettingsStore.getState().defaultPermissionMode,
  runningSessions: {},
  chatStatus: "ready",
  setStatus: (status) => {
    const current = get();
    const sessionLost =
      status.phase === "stopped" &&
      (current.chatStatus === "submitted" ||
        current.chatStatus === "streaming");
    if (
      status.phase === "stopped" ||
      status.phase === "missing" ||
      status.phase === "failed"
    ) {
      clearTransientState();
    }
    set((state) => ({
      status,
      ...(status.phase === "missing" || status.phase === "failed" || sessionLost
        ? {
            chatStatus: "error" as const,
            acpPhase: "error" as const,
          }
        : {}),
      ...(sessionLost
        ? {
            timeline: appendSessionError(
              state.timeline,
              status.message ?? "ACP sidecar 已停止，当前请求已结束。",
            ),
            runningSessions: state.localSessionId
              ? { ...state.runningSessions, [state.localSessionId]: false }
              : state.runningSessions,
          }
        : {}),
    }));
  },
  resetSessionView: () => {
    clearTransientState();
    set({
      activeSessionId: isTauriRuntime() ? "" : "implement-acp-bridge",
      localSessionId: undefined,
      cwd: ".",
      acpPhase: "idle",
      acpSessionId: undefined,
      acpCursor: undefined,
      timeline: isTauriRuntime() ? [] : previewTimeline,
      contextUsage: undefined,
      availableSessionModes: [],
      selectedSessionModeId: undefined,
      pendingSessionModeId: undefined,
      chatStatus: "ready",
    });
  },
  appendStderr: (line) =>
    set((state) => ({ stderr: [...state.stderr.slice(-49), line] })),
  beginSession: (...args) => beginAgentSession({ get, set }, ...args),
  receiveAcp: (message) => receiveAgentAcp({ get, set }, message),
  submitPrompt: (...args) => submitAgentPrompt({ get, set }, ...args),
  cancelPrompt: async (reason = "user") => {
    const stateBeforeCancel = get();
    const localSessionId = stateBeforeCancel.localSessionId;
    const sessionId = stateBeforeCancel.acpSessionId;
    const pending = sessionId ? pendingPromptForSession(sessionId) : undefined;
    if (
      stateBeforeCancel.chatStatus !== "submitted" &&
      stateBeforeCancel.chatStatus !== "streaming" &&
      !pending
    ) {
      return;
    }

    const pendingRequestId = pending?.[0];
    const pendingPrompt = pending?.[1];
    if (pendingRequestId !== undefined) {
      removePendingPrompt(pendingRequestId);
      if (pendingPrompt) {
        rememberCancelledPrompt(pendingPrompt.promptId);
      }
    }

    const timeoutMessage =
      "发送请求后 30 秒内未收到任何 ACP 进展事件，已自动停止。";
    try {
      if (sessionId && isTauriRuntime()) {
        await sendAcp({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId,
            _meta: {
              ...(pendingPrompt
                ? { cancelPromptId: pendingPrompt.promptId }
                : {}),
              cancelSubagents: true,
              cancelTrigger: reason === "timeout" ? "timeout" : "mouse",
            },
          },
        });
      }
      set((state) => ({
        acpPhase: "ready",
        chatStatus: "ready",
        timeline:
          reason === "timeout"
            ? appendSessionError(state.timeline, timeoutMessage)
            : settleSessionProjection(state.timeline),
        runningSessions: localSessionId
          ? { ...state.runningSessions, [localSessionId]: false }
          : state.runningSessions,
        ...(reason === "timeout"
          ? { status: { ...state.status, message: timeoutMessage } }
          : {}),
      }));
    } catch (cancelError) {
      const detail = reasonMessage(cancelError);
      set((state) => ({
        acpPhase: "error",
        chatStatus: "error",
        timeline: appendSessionError(
          state.timeline,
          `取消当前请求失败：${detail}`,
        ),
        runningSessions: localSessionId
          ? { ...state.runningSessions, [localSessionId]: false }
          : state.runningSessions,
        status: { ...state.status, message: detail },
      }));
    }
  },
  selectModel: async (modelId) => {
    const state = get();
    if (!modelId || modelId === state.selectedModelId || state.pendingModelId) {
      return;
    }
    if (!isTauriRuntime()) {
      const selectedModel = state.availableModels.find(
        (model) => model.id === modelId,
      );
      set({
        selectedModelId: modelId,
        selectedReasoningEffort: selectedModel?.reasoningEffort,
        contextUsage: contextUsageForModel(state.availableModels, modelId),
      });
      return;
    }
    if (!state.acpSessionId) {
      set({
        selectedModelId: modelId,
        contextUsage: contextUsageForModel(state.availableModels, modelId),
        status: {
          ...state.status,
          message: "所选模型将在下一个会话中使用。",
        },
      });
      return;
    }
    set({ pendingModelId: modelId });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: SET_MODEL_REQUEST_ID,
        method: "session/set_model",
        params: {
          sessionId: state.acpSessionId,
          modelId,
        },
      });
    } catch (reason) {
      set({
        pendingModelId: undefined,
        acpPhase: "error",
        chatStatus: "error",
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
  },
  selectReasoningEffort: async (effort) => {
    const state = get();
    if (
      !effort ||
      effort === state.selectedReasoningEffort ||
      state.pendingReasoningEffort ||
      !state.selectedModelId
    ) {
      return;
    }
    if (!isTauriRuntime() || !state.acpSessionId) {
      set({ selectedReasoningEffort: effort });
      return;
    }
    set({ pendingReasoningEffort: effort });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: SET_REASONING_EFFORT_REQUEST_ID,
        method: "session/set_model",
        params: {
          sessionId: state.acpSessionId,
          modelId: state.selectedModelId,
          _meta: { reasoningEffort: effort },
        },
      });
    } catch (reason) {
      set({
        pendingReasoningEffort: undefined,
        acpPhase: "error",
        chatStatus: "error",
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
  },
  selectSessionMode: async (modeId) => {
    const state = get();
    if (
      !modeId ||
      modeId === state.selectedSessionModeId ||
      state.pendingSessionModeId
    ) {
      return;
    }
    if (!isTauriRuntime() || !state.acpSessionId) {
      set({ selectedSessionModeId: modeId });
      return;
    }
    set({ pendingSessionModeId: modeId });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: SET_SESSION_MODE_REQUEST_ID,
        method: "session/set_mode",
        params: {
          sessionId: state.acpSessionId,
          modeId,
        },
      });
    } catch (reason) {
      set({
        pendingSessionModeId: undefined,
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
  },
  selectPermissionMode: async (mode) => {
    const state = get();
    if (mode === state.permissionMode) {
      return;
    }
    set({ permissionMode: mode });
    if (!isTauriRuntime() || !state.acpSessionId) {
      return;
    }
    try {
      await sendAcp({
        jsonrpc: "2.0",
        method: "x.ai/yolo_mode_changed",
        params: {
          clientIdentifier: "melody-work",
          permission_mode: mode,
          yolo_mode: mode === "always-approve",
          auto_mode: mode === "auto",
        },
      });
    } catch (reason) {
      set({
        permissionMode: state.permissionMode,
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
  },
  resolvePlan: async (entryId, outcome, feedback) => {
    const entry = get().timeline.find((item) => item.id === entryId);
    if (
      entry?.kind !== "plan" ||
      entry.status !== "awaiting-approval" ||
      entry.requestId === undefined
    ) {
      return;
    }
    const normalizedFeedback = feedback?.trim();
    if (outcome === "cancelled" && !normalizedFeedback) {
      return;
    }
    const settledStatus =
      outcome === "approved"
        ? "approved"
        : outcome === "abandoned"
          ? "abandoned"
          : "changes-requested";
    set((state) => ({
      timeline: settlePlanApproval(state.timeline, entryId, settledStatus),
    }));

    if (!isTauriRuntime()) {
      return;
    }
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: entry.requestId,
        result: {
          outcome,
          ...(normalizedFeedback ? { feedback: normalizedFeedback } : {}),
        },
      });
    } catch (reason) {
      set((state) => ({
        timeline: state.timeline.map((item) =>
          item.kind === "plan" && item.id === entryId
            ? {
                ...item,
                requestId: entry.requestId,
                status: "awaiting-approval",
              }
            : item,
        ),
        status: {
          ...state.status,
          message: reasonMessage(reason),
        },
      }));
      throw reason;
    }
  },
  resolvePermission: async (entryId, optionId) => {
    const entry = get().timeline.find((item) => item.id === entryId);
    if (entry?.kind !== "tool" || entry.permissionRequestId === undefined) {
      return;
    }
    const projectDecision = optionId.startsWith("project:")
      ? (optionId.slice("project:".length) as "allow" | "deny")
      : undefined;
    const option = projectDecision
      ? entry.permissionOptions?.find((item) =>
          projectDecision === "deny"
            ? item.kind.startsWith("reject")
            : item.kind.startsWith("allow"),
        )
      : entry.permissionOptions?.find((item) => item.optionId === optionId);
    if (!option) {
      return;
    }
    const permission = option?.kind.startsWith("reject") ? "denied" : "allowed";

    if (projectDecision) {
      const projectId = useWorkspaceStore.getState().activeProject?.id;
      if (projectId) {
        await upsertPermissionRule({
          projectId,
          toolKey: permissionToolKey(entry.title, entry.command),
          title: entry.title,
          command: entry.command,
          decision: projectDecision,
        });
      }
    }

    set((state) => ({
      timeline: state.timeline.map((item) =>
        item.id === entryId ? { ...item, permission } : item,
      ),
    }));

    if (!isTauriRuntime()) {
      return;
    }
    await sendAcp({
      jsonrpc: "2.0",
      id: entry.permissionRequestId,
      result: {
        outcome: {
          outcome: "selected",
          optionId: option.optionId,
        },
      },
    });
  },
  resolveQuestion: async (entryId, response) => {
    const state = get();
    let entry = state.timeline.find((item) => item.id === entryId);
    let backgroundSessionId: string | undefined;
    if (!entry) {
      for (const [sessionId, timeline] of Object.entries(
        state.backgroundTimelines,
      )) {
        const candidate = timeline.find((item) => item.id === entryId);
        if (candidate) {
          entry = candidate;
          backgroundSessionId = sessionId;
          break;
        }
      }
    }
    if (
      entry?.kind !== "tool" ||
      !entry.question ||
      entry.question.outcome !== "pending"
    ) {
      return;
    }
    const requestId = entry.question.requestId;
    const wireResponse =
      response.outcome === "chat_about_this" ||
      response.outcome === "skip_interview"
        ? {
            outcome: response.outcome,
            partial_answers: response.partialAnswers,
          }
        : response;
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: requestId,
        result: wireResponse,
      });
    } catch (reason) {
      set({
        status: { ...get().status, message: reasonMessage(reason) },
      });
      throw reason;
    }
    set((current) =>
      backgroundSessionId
        ? {
            backgroundTimelines: {
              ...current.backgroundTimelines,
              [backgroundSessionId]: updateQuestionEntry(
                current.backgroundTimelines[backgroundSessionId] ?? [],
                entryId,
                response,
              ),
            },
          }
        : {
            timeline: updateQuestionEntry(current.timeline, entryId, response),
          },
    );
  },
}));
