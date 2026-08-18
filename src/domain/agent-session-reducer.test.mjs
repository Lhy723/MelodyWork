import assert from "node:assert/strict";
import test from "node:test";

import { applySessionUpdate } from "./agent-session-reducer.ts";

const objectValue = (value) =>
  value !== null && typeof value === "object" ? value : undefined;
const stringValue = (value) => (typeof value === "string" ? value : undefined);

const dependencies = {
  objectValue,
  stringValue,
  appendUserChunk: (timeline, update) => [...timeline, update.content.text],
  appendAgentChunk: (timeline, text) => [...timeline, text],
  appendThoughtChunk: (timeline, text) => [...timeline, `thought:${text}`],
  appendAgentError: (timeline, message) => [...timeline, `error:${message}`],
  settleStreamingEntries: (timeline) => timeline,
  stampLatestTurnAnalytics: (timeline, _usage, billingUsage) =>
    billingUsage ? [...timeline, { billingUsage }] : timeline,
  upsertTool: (timeline, tool) => [...timeline, tool.toolCallId],
  contextUsageValue: (value) => value,
  billingUsageValue: (value) => value,
};

test("routes agent message chunks and marks the turn streaming", () => {
  assert.deepEqual(
    applySessionUpdate(
      ["before"],
      {
        sessionUpdate: "agent_message_chunk",
        content: { text: "hello" },
      },
      undefined,
      dependencies,
    ),
    { timeline: ["before", "hello"], streaming: true },
  );
});

test("routes usage updates without changing the timeline", () => {
  const timeline = ["before"];
  assert.deepEqual(
    applySessionUpdate(
      timeline,
      { sessionUpdate: "usage_update", used: 10, size: 100 },
      undefined,
      dependencies,
    ),
    {
      timeline,
      contextUsage: { sessionUpdate: "usage_update", used: 10, size: 100 },
    },
  );
});

test("turns retry failures into an error result", () => {
  assert.deepEqual(
    applySessionUpdate(
      [],
      { sessionUpdate: "retry_state", type: "failed", message: "网络错误" },
      undefined,
      dependencies,
    ),
    { timeline: ["error:网络错误"], error: "网络错误" },
  );
});

test("marks a completed turn so the store can leave the running state", () => {
  assert.deepEqual(
    applySessionUpdate(
      ["before"],
      { sessionUpdate: "turn_completed", stopReason: "end_turn" },
      undefined,
      dependencies,
    ),
    { timeline: ["before"], completed: true },
  );
});
