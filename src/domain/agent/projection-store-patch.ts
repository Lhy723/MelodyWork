import type {
  AgentContextUsage,
  AgentPermissionMode,
  AgentModelOption,
  AgentSubagent,
  TimelineEntry,
} from "../acp.ts";
import type {
  AgentCapabilityDiagnostic,
  AgentModelDescriptor,
  AgentProtocolCapabilities,
} from "./contract.ts";
import type {
  AgentEventProjectionResult,
  AgentMonitorNotification,
} from "./event-to-session-update.ts";
import { selectPiModelId } from "./pi-model-options.ts";

export type AgentProjectionChatStatus =
  "ready" | "submitted" | "streaming" | "error";

export type AgentProjectionPhase =
  | "idle"
  | "initializing"
  | "authenticating"
  | "creating"
  | "ready"
  | "prompting"
  | "error";

/**
 * The small renderer-facing shape consumed by the optional Pi adapter.
 *
 * This intentionally mirrors only the agent-owned portion of Zustand. It
 * keeps the domain projector independent from React/Zustand while making the
 * eventual store integration a mechanical, testable operation.
 */
export interface AgentProjectionStoreSnapshot {
  currentSessionId?: string;
  timeline: TimelineEntry[];
  backgroundTimelines: Record<string, TimelineEntry[]>;
  backgroundCursors: Record<string, string>;
  contextUsage?: AgentContextUsage;
  backgroundContextUsage: Record<string, AgentContextUsage>;
  subagents: Record<string, AgentSubagent>;
  availableModels: AgentModelOption[];
  unavailableModels?: AgentModelDescriptor[];
  modelRefreshErrors?: Record<string, string>;
  configRevision?: number;
  selectedModelId?: string;
  selectedReasoningEffort?: string;
  capabilities?: AgentProtocolCapabilities;
  capabilityDiagnostics?: AgentCapabilityDiagnostic[];
}

export interface AgentProjectionStorePatch {
  timeline?: TimelineEntry[];
  backgroundTimelines?: Record<string, TimelineEntry[]>;
  eventCursor?: string;
  backgroundCursors?: Record<string, string>;
  contextUsage?: AgentContextUsage;
  backgroundContextUsage?: Record<string, AgentContextUsage>;
  subagents?: Record<string, AgentSubagent>;
  availableModels?: AgentModelOption[];
  unavailableModels?: AgentModelDescriptor[];
  modelRefreshErrors?: Record<string, string>;
  configRevision?: number;
  selectedModelId?: string;
  selectedReasoningEffort?: string;
  selectedSessionModeId?: string;
  permissionMode?: AgentPermissionMode;
  capabilities?: AgentProtocolCapabilities;
  capabilityDiagnostics?: AgentCapabilityDiagnostic[];
  /** Bounded Host-owned monitor feed; never part of the chat timeline. */
  monitorNotifications?: AgentMonitorNotification[];
  /** Bumped when a Host-owned schedule changed, so the UI re-reads it. */
  scheduleRevision?: number;
  chatStatus?: AgentProjectionChatStatus;
  runtimePhase?: AgentProjectionPhase;
  statusMessage?: string;
}

const sessionIsCurrent = (
  eventSessionId: string | undefined,
  currentSessionId: string | undefined,
): boolean =>
  eventSessionId === undefined ||
  (currentSessionId !== undefined && eventSessionId === currentSessionId);

const mergeSubagents = (
  current: Record<string, AgentSubagent>,
  result: AgentEventProjectionResult,
): Record<string, AgentSubagent> | undefined => {
  if (!result.subagentProjection?.handled) {
    return undefined;
  }
  const next = { ...current };
  for (const [subagentId, subagent] of result.state.subagents) {
    next[subagentId] = subagent;
  }
  return next;
};

const statusPatchFor = (
  result: AgentEventProjectionResult,
): Pick<
  AgentProjectionStorePatch,
  "chatStatus" | "runtimePhase" | "statusMessage"
> => {
  const eventType = result.event.event.type;
  if (result.projection.error) {
    return {
      chatStatus: "error",
      runtimePhase: "error",
      statusMessage: result.projection.error,
    };
  }
  if (result.projection.completed || result.lifecycle === "run-finished") {
    return { chatStatus: "ready", runtimePhase: "ready" };
  }
  if (result.projection.streaming || result.lifecycle === "run-started") {
    return { chatStatus: "streaming", runtimePhase: "prompting" };
  }
  if (result.lifecycle === "run-accepted") {
    return { chatStatus: "submitted", runtimePhase: "prompting" };
  }
  if (eventType === "tool.requested" || eventType === "interaction.requested") {
    return { chatStatus: "streaming", runtimePhase: "prompting" };
  }
  if (
    eventType === "runtime.ready" ||
    eventType === "session.opened" ||
    eventType === "session.imported" ||
    eventType === "session.configured"
  ) {
    return { chatStatus: "ready", runtimePhase: "ready" };
  }
  if (eventType === "session.closed") {
    return { chatStatus: "ready", runtimePhase: "idle" };
  }
  if (result.projection.statusMessage) {
    return { statusMessage: result.projection.statusMessage };
  }
  return {};
};

const modelCatalogPatch = (
  snapshot: AgentProjectionStoreSnapshot,
  result: AgentEventProjectionResult,
): Pick<
  AgentProjectionStorePatch,
  | "availableModels"
  | "unavailableModels"
  | "modelRefreshErrors"
  | "selectedModelId"
  | "selectedReasoningEffort"
> => {
  const catalog = result.modelCatalogProjection;
  if (!catalog) return {};
  const selectedModelId = selectPiModelId(
    catalog.availableModels,
    snapshot.selectedModelId,
  );
  const selectedModel = catalog.availableModels.find(
    (model) => model.id === selectedModelId,
  );
  const modelChanged = selectedModelId !== snapshot.selectedModelId;
  return {
    availableModels: catalog.availableModels,
    unavailableModels: catalog.unavailableModels,
    modelRefreshErrors: catalog.refreshErrors ?? {},
    selectedModelId,
    ...(modelChanged
      ? { selectedReasoningEffort: selectedModel?.reasoningEffort }
      : {}),
  };
};

const sessionConfigurationPatch = (
  result: AgentEventProjectionResult,
  snapshot: AgentProjectionStoreSnapshot,
): Pick<
  AgentProjectionStorePatch,
  | "configRevision"
  | "selectedModelId"
  | "selectedReasoningEffort"
  | "selectedSessionModeId"
  | "permissionMode"
> => {
  const event = result.event.event;
  if (
    event.type !== "session.opened" &&
    event.type !== "session.imported" &&
    event.type !== "session.configured"
  ) {
    return {};
  }
  const patch: Pick<
    AgentProjectionStorePatch,
    | "configRevision"
    | "selectedModelId"
    | "selectedReasoningEffort"
    | "selectedSessionModeId"
    | "permissionMode"
  > = {};
  const revision = event.revision;
  if (
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 0
  ) {
    patch.configRevision = revision;
  }
  // Open/import acknowledgements carry the restored model settings just like
  // configure acknowledgements. Applying the fields for every lifecycle event
  // lets a fresh renderer converge on the Host binding after a worker restart.
  if (event.modelId !== undefined) {
    patch.selectedModelId = event.modelId;
    const selectedModel = snapshot.availableModels.find(
      (model) => model.id === event.modelId,
    );
    patch.selectedReasoningEffort =
      event.reasoningEffort ?? selectedModel?.reasoningEffort;
  } else if (event.reasoningEffort !== undefined) {
    patch.selectedReasoningEffort = event.reasoningEffort;
  }
  if (event.sessionModeId !== undefined) {
    patch.selectedSessionModeId = event.sessionModeId;
  }
  if (event.permissionMode !== undefined) {
    patch.permissionMode = event.permissionMode;
  }
  return patch;
};

/**
 * Translate one already-validated normalized event projection into a minimal
 * patch for the existing agent store. The caller supplies the current
 * session identity so background events stay isolated from the visible
 * timeline. Ignored events never mutate UI state.
 */
export const projectAgentEventToStorePatch = (
  snapshot: AgentProjectionStoreSnapshot,
  result: AgentEventProjectionResult,
): AgentProjectionStorePatch => {
  if (result.ignored) return {};

  const eventSessionId = result.event.streamSessionId ?? result.event.sessionId;
  const current = sessionIsCurrent(eventSessionId, snapshot.currentSessionId);
  const globalRuntimeEvent =
    eventSessionId === undefined &&
    (result.event.event.type === "runtime.ready" ||
      result.event.event.type === "runtime.models");
  const patch: AgentProjectionStorePatch = {
    ...modelCatalogPatch(snapshot, result),
  };

  if (result.event.event.type === "runtime.ready") {
    patch.capabilities = result.event.event.capabilities;
    patch.capabilityDiagnostics =
      result.event.event.capabilities.diagnostics ?? [];
  }

  // The monitor feed belongs to the session that produced it, whether or not
  // that session is on screen: switching away must not lose streamed lines.
  if (result.state.notifications.length > 0) {
    patch.monitorNotifications = result.state.notifications;
  }
  if (result.state.scheduleRevision > 0) {
    patch.scheduleRevision = result.state.scheduleRevision;
  }

  if (current && !globalRuntimeEvent) {
    patch.timeline = result.projection.timeline;
    patch.eventCursor = result.event.eventId;
    Object.assign(patch, statusPatchFor(result));
    Object.assign(patch, sessionConfigurationPatch(result, snapshot));
    if (result.projection.contextUsage) {
      patch.contextUsage = result.projection.contextUsage;
    }
  } else if (eventSessionId) {
    patch.backgroundTimelines = {
      ...snapshot.backgroundTimelines,
      [eventSessionId]: result.projection.timeline,
    };
    patch.backgroundCursors = {
      ...snapshot.backgroundCursors,
      [eventSessionId]: result.event.eventId,
    };
    if (result.projection.contextUsage) {
      patch.backgroundContextUsage = {
        ...snapshot.backgroundContextUsage,
        [eventSessionId]: result.projection.contextUsage,
      };
    }
  }

  const subagents = mergeSubagents(snapshot.subagents, result);
  if (subagents) patch.subagents = subagents;
  return patch;
};
