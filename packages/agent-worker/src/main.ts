import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  AGENT_PROTOCOL_VERSION,
  assertAgentCommandCapabilities,
  type AgentCommandEnvelope,
  type AgentEvent,
  type AgentError,
  validateAgentCommandEnvelope,
} from "@melody/agent-contract";
import { PiSessionAdapter } from "./pi/session-adapter.ts";
import { JsonlWriter, readJsonLines } from "./transport.ts";

const writer = new JsonlWriter(process.stdout);
const workerEpoch = randomUUID();
let sequence = 0;

const emit = async (context: {
  sessionId?: string;
  streamSessionId?: string;
  runId?: string;
  requestId?: string | number;
  event: AgentEvent;
  replay?: boolean;
}) => {
  const id = `${workerEpoch}:${sequence}`;
  await writer.write({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    eventId: id,
    sourceEventId: id,
    requestId: context.requestId,
    sessionId: context.sessionId,
    streamSessionId: context.streamSessionId,
    runId: context.runId,
    seq: sequence++,
    workerEpoch,
    replay: context.replay ?? false,
    event: context.event,
  });
};

const adapter = new PiSessionAdapter(emit);

const errorFor = (
  error: unknown,
  scope: AgentError["scope"] = "runtime",
): AgentError =>
  (error as { agentError?: AgentError }).agentError ?? {
    code: "pi.worker_error",
    message: error instanceof Error ? error.message : String(error),
    retriable: false,
    scope,
  };

const dispatch = async (command: AgentCommandEnvelope): Promise<boolean> => {
  const { requestId } = command;
  switch (command.command.type) {
    case "runtime.health":
      await emit({
        requestId,
        event: { type: "runtime.ready", capabilities: adapter.health() },
      });
      return false;
    case "runtime.shutdown":
      await adapter.closeAll();
      return true;
    case "runtime.models.list":
      await adapter.listModels(requestId, command.command.refresh);
      return false;
    case "runtime.models.sync":
      await adapter.syncModels(command.command, requestId);
      return false;
    case "runtime.authenticate":
      await adapter.authenticate(command.command, requestId);
      return false;
    case "session.open":
      await adapter.open(command.command, requestId);
      return false;
    case "session.close":
      await adapter.close(command.command.sessionId, requestId);
      return false;
    case "session.fork":
      await adapter.fork(command.command, requestId);
      return false;
    case "session.import":
      await adapter.importSession(command.command, requestId);
      return false;
    case "turn.submit":
      await adapter.submit(command.command, requestId, command.idempotencyKey);
      return false;
    case "turn.steer":
    case "turn.follow_up":
      await adapter.steer(command.command, requestId);
      return false;
    case "turn.cancel":
      await adapter.cancel(command.command, requestId);
      return false;
    case "tool.resolve":
      adapter.resolveTool(command.command);
      return false;
    case "interaction.resolve":
      adapter.resolveInteraction(command.command);
      return false;
    case "task.wait":
      await adapter.waitTask(command.command, requestId);
      return false;
    case "task.cancel":
      await adapter.cancelTask(command.command, requestId);
      return false;
    case "task.continue":
      await adapter.continueTask(command.command, requestId);
      return false;
    case "session.configure":
      await adapter.configure(command.command, requestId);
      return false;
    case "session.resources.refresh":
      await adapter.refreshResources(command.command, requestId);
      return false;
  }
};

const main = async () => {
  // ToolGateway resolutions can arrive while a turn is waiting inside Pi's
  // tool callback. Keep the stdin pump independent from long-running turn
  // dispatches; otherwise the host could never resume the waiting tool.
  const pending = new Set<Promise<void>>();
  let shutdownRequested = false;
  await readJsonLines(process.stdin, (frame) => {
    // Validate once before scheduling so the transport can stop at a valid
    // shutdown frame without admitting commands that follow it in the same
    // stdin chunk. The task repeats validation to keep all error reporting in
    // the normal dispatch path.
    let stopInput = false;
    try {
      validateAgentCommandEnvelope(frame);
      stopInput = frame.command.type === "runtime.shutdown";
    } catch {
      // Let the scheduled task emit the structured validation error.
    }
    const tasksBeforeFrame = [...pending];
    const task = (async () => {
      try {
        validateAgentCommandEnvelope(frame);
        // Fail before touching a session or provider when the negotiated Pi
        // capability matrix cannot honor the command. This keeps an
        // unsupported request deterministic and gives the Host a structured
        // diagnostic instead of a late SDK exception.
        assertAgentCommandCapabilities(frame, adapter.health());
        const shouldShutdown = await dispatch(frame);
        if (shouldShutdown) {
          // The first close cancels turns that may be waiting for a Host tool
          // response. A command that was already admitted can still finish
          // opening a session after that close, so wait for the earlier task
          // snapshot and close once more before allowing the process to exit.
          // This keeps shutdown safe without serializing normal stdin work.
          await Promise.all(tasksBeforeFrame);
          await adapter.closeAll();
          shutdownRequested = true;
        }
      } catch (error) {
        const command =
          frame !== null && typeof frame === "object" && !Array.isArray(frame)
            ? (frame as Partial<AgentCommandEnvelope>)
            : undefined;
        await emit({
          requestId: command?.requestId,
          sessionId: command?.sessionId,
          event: { type: "runtime.error", error: errorFor(error) },
        });
      }
    })();
    pending.add(task);
    task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return stopInput ? false : undefined;
  });
  await Promise.all([...pending]);
  if (!shutdownRequested) {
    await adapter.closeAll();
    await writer.flush();
  }
};

main().catch(async (error) => {
  await emit({ event: { type: "runtime.error", error: errorFor(error) } });
  await writer.flush();
  process.exitCode = 1;
});
