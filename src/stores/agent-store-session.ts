import { toUserMessage as reasonMessage } from "@/domain/app-error";
import { RequestGate } from "@/domain/request-gate";
import { buildPiSessionImportPlan } from "@/domain/agent/pi-session-import";
import type { JsonObject } from "@/domain/agent/contract";
import {
  contextUsageFromTimeline,
  parseTimelineProjection,
  readTimelineProjection,
  TIMELINE_PROJECTION_VERSION,
  usableTimelineProjection,
} from "@/domain/session-projection";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  beginPiMigration,
  failPiMigration,
} from "@/lib/melody-bridge-workspace";
import { INITIALIZE_REQUEST_ID } from "./agent-store-runtime";
import { getPiAgentSessionBinding, isTauriRuntime } from "@/lib/melody-bridge";
import {
  armSetupTimeout,
  fullReplayStarted,
  loadFallbackTimelines,
  previewTimeline,
  sendSessionOpen,
  sessionEventDeduplicator,
} from "./agent-store-runtime";
import { contextUsageForModel } from "./agent-store-parsing";
import { resetPiEventProjection } from "./agent-store-pi";
import { PI_SESSION_MODE_OPTIONS } from "@/domain/agent/pi-session-modes";
import {
  ARCHIVE_STATUS_NOTICE,
  shouldImportPiSession,
} from "@/domain/agent/session-archive";
import type { AgentStore, AgentStoreAccess } from "./agent-store-types";

const sessionActivationGates = new WeakMap<
  AgentStoreAccess["get"],
  RequestGate
>();

const sessionActivationGateFor = (get: AgentStoreAccess["get"]) => {
  let gate = sessionActivationGates.get(get);
  if (!gate) {
    gate = new RequestGate();
    sessionActivationGates.set(get, gate);
  }
  return gate;
};

/**
 * Shared timeline-seeding used by both open paths: restore the visible
 * history from the persisted archive (preferred) or the bounded snapshot.
 * A cursor is only safe when the bounded snapshot was written as a complete
 * projection; version 0 deliberately forces ACP replay after compaction or
 * migration.
 */
const restoreSessionHistory = (input: {
  timelineJson?: string;
  archivedTimelineJson?: string;
  sourceAcpCursor?: string;
  timelineVersion?: number;
}) => {
  const projectionTimelineJson =
    input.archivedTimelineJson ?? input.timelineJson;
  const projectionVersion = input.timelineVersion;
  const projectionCursor =
    projectionVersion === TIMELINE_PROJECTION_VERSION
      ? input.sourceAcpCursor
      : undefined;
  const fallbackTimeline = parseTimelineProjection(projectionTimelineJson);
  const archivedProjection = input.archivedTimelineJson
    ? readTimelineProjection(input.archivedTimelineJson)
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
  return {
    fallbackTimeline,
    restoredTimeline,
    restoredCursor,
    archivedProjection,
    projectionRead,
  };
};

export const beginAgentSession = async (
  store: AgentStoreAccess,
  ...args: Parameters<AgentStore["beginSession"]>
) => {
  const [
    cwd,
    localSessionId,
    sourceAcpSessionId,
    timelineJson,
    sourceAcpCursor,
    timelineVersion,
    archivedTimelineJson,
    forceInitialize = false,
  ] = args;
  const { get, set } = store;
  const activationGate = sessionActivationGateFor(get);
  const beginActivation = () => {
    const generation = activationGate.begin();
    const isCurrent = () => {
      const current = get();
      return (
        activationGate.isCurrent(generation) &&
        current.localSessionId === localSessionId &&
        current.activeSessionId === localSessionId &&
        !current.archivedReadOnly
      );
    };
    const setIfCurrent: AgentStoreAccess["set"] = (update) => {
      if (isCurrent()) {
        set(update);
      }
    };
    return { isCurrent, setIfCurrent };
  };
  const currentState = get();
  const piSelected = isTauriRuntime();
  const expectedRuntimeSessionId = piSelected
    ? localSessionId
    : sourceAcpSessionId;
  const currentRuntimeMatches =
    currentState.runtimeSessionId === expectedRuntimeSessionId;
  const previousSourceAcpSessionId = sourceAcpSessionId;
  // Pi uses the product session ID as the renderer-facing execution key. ACP
  // native IDs are intentionally not sent to Pi: they are not valid Pi tree
  // cursors and would make a resumed session open the wrong history.
  const runtimeSessionId = piSelected ? localSessionId : sourceAcpSessionId;
  if (
    currentState.localSessionId !== localSessionId ||
    !currentRuntimeMatches
  ) {
    resetPiEventProjection(localSessionId);
  }

  const {
    fallbackTimeline,
    restoredTimeline,
    restoredCursor,
    archivedProjection,
    projectionRead,
  } = restoreSessionHistory({
    timelineJson,
    archivedTimelineJson,
    sourceAcpCursor,
    timelineVersion,
  });
  const persistedContextUsage = contextUsageFromTimeline(restoredTimeline);
  const state = get();
  if (!isTauriRuntime()) {
    const { isCurrent, setIfCurrent } = beginActivation();
    const displayTimeline =
      localSessionId === "implement-acp-bridge" && restoredTimeline.length === 0
        ? previewTimeline
        : restoredTimeline;
    set({
      activeSessionId: localSessionId,
      localSessionId,
      cwd,
      runtimeSessionId: sourceAcpSessionId,
      eventCursor: restoredCursor,
      timeline: displayTimeline,
      contextUsage:
        contextUsageFromTimeline(displayTimeline) ??
        contextUsageForModel(state.availableModels, state.selectedModelId),
      configRevision: 0,
      runtimePhase: "initializing",
      chatStatus: "submitted",
      archivedReadOnly: false,
    });
    try {
      await sendAgentCommand({
        protocolVersion: 1,
        requestId: INITIALIZE_REQUEST_ID,
        sessionId: localSessionId,
        command: {
          type: "runtime.health",
          sessionId: localSessionId,
          clientType: "melody-work-preview",
          clientCapabilities: { fs: {}, terminal: false },
        },
      });
      if (isCurrent()) {
        armSetupTimeout(
          localSessionId,
          "initializing",
          "浏览器预览 ACP 初始化超时。",
          get,
          setIfCurrent,
        );
      }
    } catch (reason) {
      setIfCurrent({
        runtimePhase: "error",
        chatStatus: "error",
        status: { ...get().status, message: reasonMessage(reason) },
      });
    }
    return;
  }

  if (
    state.localSessionId === localSessionId &&
    currentRuntimeMatches &&
    (state.runtimePhase === "initializing" ||
      state.runtimePhase === "authenticating" ||
      state.runtimePhase === "creating" ||
      state.runtimePhase === "ready" ||
      state.runtimePhase === "prompting")
  ) {
    return;
  }

  // An already-active same-session open remains an idempotent no-op; it must
  // not invalidate the generation that owns the in-flight activation.
  const { isCurrent, setIfCurrent } = beginActivation();

  // 切换会话时，按来源 ACP session key 保存当前 timeline，
  // 这样旧预览会话后续的消息可以继续追加到缓冲而非丢失。
  const oldRuntimeSessionId = state.runtimeSessionId;
  const backgroundTimelines = { ...state.backgroundTimelines };
  const backgroundCursors = { ...state.backgroundCursors };
  const backgroundContextUsage = { ...state.backgroundContextUsage };
  if (
    oldRuntimeSessionId &&
    state.localSessionId &&
    state.localSessionId !== localSessionId
  ) {
    backgroundTimelines[oldRuntimeSessionId] = state.timeline;
    if (state.eventCursor) {
      backgroundCursors[oldRuntimeSessionId] = state.eventCursor;
    }
    if (state.contextUsage) {
      backgroundContextUsage[oldRuntimeSessionId] = state.contextUsage;
    }
  }

  // 恢复新会话：优先使用后台缓冲（含切换后产生的新回复），
  // 否则从数据库持久化的 timelineJson 恢复。
  const restoredFromBuffer = sourceAcpSessionId
    ? backgroundTimelines[sourceAcpSessionId]
    : undefined;
  const finalTimeline = restoredFromBuffer ?? restoredTimeline;
  const finalCursor =
    restoredFromBuffer && sourceAcpSessionId
      ? backgroundCursors[sourceAcpSessionId]
      : restoredCursor;
  const restoredContextUsage =
    contextUsageFromTimeline(finalTimeline) ??
    (sourceAcpSessionId
      ? backgroundContextUsage[sourceAcpSessionId]
      : undefined) ??
    persistedContextUsage;
  // Older sessions persisted the conversation and cursor before tokenUsage
  // was added to timeline entries. Replaying from the beginning once lets
  // Melody Build's `_meta.totalTokens` backfill that durable usage metadata.
  // Keep the cached timeline visible while the replay is in flight, but do
  // not advertise the stale cursor as restorable if the app is interrupted.
  const shouldRebuildContextUsage = Boolean(
    sourceAcpSessionId && finalCursor && !restoredContextUsage,
  );
  const sessionLoadCursor = shouldRebuildContextUsage ? undefined : finalCursor;
  if (sourceAcpSessionId && restoredFromBuffer) {
    delete backgroundTimelines[sourceAcpSessionId];
    delete backgroundCursors[sourceAcpSessionId];
  }
  if (sourceAcpSessionId && restoredContextUsage) {
    delete backgroundContextUsage[sourceAcpSessionId];
  }
  if (sourceAcpSessionId) {
    loadFallbackTimelines.set(localSessionId, fallbackTimeline);
    fullReplayStarted.delete(sourceAcpSessionId);
    sessionEventDeduplicator.reset(sourceAcpSessionId);
  }

  set({
    activeSessionId: localSessionId,
    localSessionId,
    cwd,
    runtimeSessionId,
    eventCursor: piSelected ? undefined : sessionLoadCursor,
    timeline: finalTimeline,
    backgroundTimelines,
    backgroundCursors,
    contextUsage:
      restoredContextUsage ??
      contextUsageForModel(state.availableModels, state.selectedModelId),
    configRevision: 0,
    backgroundContextUsage,
    availableSessionModes: piSelected ? PI_SESSION_MODE_OPTIONS : [],
    selectedSessionModeId: piSelected ? "default" : undefined,
    pendingSessionModeId: undefined,
    archivedReadOnly: false,
    runtimePhase:
      forceInitialize ||
      state.runtimePhase === "idle" ||
      state.runtimePhase === "error" ||
      state.runtimePhase === "initializing"
        ? "initializing"
        : "creating",
    chatStatus: "submitted",
  });
  try {
    if (piSelected) {
      // A worker health request is cheap and idempotent. Send it whenever the
      // worker was just started (or the store was not already ready), then
      // request the same catalog the picker uses before opening a session.
      const protocolReady =
        !forceInitialize &&
        state.runtimePhase !== "idle" &&
        state.runtimePhase !== "error" &&
        state.runtimePhase !== "initializing";
      if (!protocolReady) {
        await sendAgentCommand({
          protocolVersion: 1,
          requestId: INITIALIZE_REQUEST_ID,
          sessionId: localSessionId,
          command: {
            type: "runtime.health",
            sessionId: localSessionId,
            clientType: "melody-work",
            clientVersion: "0.1.0",
            clientCapabilities: {
              normalizedEvents: true,
              hostToolGateway: true,
              nativeSessionImport: true,
            },
          },
        });
        await sendAgentCommand({
          protocolVersion: 1,
          requestId: `${INITIALIZE_REQUEST_ID}-models`,
          sessionId: localSessionId,
          command: {
            type: "runtime.models.list",
            sessionId: localSessionId,
            refresh: false,
          },
        });
      }

      const binding = await getPiAgentSessionBinding(localSessionId);
      const latestState = get();
      const persistedSessionModeId = PI_SESSION_MODE_OPTIONS.some(
        (option) => option.id === binding?.sessionModeId,
      )
        ? (binding?.sessionModeId ?? "default")
        : "default";
      const persistedPermissionMode =
        binding?.permissionMode === "ask" ||
        binding?.permissionMode === "auto" ||
        binding?.permissionMode === "always-approve"
          ? binding.permissionMode
          : latestState.permissionMode;
      // Bindings written by schema v10 are the durable source of truth for the
      // model controls as well. Keep an unavailable model only when the
      // catalog has not arrived yet; once a catalog is present, fall back to
      // the renderer's known-good selection so reopening cannot be bricked by
      // a deleted provider/model entry.
      const bindingModelId =
        typeof binding?.modelId === "string" &&
        binding.modelId.trim() &&
        binding.modelId !== "unknown/unknown"
          ? binding.modelId
          : undefined;
      const bindingModelIsKnown =
        bindingModelId === undefined ||
        latestState.availableModels.length === 0 ||
        latestState.availableModels.some(
          (model) => model.id === bindingModelId,
        );
      const persistedModelId = bindingModelIsKnown
        ? (bindingModelId ?? latestState.selectedModelId)
        : latestState.selectedModelId;
      const selectedModel = latestState.availableModels.find(
        (model) => model.id === persistedModelId,
      );
      const persistedReasoningEffort =
        typeof binding?.reasoningEffort === "string" &&
        binding.reasoningEffort.trim()
          ? binding.reasoningEffort
          : undefined;
      // A binding can outlive a provider/model that was removed from the
      // catalog. When that happens we deliberately fall back to the current
      // renderer selection; carrying the old model's thinking level along
      // could make Pi reject the otherwise valid replacement model and turn a
      // recoverable catalog change into a session-open failure.
      const usablePersistedReasoningEffort = bindingModelIsKnown
        ? persistedReasoningEffort
        : undefined;
      const persistedSelectedReasoningEffort =
        usablePersistedReasoningEffort ??
        latestState.selectedReasoningEffort ??
        selectedModel?.reasoningEffort;
      // The binding is the durable source of truth after a worker restart.
      // Apply it before opening/importing so the composer and the first turn
      // do not briefly advertise the renderer's stale defaults.
      setIfCurrent({
        selectedModelId: persistedModelId,
        selectedReasoningEffort: persistedSelectedReasoningEffort,
        selectedSessionModeId: persistedSessionModeId,
        permissionMode: persistedPermissionMode,
      });
      const needsImport = shouldImportPiSession({
        piBindingEngine: binding?.engine,
        acpSessionId: previousSourceAcpSessionId,
      });
      if (needsImport) {
        const archiveIsComplete =
          archivedTimelineJson !== undefined &&
          archivedProjection?.status === "valid";
        const snapshotIsComplete =
          archivedTimelineJson === undefined &&
          timelineVersion === TIMELINE_PROJECTION_VERSION &&
          Boolean(finalCursor) &&
          projectionRead.status === "valid";
        const importPlan = buildPiSessionImportPlan({
          sessionId: localSessionId,
          ...(previousSourceAcpSessionId
            ? { acpSessionId: previousSourceAcpSessionId }
            : {}),
          ...(finalCursor ? { acpCursor: finalCursor } : {}),
          timelineComplete: archiveIsComplete || snapshotIsComplete,
          timeline: finalTimeline,
        });
        if (importPlan.readiness === "blocked") {
          throw new Error(
            `该会话暂时不能迁移到 Pi：${importPlan.blockers[0] ?? "迁移计划未通过安全检查。"}`,
          );
        }
        const importPlanValue = importPlan as unknown as JsonObject;
        const journal = await beginPiMigration({
          sessionId: localSessionId,
          sourceDigest: importPlan.sourceDigest,
          converterVersion: importPlan.converterVersion,
          validationReport: importPlanValue,
          plan: importPlanValue,
          backup: true,
        });
        if (journal.stage !== "applied") {
          try {
            await sendAgentCommand({
              protocolVersion: 1,
              requestId: `pi-import-${localSessionId}-${Date.now()}`,
              sessionId: localSessionId,
              command: {
                type: "session.import",
                sessionId: localSessionId,
                migrationId: journal.migrationId,
                cwd,
                ...(persistedModelId ? { modelId: persistedModelId } : {}),
                ...(persistedSelectedReasoningEffort
                  ? { reasoningEffort: persistedSelectedReasoningEffort }
                  : {}),
                sessionModeId: persistedSessionModeId,
                permissionMode: persistedPermissionMode,
                plan: importPlanValue,
                backup: journal.backupRequested,
              },
            });
          } catch (error) {
            try {
              await failPiMigration(journal.migrationId, localSessionId, error);
            } catch {
              // Preserve the original failure; the journal remains available
              // for a later retry/recovery action.
            }
            throw error;
          }
        }
      } else {
        await sendSessionOpen(
          localSessionId,
          cwd,
          localSessionId,
          persistedModelId,
          persistedPermissionMode,
          undefined,
          persistedSessionModeId,
          persistedSelectedReasoningEffort,
        );
      }
      if (isCurrent()) {
        armSetupTimeout(
          localSessionId,
          "creating",
          "打开 Pi 会话超时。",
          get,
          setIfCurrent,
        );
      }
      return;
    }
    const protocolReady =
      !forceInitialize &&
      state.runtimePhase !== "idle" &&
      state.runtimePhase !== "error" &&
      state.runtimePhase !== "initializing";
    if (protocolReady) {
      await sendSessionOpen(
        localSessionId,
        cwd,
        sourceAcpSessionId,
        state.selectedModelId,
        state.permissionMode,
        sessionLoadCursor,
      );
      if (isCurrent()) {
        armSetupTimeout(
          localSessionId,
          "creating",
          "打开 Melody 会话超时。",
          get,
          setIfCurrent,
        );
      }
      return;
    }
    await sendAgentCommand({
      protocolVersion: 1,
      requestId: INITIALIZE_REQUEST_ID,
      sessionId: localSessionId,
      command: {
        type: "runtime.health",
        sessionId: localSessionId,
        clientType: "melody-work",
        clientVersion: "0.1.0",
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        startupHints: {
          nonInteractive: false,
          skipGitStatus: false,
          skipProjectLayout: false,
        },
      },
    });
    if (isCurrent()) {
      armSetupTimeout(
        localSessionId,
        "initializing",
        "初始化 Melody Build 超时。",
        get,
        setIfCurrent,
      );
    }
  } catch (reason) {
    setIfCurrent({
      runtimePhase: "error",
      chatStatus: "error",
      status: {
        ...get().status,
        message: reasonMessage(reason),
      },
    });
  }
};

/**
 * Opens a legacy-engine session as a read-only archive. History is seeded
 * from the persisted data exactly like a normal open, but no engine process
 * is started, nothing is subscribed, and no initialize/session.open traffic
 * is ever sent. The composer gate reads `archivedReadOnly`.
 */
export const beginArchivedSession = async (
  store: AgentStoreAccess,
  cwd: string,
  localSessionId: string,
  timelineJson?: string,
  archivedTimelineJson?: string,
  timelineVersion?: number,
) => {
  const { get, set } = store;
  const state = get();
  // Switching away from a live session must keep its in-memory timeline
  // addressable, exactly like the normal open path (its later ACP messages,
  // if any, keep appending to the buffer instead of being lost).
  const oldRuntimeSessionId = state.runtimeSessionId;
  const backgroundTimelines = { ...state.backgroundTimelines };
  const backgroundCursors = { ...state.backgroundCursors };
  const backgroundContextUsage = { ...state.backgroundContextUsage };
  if (
    oldRuntimeSessionId &&
    state.localSessionId &&
    state.localSessionId !== localSessionId
  ) {
    backgroundTimelines[oldRuntimeSessionId] = state.timeline;
    if (state.eventCursor) {
      backgroundCursors[oldRuntimeSessionId] = state.eventCursor;
    }
    if (state.contextUsage) {
      backgroundContextUsage[oldRuntimeSessionId] = state.contextUsage;
    }
  }
  const { restoredTimeline } = restoreSessionHistory({
    timelineJson,
    archivedTimelineJson,
    // The archive is display-only: no cursor is advertised because nothing
    // will ever replay against it.
    sourceAcpCursor: undefined,
    timelineVersion,
  });
  set({
    activeSessionId: localSessionId,
    localSessionId,
    cwd,
    // Deliberately unbound: every store action that would emit engine
    // traffic bails out without an engine session id.
    runtimeSessionId: undefined,
    eventCursor: undefined,
    timeline: restoredTimeline,
    backgroundTimelines,
    backgroundCursors,
    backgroundContextUsage,
    contextUsage:
      contextUsageFromTimeline(restoredTimeline) ??
      contextUsageForModel(state.availableModels, state.selectedModelId),
    configRevision: 0,
    availableSessionModes: [],
    selectedSessionModeId: undefined,
    pendingSessionModeId: undefined,
    archivedReadOnly: true,
    // No engine is attached, so the least-surprising phases are the neutral
    // ones rather than an in-flight or failure state.
    status: { phase: "stopped", message: ARCHIVE_STATUS_NOTICE },
    runtimePhase: "idle",
    chatStatus: "ready",
  });
};
