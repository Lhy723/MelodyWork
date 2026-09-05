import {
  appendSessionError,
  projectPermissionRequest,
  stampLatestTurnContextUsage,
} from "@/domain/session-projection";
import {
  markPromptResponseReceived,
  promptResponseDisposition,
} from "@/domain/prompt-timeout";
import { findPermissionRule, sendAcp } from "@/lib/melody-bridge";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  contextUsageFromResult,
  errorMessage,
  objectValue,
  parsePermissionOptions,
  permissionToolKey,
  responseMeta,
  stringValue,
} from "./agent-store-parsing";
import {
  cancelledPromptIds,
  markPromptActivity,
  pendingPromptForSession,
  pendingPrompts,
  removePendingPrompt,
} from "./agent-store-runtime";
import type { AgentStore, AgentStoreAccess } from "./agent-store-types";

type AgentMessage = Parameters<AgentStore["receiveAcp"]>[0];

/** Handle a prompt response without allowing background sessions to mutate the active chat. */
export const handlePromptResponse = async (
  store: AgentStoreAccess,
  message: AgentMessage,
): Promise<boolean> => {
  if (
    typeof message.id !== "number" ||
    message.id < 100 ||
    Boolean(message.method)
  ) {
    return false;
  }

  const { get, set } = store;
  const promptId = message.id;
  const pendingPrompt = pendingPrompts.get(promptId);
  const responsePromptId = stringValue(responseMeta(message)?.promptId);
  if (responsePromptId && cancelledPromptIds.has(responsePromptId)) {
    return true;
  }
  if (!pendingPrompt) {
    return true;
  }
  const promptError = message.error
    ? errorMessage(message, "Melody 请求失败")
    : undefined;
  const promptResponse = promptResponseDisposition(
    Boolean(message.error),
    pendingPrompt.responseReceivedAt !== undefined,
  );
  if (promptResponse === "duplicate") {
    return true;
  }
  const promptSessionId = pendingPrompt.acpSessionId;
  const currentAcpSessionId = get().acpSessionId;
  const isBackgroundPrompt =
    Boolean(promptSessionId) &&
    Boolean(currentAcpSessionId) &&
    promptSessionId !== currentAcpSessionId;
  const promptUsage = contextUsageFromResult(
    message.result,
    isBackgroundPrompt && promptSessionId
      ? get().backgroundContextUsage[promptSessionId]
      : get().contextUsage,
  );

  // 后台会话的 prompt 响应只更新缓冲上下文，不污染当前会话状态。
  if (isBackgroundPrompt && promptSessionId) {
    if (promptResponse === "accepted") {
      pendingPrompts.set(
        promptId,
        markPromptResponseReceived(pendingPrompt, Date.now()),
      );
      if (promptUsage) {
        set((state) => ({
          backgroundTimelines: {
            ...state.backgroundTimelines,
            [promptSessionId]: stampLatestTurnContextUsage(
              state.backgroundTimelines[promptSessionId] ?? [],
              promptUsage,
            ),
          },
          backgroundContextUsage: {
            ...state.backgroundContextUsage,
            [promptSessionId]: promptUsage,
          },
        }));
      }
      return true;
    }

    removePendingPrompt(promptId);
    set((state) => ({
      runningSessions: pendingPrompt
        ? {
            ...state.runningSessions,
            [pendingPrompt.localSessionId]: false,
          }
        : state.runningSessions,
      backgroundTimelines: {
        ...state.backgroundTimelines,
        [promptSessionId]: appendSessionError(
          state.backgroundTimelines[promptSessionId] ?? [],
          promptError ?? "Melody 请求失败",
        ),
      },
    }));
    return true;
  }

  if (promptResponse === "accepted") {
    pendingPrompts.set(
      promptId,
      markPromptResponseReceived(pendingPrompt, Date.now()),
    );
    if (promptUsage) {
      set((state) => ({
        timeline: stampLatestTurnContextUsage(state.timeline, promptUsage),
        contextUsage: promptUsage,
      }));
    }
    return true;
  }

  removePendingPrompt(promptId);
  set((state) => ({
    runningSessions: pendingPrompt
      ? {
          ...state.runningSessions,
          [pendingPrompt.localSessionId]: false,
        }
      : state.runningSessions,
    acpPhase: "error",
    chatStatus: "error",
    status: promptError
      ? { ...state.status, message: promptError }
      : state.status,
    timeline: appendSessionError(
      state.timeline,
      promptError ?? "Melody 请求失败",
    ),
  }));
  return true;
};

/** Resolve permission requests from a stored project rule when one exists. */
export const handlePermissionRequest = async (
  store: AgentStoreAccess,
  message: AgentMessage,
): Promise<boolean> => {
  if (
    message.method !== "session/request_permission" ||
    message.id === undefined
  ) {
    return false;
  }

  const { get, set } = store;
  const params = message.params ?? {};
  markPromptActivity(stringValue(params.sessionId) ?? get().acpSessionId);
  const tool = objectValue(params.toolCall) ?? {};
  const options = parsePermissionOptions(params.options);

  const permissionProjection = projectPermissionRequest(
    get().timeline,
    tool,
    message.id,
    options,
  );
  set({ timeline: permissionProjection.timeline });

  const projectId = useWorkspaceStore.getState().activeProject?.id;
  const { title, command, toolCallId } = permissionProjection;
  if (projectId) {
    const rule = await findPermissionRule(
      projectId,
      permissionToolKey(title, command),
    );
    const option = rule
      ? options.find((item) =>
          rule.decision === "deny"
            ? item.kind.startsWith("reject")
            : item.kind.startsWith("allow"),
        )
      : undefined;
    if (rule && option) {
      set((state) => ({
        timeline: state.timeline.map((entry) =>
          entry.kind === "tool" && entry.toolCallId === toolCallId
            ? {
                ...entry,
                permission: rule.decision === "deny" ? "denied" : "allowed",
              }
            : entry,
        ),
      }));
      await sendAcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          outcome: {
            outcome: "selected",
            optionId: option.optionId,
          },
        },
      });
    }
  }
  return true;
};

/** Clear a completed prompt from the queue for either the active or background session. */
export const clearCompletedPrompt = (sessionId: string, promptId?: string) => {
  const pending = promptId
    ? [...pendingPrompts.entries()].find(
        ([, value]) => value.promptId === promptId,
      )
    : pendingPromptForSession(sessionId);
  if (pending) {
    removePendingPrompt(pending[0]);
  }
};
