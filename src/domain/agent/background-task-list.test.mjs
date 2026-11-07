import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCancelResult,
  backgroundTaskRows,
  FINISHED_TASK_LIMIT,
} from "./background-task-list.ts";

const task = (overrides = {}) => ({
  taskId: "pi-terminal-task:a",
  command: "sleep 300",
  status: "running",
  startedAt: 1,
  ...overrides,
});

test("running tasks come first and finished work is dropped past the cap", () => {
  const finished = Array.from({ length: FINISHED_TASK_LIMIT + 2 }, (_, index) =>
    task({
      taskId: `pi-terminal-task:done-${index}`,
      status: "completed",
      startedAt: 100 + index,
    }),
  );
  const rows = backgroundTaskRows([
    task({ taskId: "pi-terminal-task:old", status: "completed", startedAt: 1 }),
    task({ taskId: "pi-terminal-task:live", startedAt: 9 }),
    ...finished,
  ]);
  assert.equal(rows[0].taskId, "pi-terminal-task:live");
  assert.equal(rows[0].running, true);
  assert.equal(rows.filter((row) => !row.running).length, FINISHED_TASK_LIMIT);
  // Newest finished tasks survive; the oldest finished entry is dropped.
  assert.ok(rows.some((row) => row.taskId === "pi-terminal-task:done-4"));
  assert.ok(!rows.some((row) => row.taskId === "pi-terminal-task:old"));
});

test("running rows are newest first", () => {
  const rows = backgroundTaskRows([
    task({ taskId: "pi-terminal-task:first", startedAt: 1 }),
    task({ taskId: "pi-terminal-task:second", startedAt: 2 }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.taskId),
    ["pi-terminal-task:second", "pi-terminal-task:first"],
  );
});

test("labels collapse whitespace and truncate, commands stay intact", () => {
  const command = `printf '${"x".repeat(90)}'\n`;
  const [row] = backgroundTaskRows([task({ command })]);
  assert.equal(row.label.includes("\n"), false);
  assert.equal(row.label.endsWith("…"), true);
  assert.equal(row.label.length, 72);
  assert.equal(row.command, command);
});

test("status labels cover the Host statuses", () => {
  const rows = backgroundTaskRows([
    task({ taskId: "pi-terminal-task:a", status: "running" }),
    task({ taskId: "pi-terminal-task:b", status: "cancelled", startedAt: 2 }),
    task({ taskId: "pi-terminal-task:c", status: "failed", startedAt: 3 }),
    task({ taskId: "pi-terminal-task:d", status: "unknown", startedAt: 4 }),
  ]);
  const labels = Object.fromEntries(
    rows.map((row) => [row.taskId, row.statusLabel]),
  );
  assert.deepEqual(labels, {
    "pi-terminal-task:a": "运行中",
    "pi-terminal-task:d": "未知",
    "pi-terminal-task:c": "失败",
    "pi-terminal-task:b": "已停止",
  });
});

test("a successful cancel replaces the row with the Host snapshot", () => {
  const rows = [task({ taskId: "pi-terminal-task:a" })];
  const result = applyCancelResult(rows, "pi-terminal-task:a", {
    ok: true,
    task: task({ taskId: "pi-terminal-task:a", status: "cancelled" }),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks[0].status, "cancelled");
});

test("a stop that races a natural exit lands on the terminal status", () => {
  const rows = [task({ taskId: "pi-terminal-task:a" })];
  const result = applyCancelResult(rows, "pi-terminal-task:a", {
    ok: true,
    task: task({ taskId: "pi-terminal-task:a", status: "completed" }),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks[0].status, "completed");
});

test("a rejected cancel keeps the rows and returns the message", () => {
  const rows = [task({ taskId: "pi-terminal-task:a" })];
  const result = applyCancelResult(rows, "pi-terminal-task:a", {
    ok: false,
    message: "Background task not found: pi-terminal-task:a",
  });
  assert.equal(result.error, "Background task not found: pi-terminal-task:a");
  assert.deepEqual(result.tasks, rows);
  assert.notEqual(result.tasks, rows);
});

test("a cancel for an unknown task changes nothing", () => {
  const rows = [task({ taskId: "pi-terminal-task:a" })];
  const result = applyCancelResult(rows, "pi-terminal-task:missing", {
    ok: true,
    task: task({ taskId: "pi-terminal-task:missing", status: "cancelled" }),
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.tasks, rows);
});
