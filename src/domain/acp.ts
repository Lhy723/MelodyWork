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

export interface AgentBillingUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  modelCalls: number;
  apiDurationMs: number;
  usageIsIncomplete: boolean;
  costIsPartial: boolean;
  costUsdTicks?: number;
}

export type AgentSubagentStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentSubagent {
  subagentId: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  description: string;
  status: AgentSubagentStatus;
  startedAt: number;
  updatedAt: number;
  durationMs?: number;
  turnCount?: number;
  toolCallCount?: number;
  tokensUsed?: number;
  contextWindowTokens?: number;
  contextUsagePct?: number;
  toolsUsed: string[];
  errorCount?: number;
  error?: string;
  output?: string;
  model?: string;
  persona?: string;
  role?: string;
  capabilityMode?: string;
  resumedFrom?: string;
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
  paths?: string[];
  query?: string;
  glob?: string;
  files?: AgentToolFileChange[];
}

export type JsonRpcId = number | string;

export type AgentQuestionMode = "default" | "plan";

export interface AgentQuestionOption {
  label: string;
  description: string;
  preview?: string;
  id?: string;
}

export interface AgentQuestion {
  question: string;
  options: AgentQuestionOption[];
  multiSelect?: boolean;
  id?: string;
}

export interface AgentQuestionAnnotation {
  preview?: string;
  notes?: string;
}

export type AgentQuestionOutcome =
  | "pending"
  | "accepted"
  | "chat_about_this"
  | "skip_interview"
  | "cancelled";

export interface AgentQuestionRequest {
  requestId: JsonRpcId;
  sessionId: string;
  toolCallId: string;
  questions: AgentQuestion[];
  mode: AgentQuestionMode;
  outcome: AgentQuestionOutcome;
  answers?: Record<string, string[]>;
  annotations?: Record<string, AgentQuestionAnnotation>;
  partialAnswers?: Record<string, string>;
}

export type AgentQuestionResponse =
  | {
      outcome: "accepted";
      answers: Record<string, string[]>;
      annotations?: Record<string, AgentQuestionAnnotation>;
    }
  | {
      outcome: "chat_about_this" | "skip_interview";
      partialAnswers: Record<string, string>;
    }
  | {
      outcome: "cancelled";
    };

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
      tokenUsage?: {
        usedTokens: number;
        maxTokens: number;
      };
      billingUsage?: AgentBillingUsage;
      reasoningEffort?: string;
      sessionModeId?: string;
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
      question?: AgentQuestionRequest;
    };
