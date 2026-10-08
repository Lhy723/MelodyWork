import assert from "node:assert/strict";
import test from "node:test";

import { AgentEventProjector } from "./event-projector.ts";

const envelope = (id, event, overrides = {}) => ({
  protocolVersion: 1,
  eventId: id,
  sessionId: "session-1",
  replay: false,
  ...overrides,
  event,
});

test("publishes projection results and advances the state", () => {
  const results = [];
  const projector = new AgentEventProjector((result) => results.push(result), {
    expectedSessionId: "session-1",
  });

  const result = projector.consume(
    envelope("delta-1", {
      type: "message.delta",
      messageId: "assistant-1",
      partId: "text-0",
      text: "你好",
      offset: 0,
    }),
  );

  assert.equal(results.length, 1);
  assert.equal(results[0], result);
  assert.equal(projector.getState().timeline.at(-1).content, "你好");
  assert.equal(
    projector.getState().messageTimelineIds.get("assistant-1"),
    "assistant-delta-1",
  );
});

test("reset keeps the rendered timeline but clears run-local tracking", () => {
  const projector = new AgentEventProjector(undefined, {
    expectedSessionId: "session-1",
  });
  projector.consume(
    envelope("delta-1", {
      type: "message.delta",
      messageId: "assistant-1",
      partId: "text-0",
      text: "保留",
      offset: 0,
    }),
  );
  projector.consume(
    envelope("usage-1", {
      type: "usage.updated",
      usage: { inputTokens: 4, outputTokens: 2 },
    }),
  );

  const timeline = projector.getState().timeline;
  projector.reset();
  const state = projector.getState();

  assert.equal(state.timeline, timeline);
  assert.equal(state.messageTimelineIds.size, 0);
  assert.equal(state.deltaOffsets.size, 0);
  assert.equal(state.latestUsage, undefined);
});

test("reset clears replayed subagent state with other run-local tracking", () => {
  const projector = new AgentEventProjector(undefined, {
    expectedSessionId: "session-1",
  });
  projector.consume(
    envelope("subagent-1", {
      type: "subagent.changed",
      taskId: "child-task",
      status: "running",
      childSessionId: "child-session",
    }),
  );
  assert.equal(projector.getState().subagents.size, 1);

  projector.reset();

  assert.equal(projector.getState().subagents.size, 0);
});

test("keeps diagnostics observable without mutating the timeline", () => {
  const results = [];
  const projector = new AgentEventProjector((result) => results.push(result), {
    expectedSessionId: "session-1",
  });
  const before = projector.getState();

  const result = projector.consume(
    envelope(
      "foreign",
      {
        type: "message.delta",
        messageId: "foreign-message",
        partId: "text-0",
        text: "忽略",
        offset: 0,
      },
      { sessionId: "session-2" },
    ),
  );

  assert.equal(result.ignored, true);
  assert.equal(result.diagnostic.kind, "session-mismatch");
  assert.equal(results[0], result);
  assert.equal(projector.getState().timeline, before.timeline);
});

test("resets transient replay state once while retaining the rendered timeline", () => {
  const projector = new AgentEventProjector(undefined, {
    expectedSessionId: "session-1",
  });
  projector.consume(
    envelope("live-1", {
      type: "message.delta",
      messageId: "assistant-1",
      partId: "text-0",
      text: "实时",
      offset: 0,
    }),
  );

  const replayed = projector.consume(
    envelope(
      "replay-1",
      {
        type: "message.delta",
        messageId: "assistant-1",
        partId: "text-0",
        text: "重放",
        offset: 0,
      },
      { replay: true },
    ),
  );
  assert.equal(replayed.diagnostic, undefined);
  assert.equal(projector.getState().timeline.at(-1).content, "实时重放");

  const replayContinuation = projector.consume(
    envelope(
      "replay-2",
      {
        type: "message.delta",
        messageId: "assistant-1",
        partId: "text-0",
        text: "内容",
        offset: 2,
      },
      { replay: true },
    ),
  );
  assert.equal(replayContinuation.diagnostic, undefined);
  assert.equal(projector.getState().timeline.at(-1).content, "实时重放内容");
});

test("keeps session-scoped subagents visible while replay resets run state", () => {
  const projector = new AgentEventProjector(undefined, {
    expectedSessionId: "session-1",
  });
  projector.consume(
    envelope("subagent-live", {
      type: "subagent.changed",
      taskId: "child-task",
      status: "running",
      childSessionId: "child-session",
    }),
  );

  projector.consume(
    envelope(
      "replay-start",
      {
        type: "run.started",
      },
      { replay: true },
    ),
  );

  assert.equal(projector.getState().subagents.size, 1);
});
