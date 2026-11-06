import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { gatewayError } from "./tool-errors.ts";
import {
  PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
  PI_GET_TASK_OUTPUT,
  PI_KILL_COMMAND_OR_SUBAGENT,
  PI_KILL_TASK,
  PI_RUN_BACKGROUND_TASK,
  PI_SPAWN_SUBAGENT,
  PI_TASK,
  PI_WAIT_COMMANDS_OR_SUBAGENTS,
  PI_WAIT_TASKS,
} from "./tool-names.ts";
import { boundedTaskSnapshots, legacyTaskText } from "./task-results.ts";
import {
  BACKGROUND_TASK_DEFAULT_TIMEOUT_MS,
  backgroundParameters,
  killTaskParameters,
  legacyTaskOutputParameters,
  legacyTaskParameters,
  subagentParameters,
  taskOutputParameters,
  waitTasksParameters,
} from "./tool-schemas.ts";
import { textResult } from "./tool-results.ts";
import type { PiSubagentIsolation } from "./subagent-policy-normalization.ts";

export type { PiSubagentIsolation } from "./subagent-policy-normalization.ts";

export type PiTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface PiTaskSnapshot {
  taskId: string;
  status: PiTaskStatus;
  output?: string;
  childSessionId?: string;
  parentTaskId?: string;
  role?: string;
  persona?: string;
  agent?: string;
  resumedFrom?: string;
  isolation?: PiSubagentIsolation;
  worktreePath?: string;
}

/** Worker-local access to tasks visible to the current product session. */
export interface PiTaskController {
  wait(input: {
    taskIds: string[];
    mode: "wait_any" | "wait_all";
    timeoutMs: number;
    parentSessionId: string;
  }): Promise<readonly PiTaskSnapshot[]>;
  cancel(input: {
    taskId: string;
    parentSessionId: string;
  }): Promise<PiTaskSnapshot>;
}

export type PiSubagentSpawner = (input: {
  task: string;
  resumeFrom?: string;
  subagentType?: string;
  role?: string;
  persona?: string;
  agent?: string;
  capabilityMode?: string;
  cwd?: string;
  isolation?: string;
  modelId?: string;
  reasoningEffort?: string;
  background: boolean;
  parentSessionId: string;
}) => Promise<{ taskId: string; output?: string; worktreePath?: string }>;

type EnsureToolAllowed = (toolName: string) => void;
type EnsureSubagentCapability = (toolName: string) => void;

export const createSubagentTools = (input: {
  sessionId: () => string;
  spawnSubagent: PiSubagentSpawner;
  ensureToolAllowed: EnsureToolAllowed;
  ensureSubagentCapability: EnsureSubagentCapability;
}): ToolDefinition[] => {
  const {
    sessionId,
    spawnSubagent,
    ensureToolAllowed,
    ensureSubagentCapability,
  } = input;
  return [
    {
      name: PI_SPAWN_SUBAGENT,
      label: "Spawn subagent",
      description: "Run a focused child Pi session and return its result.",
      promptSnippet: "Delegate an independent task to a child agent.",
      parameters: subagentParameters,
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        ensureToolAllowed(PI_SPAWN_SUBAGENT);
        const value = params as Static<typeof subagentParameters>;
        const result = await spawnSubagent({
          task: value.task,
          ...((value.resumeFrom ?? value.resume_from)
            ? { resumeFrom: value.resumeFrom ?? value.resume_from }
            : {}),
          subagentType: value.subagentType,
          role: value.role,
          persona: value.persona,
          agent: value.agent,
          capabilityMode: value.capabilityMode,
          cwd: value.cwd,
          isolation: value.isolation,
          modelId: value.modelId,
          reasoningEffort: value.reasoningEffort,
          background: false,
          parentSessionId: sessionId(),
        });
        return textResult(
          `${result.output ?? `Subagent ${result.taskId} 已完成。`}${
            result.worktreePath ? `\nworktree: ${result.worktreePath}` : ""
          }`,
          PI_SPAWN_SUBAGENT,
          true,
          result.taskId,
        );
      },
    },
    {
      name: PI_RUN_BACKGROUND_TASK,
      label: "Run background task",
      description:
        "Start a child Pi task that can be awaited or cancelled later.",
      promptSnippet: "Start longer independent work in the background.",
      parameters: backgroundParameters,
      executionMode: "parallel",
      execute: async (_toolCallId, params) => {
        ensureToolAllowed(PI_RUN_BACKGROUND_TASK);
        const value = params as Static<typeof backgroundParameters>;
        const result = await spawnSubagent({
          task: value.task,
          ...((value.resumeFrom ?? value.resume_from)
            ? { resumeFrom: value.resumeFrom ?? value.resume_from }
            : {}),
          subagentType: value.subagentType,
          role: value.role,
          persona: value.persona,
          agent: value.agent,
          capabilityMode: value.capabilityMode,
          cwd: value.cwd,
          isolation: value.isolation,
          modelId: value.modelId,
          reasoningEffort: value.reasoningEffort,
          background: true,
          parentSessionId: sessionId(),
        });
        return textResult(
          `后台任务 ${result.taskId} 已启动。${
            result.worktreePath ? ` worktree: ${result.worktreePath}` : ""
          }`,
          PI_RUN_BACKGROUND_TASK,
          true,
          result.taskId,
        );
      },
    },
    {
      name: PI_TASK,
      label: "Task (Melody compatibility)",
      description:
        "Compatibility alias for Melody-build's task tool. Supports foreground/background subagents and the original snake_case arguments.",
      promptSnippet:
        "Delegate work with the original Melody task contract when a compatibility skill requires it.",
      parameters: legacyTaskParameters,
      executionMode: "parallel",
      execute: async (_toolCallId, params) => {
        ensureToolAllowed(PI_TASK);
        ensureSubagentCapability(PI_TASK);
        const value = params as Static<typeof legacyTaskParameters>;
        const task = value.prompt ?? value.task;
        if (!task?.trim()) {
          throw gatewayError(
            "pi.task_prompt_missing",
            "task 需要提供 prompt（或 task）参数。",
            false,
            "run",
          );
        }
        const background = value.run_in_background ?? true;
        const result = await spawnSubagent({
          task,
          ...(value.subagent_type ? { subagentType: value.subagent_type } : {}),
          ...(value.role ? { role: value.role } : {}),
          ...(value.persona ? { persona: value.persona } : {}),
          ...(value.agent ? { agent: value.agent } : {}),
          ...(value.capability_mode
            ? { capabilityMode: value.capability_mode }
            : {}),
          ...(value.resume_from ? { resumeFrom: value.resume_from } : {}),
          ...(value.cwd ? { cwd: value.cwd } : {}),
          ...(value.isolation ? { isolation: value.isolation } : {}),
          ...(value.model ? { modelId: value.model } : {}),
          background,
          parentSessionId: sessionId(),
        });
        return textResult(
          legacyTaskText({
            taskId: result.taskId,
            ...(result.output ? { output: result.output } : {}),
            subagentType: value.subagent_type,
            background,
          }),
          PI_TASK,
          true,
          result.taskId,
        );
      },
    },
  ];
};

const taskSnapshotsResult = (
  snapshots: readonly PiTaskSnapshot[],
  toolName: string,
) =>
  textResult(JSON.stringify(boundedTaskSnapshots(snapshots)), toolName, true);

const taskSnapshotResult = (snapshot: PiTaskSnapshot, toolName: string) =>
  textResult(
    JSON.stringify(boundedTaskSnapshots([snapshot])[0]),
    toolName,
    true,
  );

export const createTaskControlTools = (input: {
  sessionId: () => string;
  taskController: PiTaskController;
  ensureToolAllowed: EnsureToolAllowed;
  ensureSubagentCapability: EnsureSubagentCapability;
}): ToolDefinition[] => {
  const {
    sessionId,
    taskController,
    ensureToolAllowed,
    ensureSubagentCapability,
  } = input;
  return [
    {
      name: PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
      label: "Get background task output",
      description:
        "Inspect a background command or subagent and optionally wait for a bounded time.",
      promptSnippet:
        "Inspect the current status and output of a background task.",
      parameters: taskOutputParameters,
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        ensureToolAllowed(PI_GET_COMMAND_OR_SUBAGENT_OUTPUT);
        const value = params as Static<typeof taskOutputParameters>;
        const snapshots = await taskController.wait({
          taskIds: [value.task_id],
          mode: "wait_any",
          timeoutMs: value.timeout_ms ?? 0,
          parentSessionId: sessionId(),
        });
        return taskSnapshotsResult(
          snapshots,
          PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
        );
      },
    },
    {
      name: PI_WAIT_COMMANDS_OR_SUBAGENTS,
      label: "Wait for background tasks",
      description:
        "Wait for one or more visible background commands or subagents to complete.",
      promptSnippet:
        "Wait for any or all background tasks and inspect their bounded results.",
      parameters: waitTasksParameters,
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        ensureToolAllowed(PI_WAIT_COMMANDS_OR_SUBAGENTS);
        const value = params as Static<typeof waitTasksParameters>;
        const snapshots = await taskController.wait({
          taskIds: value.task_ids,
          mode: value.mode,
          timeoutMs: value.timeout_ms ?? BACKGROUND_TASK_DEFAULT_TIMEOUT_MS,
          parentSessionId: sessionId(),
        });
        return taskSnapshotsResult(snapshots, PI_WAIT_COMMANDS_OR_SUBAGENTS);
      },
    },
    {
      name: PI_KILL_COMMAND_OR_SUBAGENT,
      label: "Kill background task",
      description:
        "Cancel a visible background command or subagent and return its final status.",
      promptSnippet: "Stop a background task that is no longer needed.",
      parameters: killTaskParameters,
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        ensureToolAllowed(PI_KILL_COMMAND_OR_SUBAGENT);
        const value = params as Static<typeof killTaskParameters>;
        const snapshot = await taskController.cancel({
          taskId: value.task_id,
          parentSessionId: sessionId(),
        });
        return taskSnapshotResult(snapshot, PI_KILL_COMMAND_OR_SUBAGENT);
      },
    },
    {
      name: PI_GET_TASK_OUTPUT,
      label: "Get task output (Melody compatibility)",
      description:
        "Compatibility alias for Melody-build's get_task_output tool.",
      promptSnippet: "Inspect one or more background task or subagent results.",
      parameters: legacyTaskOutputParameters,
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        ensureToolAllowed(PI_GET_TASK_OUTPUT);
        ensureSubagentCapability(PI_GET_TASK_OUTPUT);
        const value = params as Static<typeof legacyTaskOutputParameters>;
        const timeoutMs = value.timeout_ms ?? 0;
        const snapshots = await taskController.wait({
          taskIds: value.task_ids,
          mode:
            timeoutMs > 0 && value.task_ids.length > 1
              ? "wait_all"
              : "wait_any",
          timeoutMs,
          parentSessionId: sessionId(),
        });
        return taskSnapshotsResult(snapshots, PI_GET_TASK_OUTPUT);
      },
    },
    {
      name: PI_WAIT_TASKS,
      label: "Wait tasks (Melody compatibility)",
      description: "Compatibility alias for Melody-build's wait_tasks tool.",
      promptSnippet:
        "Wait for multiple background tasks or subagents to complete.",
      parameters: waitTasksParameters,
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        ensureToolAllowed(PI_WAIT_TASKS);
        ensureSubagentCapability(PI_WAIT_TASKS);
        const value = params as Static<typeof waitTasksParameters>;
        const snapshots = await taskController.wait({
          taskIds: value.task_ids,
          mode: value.mode,
          timeoutMs: value.timeout_ms ?? BACKGROUND_TASK_DEFAULT_TIMEOUT_MS,
          parentSessionId: sessionId(),
        });
        return taskSnapshotsResult(snapshots, PI_WAIT_TASKS);
      },
    },
    {
      name: PI_KILL_TASK,
      label: "Kill task (Melody compatibility)",
      description: "Compatibility alias for Melody-build's kill_task tool.",
      promptSnippet: "Stop a background task or subagent by id.",
      parameters: killTaskParameters,
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        ensureToolAllowed(PI_KILL_TASK);
        ensureSubagentCapability(PI_KILL_TASK);
        const value = params as Static<typeof killTaskParameters>;
        const snapshot = await taskController.cancel({
          taskId: value.task_id,
          parentSessionId: sessionId(),
        });
        return taskSnapshotResult(snapshot, PI_KILL_TASK);
      },
    },
  ];
};
