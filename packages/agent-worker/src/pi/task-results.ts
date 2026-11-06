/** Pure task-result projection shared by the Pi task-tool handlers. */

const MAX_TASK_CONTROL_OUTPUT_CHARS = 64 * 1024;

/** Bound model-facing snapshots without mutating the registry-owned values. */
export const boundedTaskSnapshots = <TSnapshot extends { output?: string }>(
  snapshots: readonly TSnapshot[],
): TSnapshot[] =>
  snapshots.map((snapshot) => {
    if (
      !snapshot.output ||
      snapshot.output.length <= MAX_TASK_CONTROL_OUTPUT_CHARS
    ) {
      return { ...snapshot };
    }
    return {
      ...snapshot,
      output: `${snapshot.output.slice(0, MAX_TASK_CONTROL_OUTPUT_CHARS)}\n[task output truncated]`,
    };
  });

/** Render the legacy `task` response without changing its compatibility text. */
export const legacyTaskText = (input: {
  taskId: string;
  output?: string;
  subagentType?: string;
  background: boolean;
}): string => {
  const type = input.subagentType ?? "general-purpose";
  if (input.background) {
    return [
      "Subagent started in background.",
      `subagent_id: ${input.taskId}`,
      `type: ${type}`,
      "Use get_task_output with task_ids and timeout_ms to retrieve the result.",
    ].join("\n");
  }
  return [
    input.output ?? `Subagent ${input.taskId} 已完成。`,
    "",
    "<subagent_result>",
    `subagent_id: ${input.taskId}`,
    `subagent_type: ${type}`,
    `To continue this subagent's conversation, use resume_from="${input.taskId}".`,
    "</subagent_result>",
  ].join("\n");
};
