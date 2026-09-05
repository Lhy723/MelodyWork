import { toUserMessage as reasonMessage } from "@/domain/app-error";
import {
  contextUsageFromTimeline,
  parseTimelineProjection,
  readTimelineProjection,
  TIMELINE_PROJECTION_VERSION,
  usableTimelineProjection,
} from "@/domain/session-projection";
import { INITIALIZE_REQUEST_ID } from "./agent-store-runtime";
import { isTauriRuntime, sendAcp } from "@/lib/melody-bridge";
import {
  armSetupTimeout,
  fullReplayStarted,
  loadFallbackTimelines,
  previewTimeline,
  sendSessionOpen,
  sessionEventDeduplicator,
} from "./agent-store-runtime";
import { contextUsageForModel } from "./agent-store-parsing";
import type { AgentStore, AgentStoreAccess } from "./agent-store-types";

export const beginAgentSession = async (
  store: AgentStoreAccess,
  ...args: Parameters<AgentStore["beginSession"]>
) => {
  const [
    cwd,
    localSessionId,
    acpSessionId,
    timelineJson,
    acpCursor,
    timelineVersion,
    archivedTimelineJson,
    forceInitialize = false,
  ] = args;
  const { get, set } = store;

  const projectionTimelineJson = archivedTimelineJson ?? timelineJson;
  // The archive can restore the display independently. A cursor is only
  // safe when the bounded snapshot was written as a complete projection;
  // version 0 deliberately forces ACP replay after compaction or migration.
  const projectionVersion = timelineVersion;
  const projectionCursor =
    projectionVersion === TIMELINE_PROJECTION_VERSION ? acpCursor : undefined;
  const fallbackTimeline = parseTimelineProjection(projectionTimelineJson);
  const archivedProjection = archivedTimelineJson
    ? readTimelineProjection(archivedTimelineJson)
    : undefined;
  const projectionRead = readTimelineProjection(projectionTimelineJson);
  const restoredTimeline = archivedProjection
    ? archivedProjection.status === "valid"
      ? archivedProjection.timeline
      : []
    : usableTimelineProjection({
        timelineJson: projectionTimelineJson,
        cursor: projectionCursor,
        version: projectionVersion,
      });
  const restoredCursor =
    projectionVersion === TIMELINE_PROJECTION_VERSION &&
    (archivedProjection?.status ?? projectionRead.status) === "valid"
      ? projectionCursor
      : undefined;
  const persistedContextUsage = contextUsageFromTimeline(restoredTimeline);
  const state = get();
  if (!isTauriRuntime()) {
    const displayTimeline =
      localSessionId === "implement-acp-bridge" && restoredTimeline.length === 0
        ? previewTimeline
        : restoredTimeline;
    set({
      activeSessionId: localSessionId,
      localSessionId,
      cwd,
      acpSessionId,
      acpCursor: restoredCursor,
      timeline: displayTimeline,
      contextUsage:
        contextUsageFromTimeline(displayTimeline) ??
        contextUsageForModel(state.availableModels, state.selectedModelId),
      acpPhase: "initializing",
      chatStatus: "submitted",
    });
    try {
      await sendAcp({
        jsonrpc: "2.0",
        id: INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: {}, terminal: false },
          _meta: { clientType: "melody-work-preview" },
        },
      });
      armSetupTimeout(
        localSessionId,
        "initializing",
        "浏览器预览 ACP 初始化超时。",
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
    return;
  }

  if (
    state.localSessionId === localSessionId &&
    (state.acpPhase === "initializing" ||
      state.acpPhase === "authenticating" ||
      state.acpPhase === "creating" ||
      state.acpPhase === "ready" ||
      state.acpPhase === "prompting")
  ) {
    return;
  }

  // 切换会话时，把当前 timeline 存入后台缓冲（以 acpSessionId 索引），
  // 这样旧会话后续的 ACP 消息可以继续追加到缓冲而非丢失。
  const oldAcpSessionId = state.acpSessionId;
  const backgroundTimelines = { ...state.backgroundTimelines };
  const backgroundCursors = { ...state.backgroundCursors };
  const backgroundContextUsage = { ...state.backgroundContextUsage };
  if (
    oldAcpSessionId &&
    state.localSessionId &&
    state.localSessionId !== localSessionId
  ) {
    backgroundTimelines[oldAcpSessionId] = state.timeline;
    if (state.acpCursor) {
      backgroundCursors[oldAcpSessionId] = state.acpCursor;
    }
    if (state.contextUsage) {
      backgroundContextUsage[oldAcpSessionId] = state.contextUsage;
    }
  }

  // 恢复新会话：优先使用后台缓冲（含切换后产生的新回复），
  // 否则从数据库持久化的 timelineJson 恢复。
  const restoredFromBuffer = acpSessionId
    ? backgroundTimelines[acpSessionId]
    : undefined;
  const finalTimeline = restoredFromBuffer ?? restoredTimeline;
  const finalCursor =
    restoredFromBuffer && acpSessionId
      ? backgroundCursors[acpSessionId]
      : restoredCursor;
  const restoredContextUsage =
    contextUsageFromTimeline(finalTimeline) ??
    (acpSessionId ? backgroundContextUsage[acpSessionId] : undefined) ??
    persistedContextUsage;
  // Older sessions persisted the conversation and cursor before tokenUsage
  // was added to timeline entries. Replaying from the beginning once lets
  // Melody Build's `_meta.totalTokens` backfill that durable usage metadata.
  // Keep the cached timeline visible while the replay is in flight, but do
  // not advertise the stale cursor as restorable if the app is interrupted.
  const shouldRebuildContextUsage = Boolean(
    acpSessionId && finalCursor && !restoredContextUsage,
  );
  const sessionLoadCursor = shouldRebuildContextUsage ? undefined : finalCursor;
  if (acpSessionId && restoredFromBuffer) {
    delete backgroundTimelines[acpSessionId];
    delete backgroundCursors[acpSessionId];
  }
  if (acpSessionId && restoredContextUsage) {
    delete backgroundContextUsage[acpSessionId];
  }
  if (acpSessionId) {
    loadFallbackTimelines.set(localSessionId, fallbackTimeline);
    fullReplayStarted.delete(acpSessionId);
    sessionEventDeduplicator.reset(acpSessionId);
  }

  set({
    activeSessionId: localSessionId,
    localSessionId,
    cwd,
    acpSessionId,
    acpCursor: sessionLoadCursor,
    timeline: finalTimeline,
    backgroundTimelines,
    backgroundCursors,
    contextUsage:
      restoredContextUsage ??
      contextUsageForModel(state.availableModels, state.selectedModelId),
    backgroundContextUsage,
    availableSessionModes: [],
    selectedSessionModeId: undefined,
    pendingSessionModeId: undefined,
    acpPhase:
      forceInitialize ||
      state.acpPhase === "idle" ||
      state.acpPhase === "error" ||
      state.acpPhase === "initializing"
        ? "initializing"
        : "creating",
    chatStatus: "submitted",
  });
  try {
    const protocolReady =
      !forceInitialize &&
      state.acpPhase !== "idle" &&
      state.acpPhase !== "error" &&
      state.acpPhase !== "initializing";
    if (protocolReady) {
      await sendSessionOpen(
        localSessionId,
        cwd,
        acpSessionId,
        state.selectedModelId,
        state.permissionMode,
        sessionLoadCursor,
      );
      armSetupTimeout(
        localSessionId,
        "creating",
        "打开 Melody 会话超时。",
        get,
        set,
      );
      return;
    }
    await sendAcp({
      jsonrpc: "2.0",
      id: INITIALIZE_REQUEST_ID,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        _meta: {
          startupHints: {
            nonInteractive: false,
            skipGitStatus: false,
            skipProjectLayout: false,
          },
          clientType: "melody-work",
          clientVersion: "0.1.0",
        },
      },
    });
    armSetupTimeout(
      localSessionId,
      "initializing",
      "初始化 Melody Build 超时。",
      get,
      set,
    );
  } catch (reason) {
    set({
      acpPhase: "error",
      chatStatus: "error",
      status: {
        ...get().status,
        message: reasonMessage(reason),
      },
    });
  }
};
