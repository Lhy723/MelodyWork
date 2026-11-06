import { create } from "zustand";

import { toUserMessage as reasonMessage } from "@/domain/app-error";
import {
  appendSessionError,
  settleSessionProjection,
} from "@/domain/session-projection";
import { sendAgentCommand } from "@/lib/agent-client";
import { isTauriRuntime } from "@/lib/melody-bridge";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import {
  clearTransientState,
  pendingPromptForSession,
  removePendingPrompt,
  rememberCancelledPrompt,
  previewTimeline,
} from "./agent-store-runtime";
import type { AgentStore } from "./agent-store-types";
import {
  beginAgentSession,
  beginArchivedSession as beginArchivedSessionFn,
} from "./agent-store-session";
import { receiveAgentAcp } from "./agent-store-receive";
import { submitAgentPrompt } from "./agent-store-submit";
import { receiveAgentEvent, resetPiEventProjection } from "./agent-store-pi";
import {
  resolveAgentPermission,
  resolveAgentPlan,
  resolveAgentQuestion,
} from "./agent-store-interactions";
import {
  selectAgentModel,
  selectAgentPermissionMode,
  selectAgentReasoningEffort,
  selectAgentSessionMode,
} from "./agent-store-configuration";

export const useAgentStore = create<AgentStore>((set, get) => ({
  activeSessionId: isTauriRuntime() ? "" : "implement-acp-bridge",
  cwd: ".",
  status: {
    phase: "stopped",
    message: "正在启动桌面连接…",
  },
  runtimePhase: "idle",
  timeline: isTauriRuntime() ? [] : previewTimeline,
  backgroundTimelines: {},
  backgroundCursors: {},
  backgroundContextUsage: {},
  subagents: {},
  stderr: [],
  availableModels: [],
  unavailableModels: [],
  modelRefreshErrors: {},
  capabilityDiagnostics: [],
  monitorNotifications: [],
  scheduleRevision: 0,
  configRevision: 0,
  availableSessionModes: [],
  permissionMode: useAppSettingsStore.getState().defaultPermissionMode,
  runningSessions: {},
  chatStatus: "ready",
  archivedReadOnly: false,
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
            runtimePhase: "error" as const,
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
    resetPiEventProjection();
    set({
      activeSessionId: isTauriRuntime() ? "" : "implement-acp-bridge",
      localSessionId: undefined,
      cwd: ".",
      runtimePhase: "idle",
      runtimeSessionId: undefined,
      eventCursor: undefined,
      timeline: isTauriRuntime() ? [] : previewTimeline,
      contextUsage: undefined,
      capabilities: undefined,
      capabilityDiagnostics: [],
      monitorNotifications: [],
      scheduleRevision: 0,
      configRevision: 0,
      availableSessionModes: [],
      selectedSessionModeId: undefined,
      pendingSessionModeId: undefined,
      archivedReadOnly: false,
      chatStatus: "ready",
    });
  },
  appendStderr: (line) =>
    set((state) => ({ stderr: [...state.stderr.slice(-49), line] })),
  beginSession: (...args) => beginAgentSession({ get, set }, ...args),
  beginArchivedSession: (...args) =>
    beginArchivedSessionFn({ get, set }, ...args),
  receiveAcp: (message) => receiveAgentAcp({ get, set }, message),
  receiveAgentEvent: (event) => receiveAgentEvent({ get, set }, event),
  submitPrompt: (...args) => submitAgentPrompt({ get, set }, ...args),
  cancelPrompt: async (reason = "user") => {
    const stateBeforeCancel = get();
    const localSessionId = stateBeforeCancel.localSessionId;
    const sessionId = stateBeforeCancel.runtimeSessionId;
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
        await sendAgentCommand({
          protocolVersion: 1,
          requestId: `cancel-${sessionId}-${Date.now()}`,
          sessionId,
          command: {
            type: "turn.cancel",
            sessionId,
            ...(pendingPrompt ? { promptId: pendingPrompt.promptId } : {}),
            cancelSubagents: true,
            reason,
          },
        });
      }
      set((state) => ({
        runtimePhase: "ready",
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
        runtimePhase: "error",
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
  selectModel: (...args) => selectAgentModel({ get, set }, ...args),
  selectReasoningEffort: (...args) =>
    selectAgentReasoningEffort({ get, set }, ...args),
  selectSessionMode: (...args) => selectAgentSessionMode({ get, set }, ...args),
  selectPermissionMode: (...args) =>
    selectAgentPermissionMode({ get, set }, ...args),
  resolvePlan: (...args) => resolveAgentPlan({ get, set }, ...args),
  resolvePermission: (...args) => resolveAgentPermission({ get, set }, ...args),
  resolveQuestion: (...args) => resolveAgentQuestion({ get, set }, ...args),
}));
