import type {
  AcpEnvelope,
  AcpSessionPhase,
  AgentContextUsage,
  AgentModelOption,
  AgentPermissionMode,
  AgentPlanDecision,
  AgentPromptAttachment,
  AgentQuestionResponse,
  AgentSessionModeOption,
  AgentStatus,
  AgentSubagent,
  TimelineEntry,
} from "@/domain/acp";
import type {
  AgentCapabilityDiagnostic,
  AgentEventEnvelope,
  AgentModelDescriptor,
  AgentProtocolCapabilities,
} from "@/domain/agent/contract";
import type { AgentMonitorNotification } from "@/domain/agent/event-to-session-update";

export interface AgentStore {
  activeSessionId: string;
  localSessionId?: string;
  cwd: string;
  status: AgentStatus;
  acpPhase: AcpSessionPhase;
  acpSessionId?: string;
  acpCursor?: string;
  timeline: TimelineEntry[];
  backgroundTimelines: Record<string, TimelineEntry[]>;
  backgroundCursors: Record<string, string>;
  contextUsage?: AgentContextUsage;
  backgroundContextUsage: Record<string, AgentContextUsage>;
  subagents: Record<string, AgentSubagent>;
  stderr: string[];
  availableModels: AgentModelOption[];
  /** Pi model entries that are known but currently unavailable. */
  unavailableModels: AgentModelDescriptor[];
  /** Provider/auth errors from the latest Pi model catalog refresh. */
  modelRefreshErrors: Record<string, string>;
  /** Latest engine capability negotiation snapshot. */
  capabilities?: AgentProtocolCapabilities;
  /** Structured gaps reported by the active engine/compatibility preflight. */
  capabilityDiagnostics: AgentCapabilityDiagnostic[];
  /**
   * Bounded Host-owned monitor feed. Monitors stream each output line as an
   * event instead of a chat message, so the lines live here rather than in the
   * timeline.
   */
  monitorNotifications: AgentMonitorNotification[];
  /** Renderer-visible revision of the Host-owned schedule inventory. */
  scheduleRevision: number;
  /** Monotonic revision acknowledged by the active session. */
  configRevision: number;
  selectedModelId?: string;
  pendingModelId?: string;
  selectedReasoningEffort?: string;
  pendingReasoningEffort?: string;
  availableSessionModes: AgentSessionModeOption[];
  selectedSessionModeId?: string;
  pendingSessionModeId?: string;
  permissionMode: AgentPermissionMode;
  runningSessions: Record<string, boolean>;
  chatStatus: "ready" | "submitted" | "streaming" | "error";
  /**
   * True only while a legacy-engine session is displayed as a read-only
   * archive: history stays visible, but no engine process is started and the
   * composer must stay gated. Reset by every other session-open path.
   */
  archivedReadOnly: boolean;
  setStatus: (status: AgentStatus) => void;
  /** Clears the session-scoped projection when no workspace session is active. */
  resetSessionView: () => void;
  appendStderr: (line: string) => void;
  beginSession: (
    cwd: string,
    localSessionId: string,
    acpSessionId?: string,
    timelineJson?: string,
    acpCursor?: string,
    timelineVersion?: number,
    archivedTimelineJson?: string,
    forceInitialize?: boolean,
  ) => Promise<void>;
  /**
   * Opens a legacy-engine session as a read-only archive: seeds the timeline
   * from persisted history and performs no engine traffic at all.
   */
  beginArchivedSession: (
    cwd: string,
    localSessionId: string,
    timelineJson?: string,
    archivedTimelineJson?: string,
    timelineVersion?: number,
  ) => Promise<void>;
  receiveAcp: (message: AcpEnvelope) => Promise<void>;
  /** Opt-in normalized Pi event sink; ACP remains the default bridge. */
  receiveAgentEvent: (event: AgentEventEnvelope) => void;
  submitPrompt: (
    content: string,
    attachments?: AgentPromptAttachment[],
  ) => Promise<void>;
  cancelPrompt: (reason?: "user" | "timeout") => Promise<void>;
  selectModel: (modelId: string) => Promise<void>;
  selectReasoningEffort: (effort: string) => Promise<void>;
  selectSessionMode: (modeId: string) => Promise<void>;
  selectPermissionMode: (mode: AgentPermissionMode) => Promise<void>;
  resolvePermission: (entryId: string, optionId: string) => Promise<void>;
  resolveQuestion: (
    entryId: string,
    response: AgentQuestionResponse,
  ) => Promise<void>;
  resolvePlan: (
    entryId: string,
    outcome: AgentPlanDecision,
    feedback?: string,
  ) => Promise<void>;
}

export interface AgentStoreAccess {
  get: () => AgentStore;
  set: (
    partial: Partial<AgentStore> | ((state: AgentStore) => Partial<AgentStore>),
  ) => void;
}
