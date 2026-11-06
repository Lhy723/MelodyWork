import { randomUUID } from "node:crypto";
import type { PiToolGateway } from "./tool-gateway.ts";
import {
  PI_BACKGROUND_TERMINAL_TASK_PREFIX,
  PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
  PI_KILL_COMMAND_OR_SUBAGENT,
  PI_WAIT_COMMANDS_OR_SUBAGENTS,
} from "./tool-names.ts";
import type { PiSessionContext } from "./session-runtime-types.ts";
import type { PiTaskSnapshot } from "./task-tools.ts";
import { fail } from "./session-errors.ts";

/** Host-owned background terminal task bridge and response validation. */

type HostTaskToolName =
  | typeof PI_GET_COMMAND_OR_SUBAGENT_OUTPUT
  | typeof PI_WAIT_COMMANDS_OR_SUBAGENTS
  | typeof PI_KILL_COMMAND_OR_SUBAGENT;

export interface HostTaskControlOptions {
  toolGateway: Pick<PiToolGateway, "request">;
  contextForSession: (sessionId: string) => PiSessionContext | undefined;
}

const hostTaskStatus = (
  value: unknown,
): PiTaskSnapshot["status"] | undefined =>
  value === "running" ||
  value === "completed" ||
  value === "failed" ||
  value === "cancelled"
    ? value
    : undefined;

export const isHostBackgroundTaskId = (taskId: string): boolean =>
  taskId.trim().startsWith(PI_BACKGROUND_TERMINAL_TASK_PREFIX);

export const parseHostTaskSnapshots = (output: string): PiTaskSnapshot[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw fail(
      "pi.host_task_response_invalid",
      "宿主返回的后台终端任务结果不是有效 JSON。",
      "run",
    );
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw fail(
        "pi.host_task_response_invalid",
        "宿主返回的后台终端任务结果格式无效。",
        "run",
      );
    }
    const record = value as Record<string, unknown>;
    const taskId =
      typeof record.task_id === "string"
        ? record.task_id
        : typeof record.taskId === "string"
          ? record.taskId
          : "";
    const status = hostTaskStatus(record.status);
    if (!taskId || !status) {
      throw fail(
        "pi.host_task_response_invalid",
        "宿主返回的后台终端任务缺少有效 task_id 或 status。",
        "run",
      );
    }
    const snapshot: PiTaskSnapshot = { taskId, status };
    if (typeof record.output === "string") snapshot.output = record.output;
    return snapshot;
  });
};

/**
 * Builds the narrow worker-to-Host request for inspecting/cancelling a Host
 * terminal task. Process state and final authorization remain Host-owned.
 */
export class HostTaskControl {
  private readonly options: HostTaskControlOptions;

  public constructor(options: HostTaskControlOptions) {
    this.options = options;
  }

  public async request(
    sessionId: string,
    toolName: HostTaskToolName,
    requestArguments: Record<string, unknown>,
  ): Promise<PiTaskSnapshot[]> {
    const handle = this.options.contextForSession(sessionId);
    if (!handle) {
      throw fail(
        "pi.session_not_found",
        `Pi session 不存在：${sessionId}。`,
        "session",
      );
    }
    const resolution = await this.options.toolGateway.request({
      sessionId,
      rootSessionId: handle.rootSessionId,
      runId: handle.runId,
      cwd: handle.session.sessionManager.getCwd(),
      toolCallId: `pi-host-task:${randomUUID()}`,
      toolName,
      arguments: requestArguments as Parameters<
        PiToolGateway["request"]
      >[0]["arguments"],
      // Task controls only inspect/cancel an already-authorized Host task.
      // `approved` keeps replayed Host requests explicit and deterministic.
      permissionMode: handle.permissionMode,
      approved: true,
    });
    if (resolution.status !== "completed") {
      throw fail(
        resolution.error?.code ?? "pi.host_task_control_failed",
        resolution.error?.message ?? "宿主无法处理后台终端任务请求。",
        resolution.error?.scope ?? "run",
      );
    }
    return parseHostTaskSnapshots(resolution.output ?? "");
  }
}
