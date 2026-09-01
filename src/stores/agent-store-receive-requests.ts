import { toUserMessage as reasonMessage } from "@/domain/app-error";
import {
  sessionModeState,
} from "@/domain/session-mode";
import { updateStoredSession, sendAcp } from "@/lib/melody-bridge";
import { useWorkspaceStore } from "@/stores/workspace-store";

import {
  contextUsageForModel,
  contextUsageFromResult,
  errorMessage,
  modelOptions,
  preferredAuthMethod,
  stringValue,
} from "./agent-store-parsing";
import {
  armSetupTimeout,
  AUTHENTICATE_REQUEST_ID,
  INITIALIZE_REQUEST_ID,
  loadFallbackTimelines,
  pendingSessionOpens,
  sendSessionOpen,
  SET_MODEL_REQUEST_ID,
  SET_REASONING_EFFORT_REQUEST_ID,
  SET_SESSION_MODE_REQUEST_ID,
} from "./agent-store-runtime";
import type { AgentStore, AgentStoreAccess } from "./agent-store-types";

type AgentMessage = Parameters<AgentStore["receiveAcp"]>[0];

const handleInitializeResponse = async (
  store: AgentStoreAccess,
  message: AgentMessage,
) => {
  const { get, set } = store;
  if (message.error) {
    set({
      acpPhase: "error",
      chatStatus: "error",
      status: {
        ...get().status,
        message: errorMessage(message, "ACP 初始化失败"),
      },
    });
    return true;
  }

  const models = modelOptions(message);
  const selectedModelId = models.selectedModelId ?? get().selectedModelId;
  set({
    availableModels: models.availableModels,
    selectedModelId,
    selectedReasoningEffort:
      models.selectedReasoningEffort ?? get().selectedReasoningEffort,
    contextUsage: contextUsageForModel(
      models.availableModels,
      selectedModelId,
      get().contextUsage,
    ),
  });

  const preferredMethod = preferredAuthMethod(message);
  if (preferredMethod) {
    set({ acpPhase: "authenticating" });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: AUTHENTICATE_REQUEST_ID,
        method: "authenticate",
        params: {
          methodId: preferredMethod,
          _meta: { headless: false },
        },
      });
      const localSessionId = get().localSessionId;
      if (localSessionId) {
        armSetupTimeout(
          localSessionId,
          "authenticating",
          "Melody Build 身份验证超时。请通过 Melody CLI 登录后重试。",
          get,
          set,
        );
      }
    } catch (reason) {
      set({
        acpPhase: "error",
        chatStatus: "error",
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
    return true;
  }

  set({ acpPhase: "creating" });
  try {
    const localSessionId = get().localSessionId;
    if (!localSessionId) {
      return true;
    }
    await sendSessionOpen(
      localSessionId,
      get().cwd,
      get().acpSessionId,
      get().selectedModelId,
      get().permissionMode,
      get().acpCursor,
    );
    armSetupTimeout(
      localSessionId,
      "creating",
      "打开 Melody 会话超时。",
      get,
      set,
    );
  } catch (reason) {
    set({
      acpPhase: "error",
      chatStatus: "error",
      status: { ...get().status, message: reasonMessage(reason) },
    });
  }
  return true;
};

const handleAuthenticateResponse = async (
  store: AgentStoreAccess,
  message: AgentMessage,
) => {
  const { get, set } = store;
  if (message.error) {
    set({
      acpPhase: "error",
      chatStatus: "error",
      status: {
        ...get().status,
        message: errorMessage(
          message,
          "Melody 身份验证失败。请通过 Melody CLI 登录后重试。",
        ),
      },
    });
    return true;
  }

  set({ acpPhase: "creating" });
  try {
    const localSessionId = get().localSessionId;
    if (!localSessionId) {
      return true;
    }
    await sendSessionOpen(
      localSessionId,
      get().cwd,
      get().acpSessionId,
      get().selectedModelId,
      get().permissionMode,
      get().acpCursor,
    );
    armSetupTimeout(
      localSessionId,
      "creating",
      "打开 Melody 会话超时。",
      get,
      set,
    );
  } catch (reason) {
    set({
      acpPhase: "error",
      chatStatus: "error",
      status: { ...get().status, message: reasonMessage(reason) },
    });
  }
  return true;
};

const handleModelResponse = (
  store: AgentStoreAccess,
  message: AgentMessage,
) => {
  const { get, set } = store;
  const pendingModelId = get().pendingModelId;
  if (message.error || !pendingModelId) {
    const detail = errorMessage(message, "切换 Melody 模型失败");
    set({
      pendingModelId: undefined,
      acpPhase: "error",
      chatStatus: "error",
      status: { ...get().status, message: detail },
    });
    return true;
  }
  const selectedModel = get().availableModels.find(
    (model) => model.id === pendingModelId,
  );
  set({
    selectedModelId: pendingModelId,
    selectedReasoningEffort: selectedModel?.reasoningEffort,
    contextUsage: contextUsageForModel(
      get().availableModels,
      pendingModelId,
    ),
    pendingModelId: undefined,
    acpPhase: "ready",
    chatStatus: "ready",
    status: {
      ...get().status,
      message: `正在使用 ${pendingModelId}`,
    },
  });
  return true;
};

const handleReasoningEffortResponse = (
  store: AgentStoreAccess,
  message: AgentMessage,
) => {
  const { get, set } = store;
  const pendingReasoningEffort = get().pendingReasoningEffort;
  if (message.error || !pendingReasoningEffort) {
    const detail = errorMessage(message, "更改推理强度失败");
    set({
      pendingReasoningEffort: undefined,
      acpPhase: "error",
      chatStatus: "error",
      status: { ...get().status, message: detail },
    });
    return true;
  }
  set({
    selectedReasoningEffort: pendingReasoningEffort,
    pendingReasoningEffort: undefined,
    acpPhase: "ready",
    chatStatus: "ready",
    status: {
      ...get().status,
      message: `推理强度：${pendingReasoningEffort}`,
    },
  });
  return true;
};

const handleSessionModeResponse = (
  store: AgentStoreAccess,
  message: AgentMessage,
) => {
  const { get, set } = store;
  const pendingSessionModeId = get().pendingSessionModeId;
  if (message.error) {
    const detail = errorMessage(message, "切换 Melody 会话模式失败");
    set({
      pendingSessionModeId: undefined,
      status: { ...get().status, message: detail },
    });
    return true;
  }
  if (pendingSessionModeId) {
    set({
      selectedSessionModeId: pendingSessionModeId,
      pendingSessionModeId: undefined,
      status: {
        ...get().status,
        message: `会话模式：${pendingSessionModeId}`,
      },
    });
  }
  return true;
};

const handleSessionOpenResponse = async (
  store: AgentStoreAccess,
  message: AgentMessage,
) => {
  const { get, set } = store;
  const pendingOpen =
    typeof message.id === "number"
      ? pendingSessionOpens.get(message.id)
      : undefined;
  if (!pendingOpen) {
    return false;
  }

  pendingSessionOpens.delete(message.id as number);
  const sessionId =
    stringValue(message.result?.sessionId) ?? pendingOpen.requestedSessionId;
  const isCurrent = pendingOpen.localSessionId === get().localSessionId;
  if (message.error && pendingOpen.requestedSessionId) {
    if (!isCurrent) {
      return true;
    }
    const fallback = loadFallbackTimelines.get(pendingOpen.localSessionId);
    const detail = errorMessage(message, "无法加载 Melody 会话");
    set((state) => ({
      acpPhase: "error",
      chatStatus: "error",
      timeline:
        state.timeline.length > 0
          ? state.timeline
          : (fallback ?? state.timeline),
      status: {
        ...state.status,
        message: `${detail}。已保留本地只读缓存，没有创建替代会话。`,
      },
    }));
    return true;
  }
  if (message.error || !sessionId) {
    if (isCurrent) {
      set({
        acpPhase: "error",
        chatStatus: "error",
        status: {
          ...get().status,
          message: errorMessage(message, "Melody 没有返回会话 ID"),
        },
      });
    }
    return true;
  }

  const sessionUsage = contextUsageFromResult(message.result);
  const modes = sessionModeState(message.result);
  if (isCurrent) {
    set({
      acpPhase: "ready",
      acpSessionId: sessionId,
      chatStatus: "ready",
      ...(sessionUsage ? { contextUsage: sessionUsage } : {}),
      ...(modes
        ? {
            availableSessionModes: modes.availableSessionModes,
            selectedSessionModeId: modes.selectedSessionModeId,
            pendingSessionModeId: undefined,
          }
        : {}),
    });
  }
  loadFallbackTimelines.delete(pendingOpen.localSessionId);
  if (!pendingOpen.requestedSessionId) {
    const updated = await updateStoredSession({
      id: pendingOpen.localSessionId,
      acpSessionId: sessionId,
    });
    useWorkspaceStore.getState().replaceSession(updated);
  }
  return true;
};

export const handleAgentRequestResponse = async (
  store: AgentStoreAccess,
  message: AgentMessage,
): Promise<boolean> => {
  if (message.id === INITIALIZE_REQUEST_ID) {
    return handleInitializeResponse(store, message);
  }
  if (message.id === AUTHENTICATE_REQUEST_ID) {
    return handleAuthenticateResponse(store, message);
  }
  if (message.id === SET_MODEL_REQUEST_ID) {
    return handleModelResponse(store, message);
  }
  if (message.id === SET_REASONING_EFFORT_REQUEST_ID) {
    return handleReasoningEffortResponse(store, message);
  }
  if (message.id === SET_SESSION_MODE_REQUEST_ID) {
    return handleSessionModeResponse(store, message);
  }
  return handleSessionOpenResponse(store, message);
};
