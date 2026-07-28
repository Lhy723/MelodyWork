export type AgentPhase =
  | "stopped"
  | "starting"
  | "running"
  | "missing"
  | "failed";

export interface AgentStatus {
  phase: AgentPhase;
  binaryPath?: string;
  pid?: number;
  message?: string;
}

export interface AgentModelOption {
  id: string;
  name: string;
  contextWindowTokens?: number;
  reasoningEffort?: string;
  reasoningEfforts: AgentReasoningEffortOption[];
}

export interface AgentReasoningEffortOption {
  id: string;
  value: string;
  label: string;
  description?: string;
}

export interface AgentSessionModeOption {
  id: string;
  name: string;
  description?: string;
}

export type AgentPermissionMode = "ask" | "auto" | "always-approve";

export interface AgentPromptAttachment {
  filename?: string;
  mediaType: string;
  url: string;
}

export interface AgentTimelineAttachment extends AgentPromptAttachment {
  id: string;
  type: "file";
}

export interface AgentContextUsage {
  usedTokens: number;
  maxTokens: number;
  cost?: {
    amount: number;
    currency: string;
  };
}

export type AgentToolOperation =
  | "read"
  | "search"
  | "create"
  | "edit"
  | "delete"
  | "execute"
  | "other";

export type AgentPlanStatus =
  | "streaming"
  | "awaiting-approval"
  | "approved"
  | "changes-requested"
  | "abandoned"
  | "superseded";

export type AgentPlanDecision = "approved" | "cancelled" | "abandoned";

export interface AgentToolFileChange {
  path: string;
  operation: "create" | "edit" | "delete";
  oldText?: string;
  newText: string;
  additions: number;
  deletions: number;
  oldStartLine?: number;
  newStartLine?: number;
  hunks?: AgentToolDiffHunk[];
}

export interface AgentToolDiffHunk {
  oldText: string;
  newText: string;
  oldStartLine: number;
  newStartLine: number;
  contextBefore?: string;
  contextAfter?: string;
}

export interface AgentToolActivity {
  operation: AgentToolOperation;
  path?: string;
  query?: string;
  glob?: string;
  files?: AgentToolFileChange[];
}

export type JsonRpcId = number | string;

export interface AcpEnvelope {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
  raw?: string;
}

export type AcpSessionPhase =
  | "idle"
  | "initializing"
  | "authenticating"
  | "creating"
  | "ready"
  | "prompting"
  | "error";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      content: string;
      startedAt?: number;
      completedAt?: number;
      attachments?: AgentTimelineAttachment[];
      streaming?: boolean;
      sourcePromptIndex?: number;
    }
  | {
      id: string;
      kind: "thought";
      content: string;
      startedAt?: number;
      completedAt?: number;
      streaming?: boolean;
    }
  | {
      id: string;
      kind: "plan";
      toolCallId: string;
      content: string;
      status: AgentPlanStatus;
      requestId?: JsonRpcId;
    }
  | {
      id: string;
      kind: "tool";
      toolCallId?: string;
      title: string;
      command: string;
      output: string;
      startedAt?: number;
      completedAt?: number;
      activity?: AgentToolActivity;
      status?: string;
      permission?: "pending" | "allowed" | "denied";
      permissionRequestId?: JsonRpcId;
      permissionOptions?: PermissionOption[];
    };
