import assert from "node:assert/strict";
import test from "node:test";

import { groupTurnActivity } from "./timeline-groups.ts";

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
