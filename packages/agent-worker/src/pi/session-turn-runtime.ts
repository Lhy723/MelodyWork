import type { AgentCommandEnvelope, AgentError } from "@melody/agent-contract";
import { fingerprintCommand } from "../idempotency.ts";
import type { WorkerEmitter } from "../protocol.ts";
import { preparePiTurnAttachments } from "./attachment-policy.ts";
import { runFinishedEvent } from "./session-event-runtime.ts";
import { asError, fail } from "./session-errors.ts";
import type { PiSessionHandle } from "./session-runtime-types.ts";
import type { PiSubagentRuntime } from "./subagent-runtime.ts";
import {
  assertActivePiRun,
  assertPiCancelTarget,
  validateTurnConfigSnapshot,
} from "./turn-policy.ts";

type SubmitCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "turn.submit" }
>;
type SteerCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "turn.steer" | "turn.follow_up" }
>;
type CancelCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "turn.cancel" }
>;

interface PiSessionTurnRuntimeDependencies {
  sessions: Map<string, PiSessionHandle>;
  subagents: PiSubagentRuntime;
  emit: WorkerEmitter;
}

const sessionError = (message: string): Error & { agentError: AgentError } =>
  fail("pi.session_not_found", message, "session");

/** Owns Pi turn admission, streaming continuation, cancellation, and settlement. */
export class PiSessionTurnRuntime {
  private readonly sessions: Map<string, PiSessionHandle>;
  private readonly subagents: PiSubagentRuntime;
  private readonly emit: WorkerEmitter;

  public constructor(dependencies: PiSessionTurnRuntimeDependencies) {
    this.sessions = dependencies.sessions;
    this.subagents = dependencies.subagents;
    this.emit = dependencies.emit;
  }

  public async submit(
    command: SubmitCommand,
    requestId: string | number,
    idempotencyKey?: string,
  ): Promise<void> {
    const handle = this.sessions.get(command.sessionId);
    if (!handle)
      throw sessionError(`Pi session 不存在：${command.sessionId}。`);
    // A replacement prompt waits for an in-flight cancel transition so Pi
    // never receives overlapping prompt/abort calls.
    if (handle.runTransition) {
      await handle.runTransition;
      if (this.sessions.get(command.sessionId) !== handle) {
        throw sessionError(`Pi 会话已关闭：${command.sessionId}。`);
      }
    }
    if (command.config.configRevision !== handle.configRevision) {
      throw fail(
        "pi.config_revision_conflict",
        `Pi 会话配置已更新（当前 revision ${handle.configRevision}），请刷新后重试。`,
        "session",
      );
    }
    // Use worker-owned run state as well as the SDK streaming flag; the SDK
    // can take a short time to reflect prompt acceptance.
    const activeRun = Boolean(handle.runId && !handle.runFinished);
    if (activeRun && command.streamingBehavior === undefined) {
      throw fail(
        "pi.streaming_behavior_required",
        "Pi 会话正在流式运行；请指定 steer 或 followUp 后再提交。",
        "run",
      );
    }
    if (activeRun && !handle.session.isStreaming) {
      throw fail(
        "pi.run_not_streaming",
        "Pi 会话正在启动上一回合，暂时不能 steer 或 follow-up，请稍后重试。",
        "run",
      );
    }
    const { sessionModeId: nextSessionModeId } = validateTurnConfigSnapshot(
      command.config,
      handle,
    );
    const runId = `${command.sessionId}:${command.promptId}`;
    const { content, images } = preparePiTurnAttachments(
      handle.session.model,
      command.content,
      command.attachments,
    );
    if (idempotencyKey?.trim()) {
      const claim = handle.idempotency.claim(
        idempotencyKey,
        fingerprintCommand(command),
        runId,
      );
      if (claim.kind === "duplicate") return;
      if (claim.kind === "conflict") {
        throw fail(
          "pi.idempotency_conflict",
          `幂等键 ${idempotencyKey.trim()} 已用于另一条请求。`,
          "run",
        );
      }
    }
    handle.runId = runId;
    handle.promptId = command.promptId;
    handle.sessionModeId = nextSessionModeId;
    handle.runFinished = false;
    handle.runError = undefined;
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      runId,
      event: { type: "run.accepted", promptId: command.promptId },
    });
    // Cancellation may arrive while acceptance is being emitted.
    if (
      handle.runFinished ||
      handle.runId !== runId ||
      this.sessions.get(command.sessionId) !== handle
    ) {
      return;
    }
    try {
      // A new turn refreshes its runtime snapshot; steer/follow-up reuse the
      // already-running provider context.
      if (!activeRun) await handle.refreshResources?.();
      if (!activeRun) await handle.refreshModelSettings?.();
      if (
        handle.runFinished ||
        handle.runId !== runId ||
        this.sessions.get(command.sessionId) !== handle
      ) {
        return;
      }
      if (activeRun && command.streamingBehavior === "steer") {
        await handle.session.steer(content, images);
      } else if (activeRun && command.streamingBehavior === "followUp") {
        await handle.session.followUp(content, images);
      } else {
        await handle.session.prompt(content, {
          images,
          streamingBehavior: command.streamingBehavior,
        });
      }
      await handle.eventTail;
      if (!handle.runFinished) {
        handle.runFinished = true;
        await this.emit({
          requestId,
          sessionId: command.sessionId,
          runId,
          event: runFinishedEvent(command.promptId, handle.runError, "pi_idle"),
        });
      }
    } catch (error) {
      const shouldEmitFailure =
        !handle.runFinished && this.sessions.get(command.sessionId) === handle;
      handle.runFinished = true;
      const agentError =
        (error as { agentError?: AgentError }).agentError ??
        asError(error, "run");
      if (shouldEmitFailure) {
        await this.emit({
          requestId,
          sessionId: command.sessionId,
          runId,
          event: {
            type: "run.finished",
            promptId: command.promptId,
            status: "failed",
            error: agentError,
          },
        });
      }
      throw error;
    }
  }

  public async steer(
    command: SteerCommand,
    requestId: string | number,
  ): Promise<void> {
    const handle = this.sessions.get(command.sessionId);
    if (!handle)
      throw sessionError(`Pi session 不存在：${command.sessionId}。`);
    assertActivePiRun({
      expectedRunId: command.runId,
      activeRunId: handle.runId,
      runFinished: handle.runFinished,
      isStreaming: handle.session.isStreaming,
    });
    if (command.type === "turn.steer") {
      await handle.session.steer(command.content);
    } else {
      await handle.session.followUp(command.content);
    }
    if (
      handle.runFinished ||
      handle.runId !== command.runId ||
      this.sessions.get(command.sessionId) !== handle
    ) {
      return;
    }
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      runId: command.runId,
      event: {
        type: "run.accepted",
        ...(handle.promptId ? { promptId: handle.promptId } : {}),
      },
    });
  }

  public async cancel(
    command: CancelCommand,
    requestId: string | number,
  ): Promise<void> {
    const handle = this.sessions.get(command.sessionId);
    if (!handle)
      throw sessionError(`Pi session 不存在：${command.sessionId}。`);
    assertPiCancelTarget({
      expectedRunId: command.runId,
      expectedPromptId: command.promptId,
      activeRunId: handle.runId,
      activePromptId: handle.promptId,
    });
    if (handle.runTransition) {
      await handle.runTransition;
      return;
    }
    const runId = handle.runId;
    const wasRunning = Boolean(runId && !handle.runFinished);
    if (wasRunning) handle.runFinished = true;
    const transition = (async () => {
      handle.session.clearQueue();
      if (handle.session.isStreaming) {
        await handle.session.abort().catch(() => undefined);
      }
      if (command.cancelSubagents) {
        await this.subagents.cancelForRootSession(command.sessionId);
      }
      const stillOwnsRun =
        wasRunning &&
        Boolean(runId) &&
        this.sessions.get(command.sessionId) === handle &&
        handle.runId === runId;
      if (stillOwnsRun && runId) {
        await this.emit({
          requestId,
          sessionId: command.sessionId,
          runId,
          event: {
            type: "run.finished",
            ...(handle.promptId ? { promptId: handle.promptId } : {}),
            status: "cancelled",
            stopReason: command.reason,
          },
        });
      }
    })();
    handle.runTransition = transition;
    try {
      await transition;
    } finally {
      if (handle.runTransition === transition) {
        handle.runTransition = undefined;
      }
    }
  }
}
