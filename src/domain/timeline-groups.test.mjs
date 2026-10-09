import assert from "node:assert/strict";
import test from "node:test";

import { groupTurnActivity, toolIsRunning } from "./timeline-groups.ts";

const message = (id, role) => ({
  id,
  kind: "message",
  role,
  content: id,
});

const tool = (id) => ({
  id,
  kind: "tool",
  title: id,
  command: "",
  output: "",
});

test("groups a turn's reasoning and tools into one activity block", () => {
  const projected = groupTurnActivity([
    { ...message("user-1", "user"), startedAt: 1_000 },
    {
      id: "thought-1",
      kind: "thought",
      content: "thinking",
      startedAt: 2_000,
    },
    { ...tool("read"), status: "completed", startedAt: 3_000 },
    {
      id: "thought-2",
      kind: "thought",
      content: "thinking again",
      startedAt: 4_000,
    },
    { ...tool("scan"), status: "completed", startedAt: 5_000 },
    {
      ...message("answer", "assistant"),
      completedAt: 9_000,
      startedAt: 8_000,
    },
  ]);

  assert.deepEqual(
    projected.map((entry) =>
      entry.kind === "activity-group"
        ? {
            id: entry.id,
            kind: entry.kind,
            startedAt: entry.startedAt,
            endedAt: entry.endedAt,
            running: entry.running,
            items: entry.items.map((item) =>
              item.kind === "tool-group"
                ? {
                    kind: item.kind,
                    tools: item.tools.map((toolEntry) => toolEntry.id),
                  }
                : { id: item.id, kind: item.kind },
            ),
          }
        : { id: entry.id, kind: entry.kind },
    ),
    [
      { id: "user-1", kind: "message" },
      {
        id: "activity-group-thought-1",
        kind: "activity-group",
        startedAt: 1_000,
        endedAt: 9_000,
        running: false,
        items: [
          { id: "thought-1", kind: "thought" },
          { kind: "tool-group", tools: ["read"] },
          { id: "thought-2", kind: "thought" },
          { kind: "tool-group", tools: ["scan"] },
        ],
      },
      { id: "answer", kind: "message" },
    ],
  );
});

test("starts a new activity group for the next user turn", () => {
  const projected = groupTurnActivity([
    message("user-1", "user"),
    { ...tool("read"), status: "completed" },
    message("answer-1", "assistant"),
    message("user-2", "user"),
    tool("write"),
  ]);
  assert.deepEqual(
    projected
      .filter((entry) => entry.kind === "activity-group")
      .map((entry) => ({
        running: entry.running,
        tools: entry.items.flatMap((item) =>
          item.kind === "tool-group"
            ? item.tools.map((toolEntry) => toolEntry.id)
            : [],
        ),
      })),
    [
      { running: false, tools: ["read"] },
      { running: true, tools: ["write"] },
    ],
  );
});

test("keeps an active turn open between completed tool calls", () => {
  const entries = [
    message("user-1", "user"),
    { ...tool("read"), status: "completed" },
  ];

  const active = groupTurnActivity(entries, true).find(
    (entry) => entry.kind === "activity-group",
  );
  const completed = groupTurnActivity(entries, false).find(
    (entry) => entry.kind === "activity-group",
  );

  assert.equal(active?.running, true);
  assert.equal(completed?.running, false);
});

test("shows a running placeholder while waiting for the first Pi event", () => {
  const userMessage = { ...message("user-waiting", "user"), startedAt: 1_000 };

  assert.deepEqual(groupTurnActivity([userMessage], true), [
    userMessage,
    {
      id: "activity-group-pending-user-waiting",
      kind: "activity-group",
      items: [],
      startedAt: 1_000,
      running: true,
    },
  ]);
  assert.deepEqual(groupTurnActivity([userMessage], false), [userMessage]);
});

test("does not add a waiting placeholder after assistant streaming begins", () => {
  const userMessage = message("user-1", "user");
  const assistantMessage = {
    ...message("assistant-1", "assistant"),
    streaming: true,
  };
  const projected = groupTurnActivity([userMessage, assistantMessage], true);

  assert.equal(
    projected.some((entry) => entry.kind === "activity-group"),
    false,
  );
});

test("does not show a stale tool as running after its turn has ended", () => {
  const pending = { ...tool("legacy-pending"), status: "pending" };
  const cancelled = { ...tool("cancelled"), status: "cancelled" };

  assert.equal(toolIsRunning(pending), true);
  assert.equal(toolIsRunning(pending, false), false);
  assert.equal(toolIsRunning(cancelled), false);
});

test("folds intermediate assistant updates and activity into one completed turn", () => {
  const entries = [
    { ...message("user-turn", "user"), startedAt: 1_000 },
    {
      id: "thought-before-progress",
      kind: "thought",
      content: "Starting the inspection",
      startedAt: 2_000,
      completedAt: 2_200,
    },
    {
      ...message("assistant-progress", "assistant"),
      content: "Let me check the environment.",
      startedAt: 2_200,
      completedAt: 2_500,
    },
    { ...tool("read-config"), status: "completed", startedAt: 2_500 },
    {
      ...message("assistant-blank", "assistant"),
      content: " \n ",
      startedAt: 3_000,
      completedAt: 4_000,
    },
    {
      id: "thought-after-blank",
      kind: "thought",
      content: "Summarizing the result",
      startedAt: 4_500,
      completedAt: 5_000,
    },
    { ...tool("read-skills"), status: "completed", startedAt: 5_000 },
    {
      ...message("assistant-final", "assistant"),
      content: "Here is the result.",
      startedAt: 9_000,
      completedAt: 10_000,
    },
  ];

  const projected = groupTurnActivity(entries);
  const activityGroups = projected.filter(
    (entry) => entry.kind === "activity-group",
  );

  assert.equal(activityGroups.length, 1);
  assert.deepEqual(
    projected.map((entry) => entry.kind),
    ["message", "activity-group", "message"],
  );
  assert.equal(activityGroups[0].startedAt, 1_000);
  assert.equal(activityGroups[0].endedAt, 10_000);
  assert.deepEqual(
    activityGroups[0].items.map((item) => item.kind),
    ["thought", "message", "tool-group", "thought", "tool-group"],
  );
  assert.equal(activityGroups[0].items[1].id, "assistant-progress");
  assert.equal(
    activityGroups[0].items.some((item) => item.id === "assistant-blank"),
    false,
  );
});
