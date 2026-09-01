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
  receiveAcp: (message: AcpEnvelope) => Promise<void>;
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
