import { toUserMessage as reasonMessage } from "@/domain/app-error";
import { isTauriRuntime } from "@/lib/melody-bridge";
import { sendAgentCommand } from "@/lib/agent-client";
import { contextUsageForModel } from "./agent-store-parsing";
import {
  SET_MODEL_REQUEST_ID,
  SET_REASONING_EFFORT_REQUEST_ID,
  SET_SESSION_MODE_REQUEST_ID,
} from "./agent-store-runtime";
import type { AgentStore, AgentStoreAccess } from "./agent-store-types";

export const selectAgentModel = async (
  store: AgentStoreAccess,
  modelId: Parameters<AgentStore["selectModel"]>[0],
) => {
  const state = store.get();
  if (!modelId || modelId === state.selectedModelId || state.pendingModelId) {
    return;
  }
  if (!isTauriRuntime()) {
    const selectedModel = state.availableModels.find(
      (model) => model.id === modelId,
    );
    store.set({
      selectedModelId: modelId,
      selectedReasoningEffort: selectedModel?.reasoningEffort,
      contextUsage: contextUsageForModel(state.availableModels, modelId),
    });
    return;
  }
  if (!state.runtimeSessionId) {
    const selectedModel = state.availableModels.find(
      (model) => model.id === modelId,
    );
    store.set({
      selectedModelId: modelId,
      selectedReasoningEffort: selectedModel?.reasoningEffort,
      contextUsage: contextUsageForModel(state.availableModels, modelId),
      status: {
        ...state.status,
        message: "所选模型将在下一个会话中使用。",
      },
    });
    return;
  }
  store.set({ pendingModelId: modelId });
  try {
    await sendAgentCommand({
      protocolVersion: 1,
      requestId: SET_MODEL_REQUEST_ID,
      sessionId: state.runtimeSessionId,
      command: {
        type: "session.configure",
        sessionId: state.runtimeSessionId,
        expectedRevision: state.configRevision,
        modelId,
      },
    });
  } catch (reason) {
    store.set({
      pendingModelId: undefined,
      runtimePhase: "error",
      chatStatus: "error",
      status: { ...store.get().status, message: reasonMessage(reason) },
    });
  }
};

export const selectAgentReasoningEffort = async (
  store: AgentStoreAccess,
  effort: Parameters<AgentStore["selectReasoningEffort"]>[0],
) => {
  const state = store.get();
  if (
    !effort ||
    effort === state.selectedReasoningEffort ||
    state.pendingReasoningEffort ||
    !state.selectedModelId
  ) {
    return;
  }
  if (!isTauriRuntime() || !state.runtimeSessionId) {
    store.set({ selectedReasoningEffort: effort });
    return;
  }
  store.set({ pendingReasoningEffort: effort });
  try {
    await sendAgentCommand({
      protocolVersion: 1,
      requestId: SET_REASONING_EFFORT_REQUEST_ID,
      sessionId: state.runtimeSessionId,
      command: {
        type: "session.configure",
        sessionId: state.runtimeSessionId,
        expectedRevision: state.configRevision,
        modelId: state.selectedModelId,
        reasoningEffort: effort,
      },
    });
  } catch (reason) {
    store.set({
      pendingReasoningEffort: undefined,
      runtimePhase: "error",
      chatStatus: "error",
      status: { ...store.get().status, message: reasonMessage(reason) },
    });
  }
};

export const selectAgentSessionMode = async (
  store: AgentStoreAccess,
  modeId: Parameters<AgentStore["selectSessionMode"]>[0],
) => {
  const state = store.get();
  if (
    !modeId ||
    modeId === state.selectedSessionModeId ||
    state.pendingSessionModeId
  ) {
    return;
  }
  if (!isTauriRuntime() || !state.runtimeSessionId) {
    store.set({ selectedSessionModeId: modeId });
    return;
  }
  store.set({ pendingSessionModeId: modeId });
  try {
    await sendAgentCommand({
      protocolVersion: 1,
      requestId: SET_SESSION_MODE_REQUEST_ID,
      sessionId: state.runtimeSessionId,
      command: {
        type: "session.configure",
        sessionId: state.runtimeSessionId,
        expectedRevision: state.configRevision,
        sessionModeId: modeId,
      },
    });
  } catch (reason) {
    store.set({
      pendingSessionModeId: undefined,
      status: { ...store.get().status, message: reasonMessage(reason) },
    });
  }
};

export const selectAgentPermissionMode = async (
  store: AgentStoreAccess,
  mode: Parameters<AgentStore["selectPermissionMode"]>[0],
) => {
  const state = store.get();
  if (mode === state.permissionMode) {
    return;
  }
  store.set({ permissionMode: mode });
  if (!isTauriRuntime() || !state.runtimeSessionId) {
    return;
  }
  try {
    await sendAgentCommand({
      protocolVersion: 1,
      requestId: `permission-mode-${state.runtimeSessionId}-${Date.now()}`,
      sessionId: state.runtimeSessionId,
      command: {
        type: "session.configure",
        sessionId: state.runtimeSessionId,
        expectedRevision: state.configRevision,
        permissionMode: mode,
      },
    });
  } catch (reason) {
    store.set({
      permissionMode: state.permissionMode,
      status: { ...store.get().status, message: reasonMessage(reason) },
    });
  }
};
