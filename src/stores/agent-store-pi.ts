import type { AgentEventEnvelope } from "@/domain/agent/contract";
import { AgentEventStoreAdapter } from "@/domain/agent/event-store-adapter";
import type { AgentStore, AgentStoreAccess } from "./agent-store-types";
import {
  SET_MODEL_REQUEST_ID,
  SET_REASONING_EFFORT_REQUEST_ID,
  SET_SESSION_MODE_REQUEST_ID,
  markPromptActivity,
  pendingPromptForSession,
  pendingPrompts,
  removePendingPrompt,
} from "./agent-store-runtime";

const piEventStoreAdapter = new AgentEventStoreAdapter();

const sameRequestId = (
  left: string | number | undefined,
  right: string | number,
): boolean => left !== undefined && String(left) === String(right);

const failedConfigurationPatch = (
  event: AgentEventEnvelope,
): Pick<
  AgentStore,
  "pendingModelId" | "pendingReasoningEffort" | "pendingSessionModeId"
> => {
  if (event.event.type !== "runtime.error") return {};
  if (sameRequestId(event.requestId, SET_MODEL_REQUEST_ID)) {
    return { pendingModelId: undefined };
  }
  if (sameRequestId(event.requestId, SET_REASONING_EFFORT_REQUEST_ID)) {
    return { pendingReasoningEffort: undefined };
  }
  if (sameRequestId(event.requestId, SET_SESSION_MODE_REQUEST_ID)) {
    return { pendingSessionModeId: undefined };
  }
  return {};
};

const promptForPiEvent = (event: AgentEventEnvelope) => {
  const terminal =
    event.event.type === "run.finished" ||
    (event.event.type === "runtime.error" &&
      (event.event.error.scope === "run" ||
        event.event.error.scope === "session"));
  if (!terminal) return undefined;

  const explicitPromptId =
    event.event.type === "run.finished" ? event.event.promptId : undefined;
  if (explicitPromptId) {
    const byPromptId = [...pendingPrompts.entries()].find(
      ([, pending]) => pending.promptId === explicitPromptId,
    );
    if (byPromptId) return byPromptId;
  }

  // `requestId` is the command id for direct worker acknowledgements. The
  // run id fallback covers a terminal runtime error emitted by the Pi event
  // adapter, while keeping child task streams from closing the root prompt.
  if (typeof event.requestId === "number") {
    const byRequestId = pendingPrompts.get(event.requestId);
    if (byRequestId) return [event.requestId, byRequestId] as const;
  }
  if (event.streamSessionId) return undefined;
  if (event.runId) {
    const byRunId = [...pendingPrompts.entries()].find(
      ([, pending]) =>
        event.runId === `${pending.acpSessionId}:${pending.promptId}`,
    );
    if (byRunId) return byRunId;
  }
  return event.sessionId ? pendingPromptForSession(event.sessionId) : undefined;
};

const isPiActivityEvent = (event: AgentEventEnvelope): boolean =>
  !event.replay &&
  event.event.type !== "runtime.ready" &&
  event.event.type !== "runtime.models" &&
  event.event.type !== "runtime.warning" &&
  event.event.type !== "runtime.error" &&
  event.event.type !== "session.opened" &&
  event.event.type !== "session.closed" &&
  event.event.type !== "session.configured" &&
  event.event.type !== "session.imported";

const snapshotFor = (
  state: AgentStore,
): Parameters<AgentEventStoreAdapter["consume"]>[1] => ({
  // Pi emits the product session ID in its normalized event envelope. Keep
  // the archived ACP ID only as a data-identity fallback for older stores;
  // this does not select an execution engine.
  currentSessionId: state.localSessionId ?? state.acpSessionId,
  timeline: state.timeline,
  backgroundTimelines: state.backgroundTimelines,
  backgroundCursors: state.backgroundCursors,
  contextUsage: state.contextUsage,
  backgroundContextUsage: state.backgroundContextUsage,
  subagents: state.subagents,
  availableModels: state.availableModels,
  unavailableModels: state.unavailableModels,
  modelRefreshErrors: state.modelRefreshErrors,
  configRevision: state.configRevision,
  selectedModelId: state.selectedModelId,
  selectedReasoningEffort: state.selectedReasoningEffort,
  capabilities: state.capabilities,
  capabilityDiagnostics: state.capabilityDiagnostics,
});

/** Clear projectors when a product session is discarded or recreated. */
export const resetPiEventProjection = (sessionId?: string) =>
  (() => {
    piEventStoreAdapter.reset(sessionId);
  })();

/**
 * Consume one normalized Pi event and apply its pure projection to the
 * existing store shape. This is an opt-in action: the default ACP bridge does
 * not call it, so migration can be tested against a real Pi worker without
 * changing the user's current engine.
 */
export const receiveAgentEvent = (
  store: AgentStoreAccess,
  event: AgentEventEnvelope,
): void => {
  if (isPiActivityEvent(event)) {
    markPromptActivity(event.sessionId);
  }
  const before = store.get();
  const { result, patch } = piEventStoreAdapter.consume(
    event,
    snapshotFor(before),
  );
  if (!result.ignored && Object.keys(patch).length > 0) {
    store.set((state) => ({
      ...(patch.timeline !== undefined ? { timeline: patch.timeline } : {}),
      ...(patch.backgroundTimelines !== undefined
        ? { backgroundTimelines: patch.backgroundTimelines }
        : {}),
      ...(patch.acpCursor !== undefined ? { acpCursor: patch.acpCursor } : {}),
      ...(patch.backgroundCursors !== undefined
        ? { backgroundCursors: patch.backgroundCursors }
        : {}),
      ...(patch.contextUsage !== undefined
        ? { contextUsage: patch.contextUsage }
        : {}),
      ...(patch.backgroundContextUsage !== undefined
        ? { backgroundContextUsage: patch.backgroundContextUsage }
        : {}),
      ...(patch.subagents !== undefined ? { subagents: patch.subagents } : {}),
      ...(patch.availableModels !== undefined
        ? { availableModels: patch.availableModels }
        : {}),
      ...(patch.unavailableModels !== undefined
        ? { unavailableModels: patch.unavailableModels }
        : {}),
      ...(patch.modelRefreshErrors !== undefined
        ? { modelRefreshErrors: patch.modelRefreshErrors }
        : {}),
      ...(patch.capabilities !== undefined
        ? { capabilities: patch.capabilities }
        : {}),
      ...(patch.monitorNotifications !== undefined
        ? { monitorNotifications: patch.monitorNotifications }
        : {}),
      ...(patch.scheduleRevision !== undefined
        ? { scheduleRevision: patch.scheduleRevision }
        : {}),
      ...(patch.capabilityDiagnostics !== undefined
        ? { capabilityDiagnostics: patch.capabilityDiagnostics }
        : {}),
      ...(patch.configRevision !== undefined
        ? { configRevision: patch.configRevision }
        : {}),
      ...("selectedModelId" in patch
        ? { selectedModelId: patch.selectedModelId, pendingModelId: undefined }
        : {}),
      ...("selectedReasoningEffort" in patch
        ? {
            selectedReasoningEffort: patch.selectedReasoningEffort,
            pendingReasoningEffort: undefined,
          }
        : {}),
      ...(patch.selectedSessionModeId !== undefined
        ? {
            selectedSessionModeId: patch.selectedSessionModeId,
            pendingSessionModeId: undefined,
          }
        : {}),
      ...(patch.permissionMode !== undefined
        ? { permissionMode: patch.permissionMode }
        : {}),
      ...failedConfigurationPatch(event),
      ...(patch.chatStatus !== undefined
        ? { chatStatus: patch.chatStatus }
        : {}),
      ...(patch.acpPhase !== undefined ? { acpPhase: patch.acpPhase } : {}),
      ...(patch.statusMessage !== undefined
        ? { status: { ...state.status, message: patch.statusMessage } }
        : {}),
      ...(patch.chatStatus === "ready" || patch.chatStatus === "error"
        ? state.localSessionId
          ? {
              runningSessions: {
                ...state.runningSessions,
                [state.localSessionId]: false,
              },
            }
          : {}
        : {}),
    }));

    const pending = promptForPiEvent(event);
    if (pending) {
      const [requestId, pendingPrompt] = pending;
      removePendingPrompt(requestId);
      const failed =
        event.event.type === "runtime.error" ||
        (event.event.type === "run.finished" &&
          event.event.status === "failed");
      store.set((state) => ({
        runningSessions: {
          ...state.runningSessions,
          [pendingPrompt.localSessionId]: false,
        },
        ...(state.localSessionId === pendingPrompt.localSessionId
          ? {
              chatStatus: failed ? ("error" as const) : ("ready" as const),
              acpPhase: failed ? ("error" as const) : ("ready" as const),
            }
          : {}),
      }));
    }
  }
};
