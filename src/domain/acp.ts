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
      streaming?: boolean;
    }
  | {
      id: string;
      kind: "tool";
      toolCallId?: string;
      title: string;
      command: string;
      output: string;
      status?: string;
      permission?: "pending" | "allowed" | "denied";
      permissionRequestId?: JsonRpcId;
      permissionOptions?: PermissionOption[];
    };
