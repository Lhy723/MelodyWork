import { toUserMessage as reasonMessage } from "@/domain/app-error";
import { isTauriRuntime, sendAcp } from "@/lib/melody-bridge";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import {
  attachmentPromptBlocks,
  timelineAttachments,
} from "./agent-store-attachments";
import {
  allocatePromptRequestId,
  armPromptFirstEventTimeout,
  pendingPrompts,
  pendingUserEchoBlocks,
  removePendingPrompt,
} from "./agent-store-runtime";
import type { AgentStore, AgentStoreAccess } from "./agent-store-types";

export const submitAgentPrompt = async (
  store: AgentStoreAccess,
  ...args: Parameters<AgentStore["submitPrompt"]>
) => {
  const [content, attachments = []] = args;
  const { get, set } = store;

  const trimmed = content.trim();
  if (!trimmed && attachments.length === 0) {
    return;
  }

  let prompt: Record<string, unknown>[];
  try {
    prompt = [
      ...(trimmed ? [{ type: "text", text: trimmed }] : []),
      ...attachmentPromptBlocks(attachments),
    ];
  } catch (reason) {
    set((state) => ({
      chatStatus: "error",
      status: { ...state.status, message: reasonMessage(reason) },
    }));
    throw reason;
  }

  const attachmentNames = attachments
    .map((attachment) => attachment.filename)
    .filter(Boolean)
    .join(", ");
  const timelineContent =
    trimmed ||
    (attachmentNames
      ? `已附加：${attachmentNames}`
      : `已附加 ${attachments.length} 个文件`);
  const stateBeforeSubmit = get();
  const localSessionId = stateBeforeSubmit.localSessionId;

  if (stateBeforeSubmit.chatStatus !== "ready") {
    const sessionId = stateBeforeSubmit.acpSessionId;
    if (!sessionId || !localSessionId) {
      return;
    }
    const sendNow = useAppSettingsStore.getState().followUpBehavior === "steer";
    set((state) => ({
      chatStatus: "submitted",
      acpPhase: "prompting",
      runningSessions: {
        ...state.runningSessions,
        [localSessionId]: true,
      },
      timeline: [
        ...state.timeline,
        {
          id: `user-follow-up-${Date.now()}`,
          kind: "message",
          role: "user",
          content: timelineContent,
          startedAt: Date.now(),
          attachments:
            attachments.length > 0
              ? timelineAttachments(attachments)
              : undefined,
        },
      ],
    }));
    const id = allocatePromptRequestId();
    const promptId = `melody-work-${localSessionId}-${id}`;
    pendingPrompts.set(id, {
      acpSessionId: sessionId,
      localSessionId,
      promptId,
      createdAt: Date.now(),
    });
    pendingUserEchoBlocks.set(
      sessionId,
      (pendingUserEchoBlocks.get(sessionId) ?? 0) + prompt.length,
    );
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: {
          sessionId,
          prompt,
          _meta: {
            promptId,
            ...(sendNow ? { sendNow: true } : {}),
          },
        },
      });
      if (pendingPrompts.has(id)) {
        armPromptFirstEventTimeout(id, get);
      }
    } catch (reason) {
      removePendingPrompt(id);
      set((state) => ({
        acpPhase: "error",
        chatStatus: "error",
        runningSessions: {
          ...state.runningSessions,
          [localSessionId]: false,
        },
        status: { ...state.status, message: reasonMessage(reason) },
      }));
      if (isTauriRuntime()) {
        throw reason;
      }
    }
    return;
  }

  set((state) => ({
    chatStatus: "submitted",
    runningSessions: localSessionId
      ? {
          ...state.runningSessions,
          [localSessionId]: true,
        }
      : state.runningSessions,
    timeline: [
      ...state.timeline,
      {
        id: `user-${Date.now()}`,
        kind: "message",
        role: "user",
        content: timelineContent,
        startedAt: Date.now(),
        attachments:
          attachments.length > 0 ? timelineAttachments(attachments) : undefined,
      },
    ],
  }));

  if (!isTauriRuntime()) {
    const sessionId = get().acpSessionId;
    if (!sessionId || !localSessionId) {
      set((state) => ({
        acpPhase: "error",
        chatStatus: "error",
        status: {
          ...state.status,
          message: "预览 ACP 会话尚未就绪，请重新打开会话。",
        },
      }));
      return;
    }
    const id = allocatePromptRequestId();
    const promptId = `melody-work-${localSessionId}-${id}`;
    pendingPrompts.set(id, {
      acpSessionId: sessionId,
      localSessionId,
      promptId,
      createdAt: Date.now(),
    });
    set({ acpPhase: "prompting" });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { sessionId, prompt, _meta: { promptId } },
      });
      if (pendingPrompts.has(id)) {
        armPromptFirstEventTimeout(id, get);
      }
    } catch (reason) {
      removePendingPrompt(id);
      set((state) => ({
        acpPhase: "error",
        chatStatus: "error",
        runningSessions: {
          ...state.runningSessions,
          [localSessionId]: false,
        },
        status: { ...state.status, message: reasonMessage(reason) },
      }));
    }
    return;
  }

  const sessionId = get().acpSessionId;
  if (!sessionId) {
    set((state) => ({
      chatStatus: "error",
      acpPhase: "error",
      runningSessions: localSessionId
        ? {
            ...state.runningSessions,
            [localSessionId]: false,
          }
        : state.runningSessions,
      status: {
        ...state.status,
        message: "Melody 会话尚未就绪，请重新打开会话后重试。",
      },
    }));
    return;
  }
  if (!localSessionId) {
    return;
  }
  const id = allocatePromptRequestId();
  const promptId = `melody-work-${localSessionId}-${id}`;
  pendingPrompts.set(id, {
    acpSessionId: sessionId,
    localSessionId,
    promptId,
    createdAt: Date.now(),
  });
  pendingUserEchoBlocks.set(sessionId, prompt.length);
  set({ acpPhase: "prompting" });
  try {
    await sendAcp({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId,
        prompt,
        _meta: { promptId },
      },
    });
    if (pendingPrompts.has(id)) {
      armPromptFirstEventTimeout(id, get);
    }
  } catch (reason) {
    removePendingPrompt(id);
    set((state) => ({
      acpPhase: "error",
      chatStatus: "error",
      runningSessions: {
        ...state.runningSessions,
        [localSessionId]: false,
      },
      status: { ...state.status, message: reasonMessage(reason) },
    }));
    throw reason;
  }
};
