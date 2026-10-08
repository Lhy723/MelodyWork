import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubagentProjectionState,
  projectSubagentEvent,
} from "./subagent-projection.ts";

const event = (type, values = {}) => ({
  type,
  taskId: "task-1",
  status: "running",
  ...values,
});

test("projects spawn, progress and terminal subagent events into one record", () => {
  let state = createSubagentProjectionState();
  const spawned = projectSubagentEvent(
    state,
    event("subagent.changed", {
      childSessionId: "child-1",
      payload: {
        description: "检查文档",
        subagentType: "research",
        modelId: "pi/model",
        startedAt: 100,
      },
    }),
    "parent-1",
    200,
  );
  assert.equal(spawned.handled, true);
  assert.equal(spawned.subagent.status, "running");
  assert.equal(spawned.subagent.parentSessionId, "parent-1");
  assert.equal(spawned.subagent.childSessionId, "child-1");
  assert.equal(spawned.subagent.description, "检查文档");
  assert.equal(spawned.subagent.model, "pi/model");
  state = spawned.state;

  const progress = projectSubagentEvent(
    state,
    event("subagent.changed", {
      payload: {
        child_session_id: "child-1",
        turn_count: 3,
        tool_calls: 4,
        tokens_used: 120,
        tools_used: ["read", "search"],
      },
    }),
    "parent-1",
    300,
  );
  assert.equal(progress.subagent.turnCount, 3);
  assert.equal(progress.subagent.toolCallCount, 4);
  assert.deepEqual(progress.subagent.toolsUsed, ["read", "search"]);
  state = progress.state;

  const finished = projectSubagentEvent(
    state,
    event("subagent.changed", {
      status: "succeeded",
      payload: {
        childSessionId: "child-1",
        output: "已完成",
        duration_ms: 500,
      },
    }),
    "parent-1",
    400,
  );
  assert.equal(finished.subagent.status, "completed");
  assert.equal(finished.subagent.output, "已完成");
  assert.equal(finished.subagent.durationMs, 500);
  assert.equal(finished.previous.status, "running");
});

test("retains parent task identity when a nested subagent changes status", () => {
  const spawned = projectSubagentEvent(
    createSubagentProjectionState(),
    event("subagent.changed", {
      parentTaskId: "parent-task",
      childSessionId: "nested-child-session",
      payload: { description: "嵌套检查" },
    }),
    "root-session",
    100,
  );
  assert.equal(spawned.subagent.parentTaskId, "parent-task");

  const completed = projectSubagentEvent(
    spawned.state,
    event("subagent.changed", {
      status: "completed",
      childSessionId: "nested-child-session",
      payload: { output: "完成" },
    }),
    "root-session",
    200,
  );
  assert.equal(completed.subagent.parentTaskId, "parent-task");
});

test("does not turn generic task events into fake subagents", () => {
  const state = createSubagentProjectionState();
  const result = projectSubagentEvent(
    state,
    event("task.changed", { taskId: "background-1", status: "running" }),
    "parent-1",
    100,
  );
  assert.equal(result.handled, false);
  assert.equal(result.notApplicable, true);
  assert.equal(result.state, state);
});

test("reports malformed subagent events without mutating state", () => {
  const state = createSubagentProjectionState();
  const result = projectSubagentEvent(
    state,
    event("subagent.changed", { taskId: "task-1", childSessionId: undefined }),
    "parent-1",
    100,
  );
  assert.equal(result.handled, false);
  assert.match(result.reason, /child session/);
  assert.equal(result.state, state);
});
