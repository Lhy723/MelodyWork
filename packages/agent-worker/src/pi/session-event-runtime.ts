import type { AgentError } from "@melody/agent-contract";
import { mapPiEvent, textFromContent } from "./event-mapper.ts";
import { PI_GATEWAY_TOOL_NAMES } from "./tool-gateway.ts";
import { asError, providerRunError } from "./session-errors.ts";
import type { PiSessionContext } from "./session-runtime-types.ts";
import type { PiSubagentRuntime } from "./subagent-runtime.ts";
import type { WorkerEmitter } from "../protocol.ts";

export const runFinishedEvent = (
  promptId: string | undefined,
  error: AgentError | undefined,
  successStopReason: "pi_idle" | "pi_settled",
) => ({
  type: "run.finished" as const,
  ...(promptId ? { promptId } : {}),
  ...(error
    ? {
        status: "failed" as const,
        stopReason:
          error.code === "pi.provider_rate_limited" ? "rate_limit" : "error",
        error,
      }
    : { status: "completed" as const, stopReason: successStopReason }),
});

type ResolvedSessionContext = { handle: PiSessionContext };

interface PiSessionEventRuntimeDependencies {
  contextForSession: (sessionId: string) => ResolvedSessionContext | undefined;
  observePiEvent: PiSubagentRuntime["observePiEvent"];
  emit: WorkerEmitter;
}

/** Serializes Pi event projection and owns its run/context lifecycle effects. */
export class PiSessionEventRuntime {
  private readonly dependencies: PiSessionEventRuntimeDependencies;

  public constructor(dependencies: PiSessionEventRuntimeDependencies) {
    this.dependencies = dependencies;
  }

  public enqueue(
    sessionId: string,
    handle: PiSessionContext,
    event: unknown,
  ): void {
    handle.eventTail = handle.eventTail
      .then(() => this.projectEvent(sessionId, event))
      .catch((error) => this.recoverEventFailure(sessionId, handle, error));
  }

  public handle(sessionId: string, event: unknown): Promise<void> {
    return this.projectEvent(sessionId, event);
  }

  private async projectEvent(sessionId: string, event: unknown): Promise<void> {
    const context = this.dependencies.contextForSession(sessionId);
    if (!context) return;
    const handle = context.handle;
    const eventContext = {
      sessionId: handle.rootSessionId,
      ...(handle.streamSessionId !== handle.rootSessionId
        ? { streamSessionId: handle.streamSessionId }
        : {}),
      ...(handle.runId ? { runId: handle.runId } : {}),
    };
    const rawEvent =
      event !== null && typeof event === "object" && !Array.isArray(event)
        ? (event as Record<string, unknown>)
        : undefined;
    const type = rawEvent?.type;
    if (type === "message_end") {
      const rawMessage = rawEvent?.message;
      if (
        rawMessage !== null &&
        typeof rawMessage === "object" &&
        !Array.isArray(rawMessage)
      ) {
        const message = rawMessage as Record<string, unknown>;
        if (message.role === "assistant") {
          handle.runError =
            message.stopReason === "error"
              ? providerRunError(message)
              : undefined;
        }
      }
    }
    const mapped = mapPiEvent(event, {
      sessionId,
      runId: handle.runId,
      promptId: handle.promptId,
      offsets: handle.offsets,
      activeMessageIds: handle.activeMessageIds,
      gatewayToolNames: new Set(PI_GATEWAY_TOOL_NAMES),
      nextMessageId: () => String(++handle.nextMessage),
    });
    for (const item of mapped) {
      let mappedEvent = item.event;
      if (
        mappedEvent.type === "message.completed" &&
        mappedEvent.role === "assistant" &&
        mappedEvent.content?.trim()
      ) {
        const leaf = handle.session.sessionManager.getLeafEntry();
        const leafMessage =
          leaf?.type === "message" && leaf.message.role === "assistant"
            ? leaf.message
            : undefined;
        const leafContent = leafMessage
          ? textFromContent(leafMessage.content)
          : undefined;
        const hasToolCall =
          Array.isArray(leafMessage?.content) &&
          leafMessage.content.some(
            (part) =>
              part !== null &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "toolCall",
          );
        // Renderer ids are projection ids, not Pi tree ids. Publish an anchor
        // only when the current native leaf is the same plain assistant answer;
        // tool-call messages are not safe Explorer fork points.
        if (
          leaf?.type === "message" &&
          leafMessage &&
          !hasToolCall &&
          leafContent === mappedEvent.content
        ) {
          mappedEvent = { ...mappedEvent, nativeEntryId: leaf.id };
        }
      }
      this.dependencies.observePiEvent(sessionId, { mappedEvent });
      await this.dependencies.emit({
        ...eventContext,
        event: mappedEvent,
      });
    }
    if (type === "agent_settled" && handle.runId && !handle.runFinished) {
      handle.runFinished = true;
      this.dependencies.observePiEvent(sessionId, {
        settled: true,
        runError: handle.runError,
      });
      await this.dependencies.emit({
        ...eventContext,
        event: runFinishedEvent(handle.promptId, handle.runError, "pi_settled"),
      });
    }
    if (type === "turn_end") {
      const contextUsage = handle.session.getContextUsage();
      await this.dependencies.emit({
        ...eventContext,
        event: {
          type: "context.updated",
          tokens: contextUsage?.tokens ?? null,
          limit: contextUsage?.contextWindow ?? null,
          confidence:
            contextUsage?.tokens === undefined || contextUsage?.tokens === null
              ? "unknown"
              : "measured",
        },
      });
    }
  }

  private async recoverEventFailure(
    sessionId: string,
    handle: PiSessionContext,
    error: unknown,
  ): Promise<void> {
    const runId = handle.runId;
    const shouldFinish = Boolean(runId && !handle.runFinished);
    if (shouldFinish) handle.runFinished = true;
    await this.dependencies.emit({
      sessionId,
      event: { type: "runtime.error", error: asError(error) },
    });
    if (shouldFinish && runId) {
      await this.dependencies.emit({
        sessionId,
        runId,
        event: {
          type: "run.finished",
          ...(handle.promptId ? { promptId: handle.promptId } : {}),
          status: "failed",
          stopReason: "pi_event_error",
          error: asError(error, "run"),
        },
      });
    }
  }
}
