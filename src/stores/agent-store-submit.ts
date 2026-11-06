import { toUserMessage as reasonMessage } from "@/domain/app-error";
import {
  formatExplorerSessionReferenceContext,
  MAX_EXPLORER_SESSION_REFERENCES,
  parseExplorerSessionReferences,
} from "@/domain/agent/explorer-branch";
import { isTauriRuntime } from "@/lib/melody-bridge";
import { sendAgentTurn } from "@/lib/agent-client";
import { readPiSessionForkReference } from "@/lib/melody-bridge-workspace";
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

  const stateBeforeSubmit = get();
  const localSessionId = stateBeforeSubmit.localSessionId;
  let promptContent = trimmed;
  let prompt: Record<string, unknown>[];
  try {
    const references = parseExplorerSessionReferences(trimmed);
    if (references.sessionIds.length > MAX_EXPLORER_SESSION_REFERENCES) {
      throw new Error(
        `一次最多引用 ${MAX_EXPLORER_SESSION_REFERENCES} 个 Explorer 分支。`,
      );
    }
    if (references.sessionIds.length > 0) {
      if (!localSessionId) {
        throw new Error("Explorer 分支引用需要一个已打开的源会话。 ");
      }
      const contexts = await Promise.all(
        references.sessionIds.map(async (branchSessionId) => {
          const reference = await readPiSessionForkReference(
            localSessionId,
            branchSessionId,
          );
          return formatExplorerSessionReferenceContext(reference);
        }),
      );
      const latestState = get();
      if (
        latestState.localSessionId !== localSessionId ||
        latestState.runtimeSessionId !== stateBeforeSubmit.runtimeSessionId ||
        latestState.chatStatus !== stateBeforeSubmit.chatStatus
      ) {
        throw new Error(
          "读取 Explorer 分支期间会话状态发生变化，请重新提交。 ",
        );
      }
      promptContent = [references.prompt, ...contexts]
        .filter(Boolean)
        .join("\n\n")
        .trim();
    }
    prompt = [
      ...(promptContent ? [{ type: "text", text: promptContent }] : []),
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
  const sendTurn = (
    requestId: number,
    sessionId: string,
    promptId: string,
    streamingBehavior?: "steer" | "followUp",
  ) => {
    const state = get();
    return sendAgentTurn({
      requestId,
      sessionId,
      promptId,
      content: promptContent,
      attachments,
      streamingBehavior,
      config: {
        modelId: state.selectedModelId,
        reasoningEffort: state.selectedReasoningEffort,
        sessionModeId: state.selectedSessionModeId,
        permissionMode: state.permissionMode,
        // Pi checks this optimistic-concurrency token before accepting a
        // turn, so a stale composer cannot run with an older configuration.
        configRevision: state.configRevision,
      },
    });
  };

  if (stateBeforeSubmit.chatStatus !== "ready") {
    const sessionId = stateBeforeSubmit.runtimeSessionId;
    if (!sessionId || !localSessionId) {
      return;
    }
    set((state) => ({
      chatStatus: "submitted",
      runtimePhase: "prompting",
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
      runtimeSessionId: sessionId,
      localSessionId,
      promptId,
      createdAt: Date.now(),
    });
    pendingUserEchoBlocks.set(
      sessionId,
      (pendingUserEchoBlocks.get(sessionId) ?? 0) + prompt.length,
    );
    try {
      await sendTurn(
        id,
        sessionId,
        promptId,
        useAppSettingsStore.getState().followUpBehavior === "steer"
          ? "steer"
          : "followUp",
      );
      if (pendingPrompts.has(id)) {
        armPromptFirstEventTimeout(id, get);
      }
    } catch (reason) {
      removePendingPrompt(id);
      set((state) => ({
        runtimePhase: "error",
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
    const sessionId = get().runtimeSessionId;
    if (!sessionId || !localSessionId) {
      set((state) => ({
        runtimePhase: "error",
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
      runtimeSessionId: sessionId,
      localSessionId,
      promptId,
      createdAt: Date.now(),
    });
    set({ runtimePhase: "prompting" });
    try {
      await sendTurn(id, sessionId, promptId);
      if (pendingPrompts.has(id)) {
        armPromptFirstEventTimeout(id, get);
      }
    } catch (reason) {
      removePendingPrompt(id);
      set((state) => ({
        runtimePhase: "error",
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

  const sessionId = get().runtimeSessionId;
  if (!sessionId) {
    set((state) => ({
      chatStatus: "error",
      runtimePhase: "error",
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
    runtimeSessionId: sessionId,
    localSessionId,
    promptId,
    createdAt: Date.now(),
  });
  pendingUserEchoBlocks.set(sessionId, prompt.length);
  set({ runtimePhase: "prompting" });
  try {
    await sendTurn(id, sessionId, promptId);
    if (pendingPrompts.has(id)) {
      armPromptFirstEventTimeout(id, get);
    }
  } catch (reason) {
    removePendingPrompt(id);
    set((state) => ({
      runtimePhase: "error",
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
