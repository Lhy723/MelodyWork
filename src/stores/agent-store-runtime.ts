import type {
  AgentSessionPhase,
  AgentPermissionMode,
  TimelineEntry,
} from "@/domain/acp";
import {
  markPromptStarted,
  shouldCancelBeforeFirstEvent,
} from "@/domain/prompt-timeout";
import { SessionEventDeduplicator } from "@/domain/session-projection";
import { sendAgentCommand } from "@/lib/agent-client";
import type { AgentStore } from "./agent-store-types";

export const armSetupTimeout = (
  localSessionId: string,
  expectedPhase: AgentSessionPhase,
  message: string,
  getState: () => Pick<
    AgentStore,
    "localSessionId" | "runtimePhase" | "status"
  >,
  setState: (state: Partial<AgentStore>) => void,
) => {
  window.setTimeout(() => {
    const state = getState();
    if (
      state.localSessionId === localSessionId &&
      state.runtimePhase === expectedPhase
    ) {
      setState({
        runtimePhase: "error",
        chatStatus: "error",
        status: { ...state.status, message },
      });
    }
  }, SETUP_TIMEOUT_MS);
};

export const INITIALIZE_REQUEST_ID = 1;
export const AUTHENTICATE_REQUEST_ID = 2;
export const SET_MODEL_REQUEST_ID = 4;
export const SET_REASONING_EFFORT_REQUEST_ID = 5;
export const SET_SESSION_MODE_REQUEST_ID = 6;
export const SETUP_TIMEOUT_MS = 20_000;
export const PROMPT_FIRST_EVENT_TIMEOUT_MS = 30_000;
export const TRANSIENT_STATE_MAX_AGE_MS = 10 * 60 * 1000;
export const TRANSIENT_STATE_SWEEP_MS = 60 * 1000;
let nextPromptRequestId = 100;
export const allocatePromptRequestId = () => nextPromptRequestId++;
let nextSessionOpenRequestId = -1;
export const sessionEventDeduplicator = new SessionEventDeduplicator();
export const fullReplayStarted = new Set<string>();
export const loadFallbackTimelines = new Map<string, TimelineEntry[]>();
export const pendingUserEchoBlocks = new Map<string, number>();
export const pendingSessionOpens = new Map<
  number,
  { localSessionId: string; requestedSessionId?: string; createdAt: number }
>();

// prompt 请求 ID → 前后端会话映射，用于路由后台响应和运行状态。
export const pendingPrompts = new Map<
  number,
  {
    runtimeSessionId: string;
    localSessionId: string;
    promptId: string;
    createdAt: number;
    firstEventAt?: number;
    responseReceivedAt?: number;
  }
>();
const promptTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
export const cancelledPromptIds = new Set<string>();

export const clearPromptTimeout = (requestId: number) => {
  const timeout = promptTimeouts.get(requestId);
  if (timeout !== undefined) {
    clearTimeout(timeout);
    promptTimeouts.delete(requestId);
  }
};

export const clearPromptTimeouts = () => {
  for (const requestId of promptTimeouts.keys()) {
    clearPromptTimeout(requestId);
  }
};

export const rememberCancelledPrompt = (promptId: string) => {
  cancelledPromptIds.add(promptId);
  while (cancelledPromptIds.size > 256) {
    const oldest = cancelledPromptIds.values().next().value;
    if (oldest === undefined) {
      break;
    }
    cancelledPromptIds.delete(oldest);
  }
};

export const pruneTransientState = () => {
  const cutoff = Date.now() - TRANSIENT_STATE_MAX_AGE_MS;
  for (const [requestId, request] of pendingSessionOpens) {
    if (request.createdAt < cutoff) {
      pendingSessionOpens.delete(requestId);
      loadFallbackTimelines.delete(request.localSessionId);
    }
  }
  for (const [requestId, request] of pendingPrompts) {
    if (request.createdAt < cutoff) {
      pendingPrompts.delete(requestId);
      clearPromptTimeout(requestId);
      pendingUserEchoBlocks.delete(request.runtimeSessionId);
    }
  }
  if (fullReplayStarted.size > 128) {
    fullReplayStarted.clear();
    sessionEventDeduplicator.clear();
  }
};

export const clearTransientState = () => {
  pendingSessionOpens.clear();
  pendingPrompts.clear();
  clearPromptTimeouts();
  pendingUserEchoBlocks.clear();
  loadFallbackTimelines.clear();
  fullReplayStarted.clear();
  sessionEventDeduplicator.clear();
  cancelledPromptIds.clear();
};

// A dead ACP process may never deliver another event to trigger pruning.
// Keep the module-level registries bounded even while the desktop remains open.
export const scheduleTransientStateSweep = () => {
  if (typeof window === "undefined") {
    return;
  }
  window.setTimeout(() => {
    pruneTransientState();
    scheduleTransientStateSweep();
  }, TRANSIENT_STATE_SWEEP_MS);
};
scheduleTransientStateSweep();

export const previewTimeline: TimelineEntry[] = [
  {
    id: "user-1",
    kind: "message",
    role: "user",
    content: "通过 ACP stdio 将 MelodyWork 连接到内置 Melody Build 智能体。",
  },
  {
    id: "assistant-1",
    kind: "message",
    role: "assistant",
    content:
      "我会验证桌面连接、初始化 ACP 会话，并让界面与工具及权限事件保持同步。",
  },
  {
    id: "tool-1",
    kind: "tool",
    toolCallId: "preview-check",
    title: "运行前端检查",
    command: "pnpm check",
    output:
      "> melody-work@0.1.0 check\n> tsc --noEmit\n\n正在等待运行此命令的授权。",
    status: "pending",
    permission: "pending",
    permissionRequestId: "preview-permission",
    permissionOptions: [
      { optionId: "reject-once", name: "拒绝一次", kind: "reject_once" },
      { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
      {
        optionId: "always-allow",
        name: "本会话始终允许",
        kind: "allow_always",
      },
    ],
  },
];

export const pendingPromptForSession = (sessionId: string) =>
  [...pendingPrompts.entries()].find(
    ([, pending]) => pending.runtimeSessionId === sessionId,
  );

export const removePendingPrompt = (requestId: number) => {
  const pending = pendingPrompts.get(requestId);
  if (!pending) {
    return undefined;
  }
  pendingPrompts.delete(requestId);
  clearPromptTimeout(requestId);
  pendingUserEchoBlocks.delete(pending.runtimeSessionId);
  return pending;
};

export const armPromptFirstEventTimeout = (
  requestId: number,
  getState: () => Pick<
    AgentStore,
    "localSessionId" | "runtimeSessionId" | "chatStatus" | "cancelPrompt"
  >,
) => {
  clearPromptTimeout(requestId);
  promptTimeouts.set(
    requestId,
    setTimeout(() => {
      clearPromptTimeout(requestId);
      const pending = pendingPrompts.get(requestId);
      const state = getState();
      if (
        !pending ||
        state.localSessionId !== pending.localSessionId ||
        state.runtimeSessionId !== pending.runtimeSessionId ||
        !shouldCancelBeforeFirstEvent(
          pending,
          Date.now(),
          PROMPT_FIRST_EVENT_TIMEOUT_MS,
        ) ||
        (state.chatStatus !== "submitted" && state.chatStatus !== "streaming")
      ) {
        return;
      }
      // This only guards a completely silent prompt. Tool-level deadlines
      // belong to the sidecar, while a started tool remains user-cancellable.
      void state.cancelPrompt("timeout");
    }, PROMPT_FIRST_EVENT_TIMEOUT_MS),
  );
};

export const markPromptActivity = (sessionId?: string) => {
  if (!sessionId) {
    return;
  }
  const pending = pendingPromptForSession(sessionId);
  if (!pending || pending[1].firstEventAt !== undefined) {
    return;
  }
  clearPromptTimeout(pending[0]);
  pendingPrompts.set(pending[0], markPromptStarted(pending[1], Date.now()));
};

export const sendSessionOpen = async (
  localSessionId: string,
  cwd: string,
  runtimeSessionId?: string,
  modelId?: string,
  permissionMode: AgentPermissionMode = "ask",
  eventCursor?: string,
  sessionModeId?: string,
  reasoningEffort?: string,
) => {
  const requestId = nextSessionOpenRequestId--;
  pendingSessionOpens.set(requestId, {
    localSessionId,
    requestedSessionId: runtimeSessionId,
    createdAt: Date.now(),
  });
  try {
    await sendAgentCommand({
      protocolVersion: 1,
      requestId,
      sessionId: runtimeSessionId,
      command: {
        type: "session.open",
        ...(runtimeSessionId ? { sessionId: runtimeSessionId } : {}),
        productSessionId: localSessionId,
        cwd,
        ...(modelId ? { modelId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(sessionModeId ? { sessionModeId } : {}),
        permissionMode,
        ...(eventCursor ? { cursor: eventCursor } : {}),
      },
    });
  } catch (reason) {
    pendingSessionOpens.delete(requestId);
    throw reason;
  }
};
