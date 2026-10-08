import type {
  AgentCommandEnvelope,
  AgentError,
  AgentEvent,
  AgentEventEnvelope,
} from "@melody/agent-contract";

export interface WorkerEventContext {
  sessionId?: string;
  streamSessionId?: string;
  runId?: string;
  requestId?: string | number;
}

export type WorkerEmitter = (
  context: WorkerEventContext & { event: AgentEvent; replay?: boolean },
) => Promise<void> | void;

export interface WorkerCommandHandler {
  handle(command: AgentCommandEnvelope): Promise<void>;
}

export interface WorkerFrameError {
  error: AgentError;
  requestId?: string | number;
}

export type WorkerEvent = AgentEventEnvelope;
