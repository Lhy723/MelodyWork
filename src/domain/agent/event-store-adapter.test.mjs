import assert from "node:assert/strict";
import test from "node:test";

import { AgentEventStoreAdapter } from "./event-store-adapter.ts";

const envelope = (id, event, overrides = {}) => ({
  protocolVersion: 1,
  eventId: id,
  sessionId: "session-1",
  replay: false,
  ...overrides,
  event,
});

const snapshot = (overrides = {}) => ({
  currentSessionId: "session-1",
  timeline: [],
  backgroundTimelines: {},
  backgroundCursors: {},
  backgroundContextUsage: {},
  subagents: {},
  availableModels: [],
  ...overrides,
});

test("keeps a projector per product session and routes a complete turn", () => {
  const adapter = new AgentEventStoreAdapter();
  let state = snapshot();

  const started = adapter.consume(
    envelope("start", { type: "run.started" }),
    state,
  );
  assert.equal(started.patch.chatStatus, "streaming");
  state = { ...state, timeline: started.patch.timeline };

  const delta = adapter.consume(
    envelope("delta", {
      type: "message.delta",
      messageId: "assistant-1",
      partId: "text-0",
      text: "完成",
      offset: 0,
    }),
    state,
  );
  state = { ...state, timeline: delta.patch.timeline };
  const finished = adapter.consume(
    envelope("finish", { type: "run.finished", status: "completed" }),
    state,
  );

  assert.equal(adapter.size(), 1);
  assert.equal(finished.patch.chatStatus, "ready");
  assert.equal(finished.patch.acpPhase, "ready");
  assert.equal(finished.patch.timeline.at(-1).streaming, false);
});

test("starts a bounded projector for background sessions without touching current UI", () => {
  const adapter = new AgentEventStoreAdapter({ maxSessions: 2 });
  const current = snapshot();
  const result = adapter.consume(
    envelope(
      "background",
      {
        type: "message.delta",
        messageId: "assistant-2",
        partId: "text-0",
        text: "后台",
        offset: 0,
      },
      { sessionId: "session-2" },
    ),
    current,
  );

  assert.equal(result.patch.timeline, undefined);
  assert.equal(
    result.patch.backgroundTimelines["session-2"].at(-1).content,
    "后台",
  );

  adapter.consume(
    envelope("s3", { type: "run.started" }, { sessionId: "session-3" }),
    current,
  );
  adapter.consume(
    envelope("s4", { type: "run.started" }, { sessionId: "session-4" }),
    current,
  );
  assert.equal(adapter.size(), 2);
});

test("reset drops one session projector or all projectors", () => {
  const adapter = new AgentEventStoreAdapter();
  const current = snapshot();
  adapter.consume(
    envelope("one", { type: "run.started" }, { sessionId: "session-1" }),
    current,
  );
  adapter.consume(
    envelope("two", { type: "run.started" }, { sessionId: "session-2" }),
    current,
  );
  assert.equal(adapter.size(), 2);

  adapter.reset("session-1");
  assert.equal(adapter.size(), 1);
  adapter.reset();
  assert.equal(adapter.size(), 0);
});
