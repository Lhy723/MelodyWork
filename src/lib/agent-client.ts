import type { UnlistenFn } from "@tauri-apps/api/event";

import type { AcpEnvelope, AgentPromptAttachment } from "@/domain/acp";
import type {
  AgentCommandEnvelope,
  AgentEventEnvelope,
  AgentRunConfig,
  JsonObject,
} from "@/domain/agent/contract";
import type { AgentEventCheckpointOptions } from "@/domain/agent/event-checkpoint";
import { AgentEventStream } from "@/domain/agent/event-stream";
import {
  AgentEventProjector,
  type AgentEventProjectionListener,
} from "@/domain/agent/event-projector";
import type { AgentEventProjectionState } from "@/domain/agent/event-to-session-update";
import type {
  AgentEventLogReplayOptions,
  AgentEventLogReplayResult,
} from "@/domain/agent/event-log";
import {
  coordinatePiRecovery,
  type ResumePiSessionOptions,
  type ResumePiSessionResult,
} from "@/domain/agent/recovery-coordinator";
import { validateAgentCommandEnvelope } from "@/domain/agent/command-validation";
import { adaptLegacyAcpMessage } from "@/domain/agent/legacy-acp-adapter";
import { toLegacyAcpRequest } from "@/domain/agent/legacy-command-adapter";
import type { AgentStatus } from "@/domain/acp";
import {
  inspectPiSessionRecovery,
  isTauriRuntime,
  sendAcp,
  sendPiAgentCommand,
  readPiAgentEventLog,
  subscribeToAcp,
  subscribeToPiAgentEvents,
} from "@/lib/melody-bridge";

export type AgentEventListener = (event: AgentEventEnvelope) => void;

export interface AgentEventSubscriptionOptions extends AgentEventCheckpointOptions {
  /** Keep the adapter's source counter stable for one subscription. */
  sourceOrdinal?: number;
}

/**
 * Adapt the browser-preview ACP fixture into the renderer-facing event stream.
 * Desktop Agent sessions subscribe through Pi; this is not an ACP fallback.
 */
export const subscribeToAgentEvents = async (
  onEvent: AgentEventListener,
  onStderr: (line: string) => void,
  onStatus?: (status: AgentStatus) => void,
  options: AgentEventSubscriptionOptions = {},
): Promise<UnlistenFn[]> => {
  const stream = new AgentEventStream(onEvent, {
    allowMissingWorkerEpoch: true,
    ...(options.maxEventIds !== undefined
      ? { maxEventIds: options.maxEventIds }
      : {}),
  });
  let sourceOrdinal = options.sourceOrdinal ?? 0;

  const consume = (message: AcpEnvelope) => {
    for (const event of adaptLegacyAcpMessage(message, sourceOrdinal++)) {
      stream.consume(event);
    }
  };

  return subscribeToAcp(consume, onStderr, onStatus);
};

/**
 * Pi's stdout already carries the normalized protocol. Keep the same
 * checkpoint/replay filtering used by the preview adapter so consumers retain
 * one renderer-facing event contract.
 */
const subscribeToPiEvents = async (
  onEvent: AgentEventListener,
  onStderr: (line: string) => void,
  onStatus?: (status: AgentStatus) => void,
): Promise<UnlistenFn[]> => {
  const stream = createPiAgentEventStream(onEvent, onStderr, onStatus);
  return stream.subscribe;
};

export interface PiAgentEventStreamHandle {
  stream: AgentEventStream;
  subscribe: Promise<UnlistenFn[]>;
}

/**
 * Create a Pi subscription whose replay method shares the same checkpoint
 * and live/replay barrier. The plain `AgentClient.subscribe` method remains a
 * small compatibility façade; reconnect code should use this handle so a
 * live event cannot overtake its persisted history.
 */
export const createPiAgentEventStream = (
  onEvent: AgentEventListener,
  onStderr: (line: string) => void,
  onStatus?: (status: AgentStatus) => void,
): PiAgentEventStreamHandle => {
  const stream = new AgentEventStream(onEvent, {
    allowMissingWorkerEpoch: false,
  });
  return {
    stream,
    subscribe: subscribeToPiAgentEvents(
      (event) => stream.consume(event),
      onStderr,
      onStatus,
    ),
  };
};

export interface PiAgentProjectionStreamOptions {
  /** Reject events for a different product session before they reach the UI. */
  expectedSessionId?: string;
  /** Continue a projection from a previously persisted timeline snapshot. */
  initialState?: AgentEventProjectionState;
  /** Bound the exact-ID checkpoint window retained by the stream. */
  maxEventIds?: number;
}

export interface PiAgentProjectionStreamHandle {
  stream: AgentEventStream;
  projector: AgentEventProjector;
  subscribe: Promise<UnlistenFn[]>;
}

/**
 * Create a Pi stream that projects normalized events into the existing
 * timeline update model. Replay and live events share one stream barrier and
 * one projector, so callers do not need a second renderer path.
 */
export const createPiAgentProjectionStream = (
  onProjection: AgentEventProjectionListener,
  onStderr: (line: string) => void,
  onStatus?: (status: AgentStatus) => void,
  options: PiAgentProjectionStreamOptions = {},
): PiAgentProjectionStreamHandle => {
  const projector = new AgentEventProjector(onProjection, {
    ...(options.expectedSessionId
      ? { expectedSessionId: options.expectedSessionId }
      : {}),
    ...(options.initialState ? { initialState: options.initialState } : {}),
  });
  const stream = new AgentEventStream(
    (event) => {
      projector.consume(event);
    },
    {
      allowMissingWorkerEpoch: false,
      ...(options.maxEventIds !== undefined
        ? { maxEventIds: options.maxEventIds }
        : {}),
    },
  );

  return {
    stream,
    projector,
    subscribe: subscribeToPiAgentEvents(
      (event) => stream.consume(event),
      onStderr,
      onStatus,
    ),
  };
};

export interface AgentClient {
  send(command: AgentCommandEnvelope): Promise<void>;
  subscribe(
    onEvent: AgentEventListener,
    onStderr: (line: string) => void,
    onStatus?: (status: AgentStatus) => void,
  ): Promise<UnlistenFn[]>;
}

/**
 * Compatibility client for the deterministic browser-preview ACP fixture.
 * Desktop bridge calls fail closed; archive/import flows use separate adapters.
 */
export const browserPreviewAgentClient: AgentClient = {
  send: async (command) => sendAcp(toLegacyAcpRequest(command)),
  subscribe: subscribeToAgentEvents,
};

/**
 * Pi is the only Desktop Agent runtime. The worker provides the product
 * ToolGateway, interactions, persistence, restore checks, nested tasks, and
 * model/auth boundaries; unsupported capabilities are blocked or surfaced as
 * degradations, never routed to ACP.
 */
export const piAgentClient: AgentClient = {
  send: sendPiAgentCommand,
  subscribe: subscribeToPiEvents,
};

/**
 * Desktop is always backed by Pi; non-Tauri rendering uses a deterministic
 * browser-preview fixture. Persisted preferences cannot change this route.
 */
export const agentClientForRuntime = (): AgentClient =>
  isTauriRuntime() ? piAgentClient : browserPreviewAgentClient;

export const sendAgentCommand = async (
  command: AgentCommandEnvelope,
): Promise<void> => {
  validateAgentCommandEnvelope(command);
  await agentClientForRuntime().send(command);
};

interface AgentTurnInput {
  requestId: string | number;
  sessionId: string;
  promptId: string;
  content: string;
  attachments?: AgentPromptAttachment[];
  streamingBehavior?: "steer" | "followUp";
  config: AgentRunConfig;
}

const parseDataUrl = (url: string) => {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) {
    throw new Error("附件必须是 data URL。 ");
  }
  return {
    mediaType: match[1],
    data: match[3],
    base64: Boolean(match[2]),
  };
};

const attachmentBlocks = (attachments: AgentPromptAttachment[]): JsonObject[] =>
  attachments.map((attachment) => {
    const parsed = parseDataUrl(attachment.url);
    const mediaType = attachment.mediaType || parsed.mediaType;
    if (mediaType.startsWith("image/")) {
      if (!parsed.base64) {
        throw new Error(`无法编码图片 ${attachment.filename ?? "附件"}。`);
      }
      return {
        type: "image",
        data: parsed.data,
        mimeType: mediaType,
      };
    }
    const text = parsed.base64
      ? new TextDecoder().decode(
          Uint8Array.from(atob(parsed.data), (character) =>
            character.charCodeAt(0),
          ),
        )
      : decodeURIComponent(parsed.data);
    return {
      type: "text",
      text: [
        `<attachment filename="${attachment.filename ?? "attachment"}" media-type="${mediaType || "text/plain"}">`,
        text,
        "</attachment>",
      ].join("\n"),
    };
  });

/**
 * Product-level turn entry point. Store call sites remain independent of the
 * normalized command transport: Desktop uses Pi and browser preview uses its
 * local ACP fixture.
 */
export const sendAgentTurn = async ({
  requestId,
  sessionId,
  promptId,
  content,
  attachments = [],
  streamingBehavior,
  config,
}: AgentTurnInput): Promise<void> => {
  // Validate and normalize attachments before the request is accepted. This
  // retains the old UI behavior where a malformed attachment never creates a
  // pending prompt that cannot be completed.
  attachmentBlocks(attachments);
  await sendAgentCommand({
    protocolVersion: 1,
    requestId,
    sessionId,
    // promptId is allocated once per product turn. Reusing it as the
    // execution key lets the Pi worker ignore a retried frame instead of
    // starting a second model turn; the legacy adapter ignores this
    // product-level metadata.
    idempotencyKey: `${sessionId}:${promptId}`,
    command: {
      type: "turn.submit",
      sessionId,
      promptId,
      content,
      attachments: attachments.map((attachment) => ({
        url: attachment.url,
        mediaType: attachment.mediaType,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      })),
      ...(streamingBehavior ? { streamingBehavior } : {}),
      config,
    },
  });
};

/**
 * Replay a bounded, Host-committed Pi event-log slice. Pass the stream from
 * `createPiAgentEventStream` when a live subscription is already installed so
 * the replay/live barrier and checkpoint are shared; omitting it is useful for
 * an isolated diagnostic read only.
 */
export const replayPiAgentEvents = (
  sessionId: string,
  onEvent: AgentEventListener,
  options: AgentEventLogReplayOptions = {},
  stream?: AgentEventStream,
): Promise<AgentEventLogReplayResult> =>
  (
    stream ?? new AgentEventStream(onEvent, { allowMissingWorkerEpoch: false })
  ).replay(
    sessionId,
    async (id, afterOrdinal, limit) =>
      readPiAgentEventLog(id, afterOrdinal, limit),
    options,
  );

export type {
  ResumePiSessionOptions,
  ResumePiSessionResult,
} from "@/domain/agent/recovery-coordinator";
export type { PiSessionResumeAction } from "@/domain/agent/recovery-coordinator";

/**
 * Coordinate the safe portion of Pi session recovery.
 *
 * This is intentionally conservative: a terminal event log may be replayed
 * into an existing projector, while active work or an incomplete scan is
 * returned to the caller for reconciliation. No tool, prompt, or interaction
 * is re-issued by this helper. Callers should install a Pi subscription first
 * and pass its stream so live events cannot overtake the replay.
 */
export const resumePiSession = async (
  sessionId: string,
  onEvent: AgentEventListener,
  options: ResumePiSessionOptions = {},
): Promise<ResumePiSessionResult> => {
  return coordinatePiRecovery(sessionId, onEvent, options, {
    inspect: inspectPiSessionRecovery,
    replay: replayPiAgentEvents,
  });
};

/** Narrow helper for adapter tests and diagnostics without exposing ACP. */
export const toLegacyCommand = (command: AgentCommandEnvelope): AcpEnvelope =>
  toLegacyAcpRequest(command);
