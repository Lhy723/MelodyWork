import type {
  AgentCommandEnvelope,
  AgentError,
  AgentInteractionKind,
  AgentToolResolution,
  JsonObject,
} from "@melody/agent-contract";
import type { WorkerEmitter } from "../protocol.ts";
import { gatewayError } from "./tool-errors.ts";

export const TOOL_GATEWAY_TIMEOUT_MS = 30_000;
/** Match Melody's default ask-user timeout (30 minutes). */
export const INTERACTION_TIMEOUT_MS = 30 * 60_000;

interface PendingToolCall {
  sessionId: string;
  rootSessionId?: string;
  runId?: string;
  resolve: (resolution: AgentToolResolution) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingInteraction {
  sessionId: string;
  rootSessionId?: string;
  runId?: string;
  kind: AgentInteractionKind;
  resolve: (resolution: JsonObject) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Owns the pending request maps, their timeout/settlement rules, and the
 * worker events that bracket a request. The gateway delegates to this module
 * while retaining its stable public methods.
 */
export class PiToolRequestLifecycle {
  private readonly pending = new Map<string, PendingToolCall>();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly emit: WorkerEmitter;

  public constructor(emit: WorkerEmitter) {
    this.emit = emit;
  }

  public async request(input: {
    sessionId: string;
    rootSessionId?: string;
    runId?: string;
    cwd?: string;
    toolCallId: string;
    toolName: string;
    arguments: JsonObject;
    permissionMode?: "ask" | "auto" | "always-approve";
    approved?: boolean;
  }): Promise<AgentToolResolution> {
    if (this.pending.has(input.toolCallId)) {
      throw gatewayError(
        "pi.tool_call_duplicate",
        `Pi tool call 已在等待宿主响应：${input.toolCallId}。`,
      );
    }
    const response = new Promise<AgentToolResolution>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(input.toolCallId);
        reject(
          gatewayError(
            "pi.tool_gateway_timeout",
            `ToolGateway 在 ${TOOL_GATEWAY_TIMEOUT_MS / 1000} 秒内没有返回结果。`,
            true,
          ),
        );
      }, TOOL_GATEWAY_TIMEOUT_MS);
      this.pending.set(input.toolCallId, {
        sessionId: input.sessionId,
        ...(input.rootSessionId ? { rootSessionId: input.rootSessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        resolve,
        reject,
        timer,
      });
    });

    const eventContext = {
      sessionId: input.rootSessionId ?? input.sessionId,
      ...(input.rootSessionId && input.rootSessionId !== input.sessionId
        ? { streamSessionId: input.sessionId }
        : {}),
      runId: input.runId,
    };
    let requestEmitted = false;
    let resolutionReceived = false;
    try {
      await this.emit({
        ...eventContext,
        event: {
          type: "tool.requested",
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          status: "pending",
          activity: {
            gateway: "melody",
            arguments: input.arguments,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.permissionMode
              ? { permissionMode: input.permissionMode }
              : {}),
            ...(input.approved === undefined
              ? {}
              : { approved: input.approved }),
          },
        },
      });
      requestEmitted = true;
      const resolution = await response;
      resolutionReceived = true;
      await this.emit({
        ...eventContext,
        event: {
          type: "tool.finished",
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          status: resolution.status,
          ...(resolution.output !== undefined
            ? { output: resolution.output }
            : {}),
          ...(resolution.error ? { error: resolution.error } : {}),
        },
      });
      return resolution;
    } catch (error) {
      if (requestEmitted && !resolutionReceived) {
        const caught = error as Error & { agentError?: AgentError };
        const agentError =
          caught?.agentError ??
          ({
            code: "pi.tool_gateway_failed",
            message:
              caught instanceof Error
                ? caught.message
                : "Pi ToolGateway 请求失败。",
            retriable: false,
            scope: "tool",
          } satisfies AgentError);
        try {
          await this.emit({
            ...eventContext,
            event: {
              type: "tool.finished",
              toolCallId: input.toolCallId,
              toolName: input.toolName,
              status: "failed",
              error: agentError,
            },
          });
        } catch {
          // Preserve the original gateway failure if the worker event pipe is
          // already unavailable; run.finished will settle any remaining row.
        }
      }
      throw error;
    } finally {
      const pending = this.pending.get(input.toolCallId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(input.toolCallId);
      }
    }
  }

  public async requestInteraction(input: {
    sessionId: string;
    rootSessionId?: string;
    runId?: string;
    interactionId: string;
    kind: AgentInteractionKind;
    payload: JsonObject;
    timeoutMs?: number;
  }): Promise<JsonObject> {
    if (this.interactions.has(input.interactionId)) {
      throw gatewayError(
        "pi.interaction_duplicate",
        `Pi interaction 已在等待响应：${input.interactionId}。`,
        false,
        "interaction",
      );
    }
    const response = new Promise<JsonObject>((resolve, reject) => {
      const timer =
        input.timeoutMs === undefined
          ? setTimeout(() => {
              this.interactions.delete(input.interactionId);
              reject(
                gatewayError(
                  "pi.interaction_timeout",
                  "交互请求等待超时，已自动取消。",
                  true,
                  "interaction",
                ),
              );
            }, INTERACTION_TIMEOUT_MS)
          : input.timeoutMs > 0
            ? setTimeout(() => {
                this.interactions.delete(input.interactionId);
                reject(
                  gatewayError(
                    "pi.interaction_timeout",
                    "交互请求等待超时，已自动取消。",
                    true,
                    "interaction",
                  ),
                );
              }, input.timeoutMs)
            : undefined;
      this.interactions.set(input.interactionId, {
        sessionId: input.sessionId,
        ...(input.rootSessionId ? { rootSessionId: input.rootSessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        kind: input.kind,
        resolve,
        reject,
        timer,
      });
    });
    try {
      await this.emit({
        sessionId: input.rootSessionId ?? input.sessionId,
        ...(input.rootSessionId && input.rootSessionId !== input.sessionId
          ? { streamSessionId: input.sessionId }
          : {}),
        runId: input.runId,
        event: {
          type: "interaction.requested",
          interactionId: input.interactionId,
          kind: input.kind,
          payload: input.payload,
        },
      });
      return await response;
    } finally {
      const pending = this.interactions.get(input.interactionId);
      if (pending?.timer) {
        clearTimeout(pending.timer);
        this.interactions.delete(input.interactionId);
      } else if (pending) {
        this.interactions.delete(input.interactionId);
      }
    }
  }

  public resolve(
    command: Extract<AgentCommandEnvelope["command"], { type: "tool.resolve" }>,
  ): void {
    const pending = this.pending.get(command.toolCallId);
    if (!pending) {
      throw gatewayError(
        "pi.tool_call_not_found",
        `没有等待中的 Pi tool call：${command.toolCallId}。`,
      );
    }
    // A late response from an older run must never be allowed to resolve a
    // reused tool-call id in the current run. Older Hosts may omit runId, so
    // the check is strict only when the command carries that assertion.
    if (command.runId !== undefined && pending.runId !== command.runId) {
      throw gatewayError(
        "pi.tool_call_run_mismatch",
        `Tool call ${command.toolCallId} 不属于运行 ${command.runId}。`,
      );
    }
    if (
      pending.sessionId !== command.sessionId &&
      pending.rootSessionId !== command.sessionId
    ) {
      throw gatewayError(
        "pi.tool_call_session_mismatch",
        `Tool call ${command.toolCallId} 不属于当前会话。`,
      );
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(command.toolCallId);
    pending.resolve(command.resolution);
  }

  public resolveInteraction(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "interaction.resolve" }
    >,
  ): void {
    const pending = this.interactions.get(command.interactionId);
    if (!pending) {
      throw gatewayError(
        "pi.interaction_not_found",
        `没有等待中的 Pi interaction：${command.interactionId}。`,
        false,
        "interaction",
      );
    }
    if (
      pending.sessionId !== command.sessionId &&
      pending.rootSessionId !== command.sessionId
    ) {
      throw gatewayError(
        "pi.interaction_session_mismatch",
        `Interaction ${command.interactionId} 不属于当前会话。`,
        false,
        "interaction",
      );
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.interactions.delete(command.interactionId);
    pending.resolve(command.resolution);
    // A resolution has already been delivered to Pi at this point. Event
    // emission is best effort; an unavailable writer must not turn a valid
    // user response into an unhandled rejection in the stdin pump.
    void Promise.resolve(
      this.emit({
        sessionId: pending.rootSessionId ?? pending.sessionId,
        ...(pending.rootSessionId && pending.rootSessionId !== pending.sessionId
          ? { streamSessionId: pending.sessionId }
          : {}),
        ...(pending.runId ? { runId: pending.runId } : {}),
        event: {
          type: "interaction.resolved",
          interactionId: command.interactionId,
          kind: pending.kind,
          payload: { resolution: command.resolution },
        },
      }),
    ).catch(() => undefined);
  }

  public rejectAll(message = "Pi worker 已关闭，网关请求未完成。") {
    for (const [toolCallId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(gatewayError("pi.tool_gateway_closed", message, true));
      this.pending.delete(toolCallId);
    }
    for (const [interactionId, pending] of this.interactions) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        gatewayError("pi.interaction_closed", message, true, "interaction"),
      );
      this.interactions.delete(interactionId);
    }
  }
}
