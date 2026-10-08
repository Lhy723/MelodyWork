import assert from "node:assert/strict";
import test from "node:test";

import { adaptLegacyAcpMessage } from "./legacy-acp-adapter.ts";

test("maps legacy streamed assistant text to a product delta", () => {
  const [event] = adaptLegacyAcpMessage(
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "你好" },
        },
        _meta: { eventId: "legacy-event-1" },
      },
    },
    1,
  );

  assert.deepEqual(event, {
    protocolVersion: 1,
    eventId: "legacy-event-1",
    sourceEventId: "legacy-event-1",
    sessionId: "session-1",
    replay: false,
    event: {
      type: "message.delta",
      messageId: "legacy-1-assistant",
      partId: "legacy-1-part",
      text: "你好",
      offset: 0,
    },
  });
});

test("emits usage before a completed run without manufacturing zero usage", () => {
  const events = adaptLegacyAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-2",
      update: {
        sessionUpdate: "turn_completed",
        usage: { inputTokens: 11, outputTokens: 7, modelCalls: 1 },
      },
    },
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].event.type, "usage.updated");
  assert.equal(events[1].event.type, "run.finished");
  assert.equal(events[1].event.status, "completed");
  assert.notEqual(events[0].eventId, events[1].eventId);
  assert.equal(events[0].sourceEventId, events[1].sourceEventId);
});

test("keeps unknown legacy messages visible to migration diagnostics", () => {
  const [event] = adaptLegacyAcpMessage(
    { jsonrpc: "2.0", method: "session/new", params: { cwd: "/tmp" } },
    8,
  );
  assert.equal(event.event.type, "protocol.unhandled");
  assert.equal(event.event.method, "session/new");
  assert.equal(event.eventId, "legacy-8");
});

test("normalizes permission, plan, and question interactions", () => {
  for (const [method, kind] of [
    ["session/request_permission", "permission"],
    ["x.ai/exit_plan_mode", "plan"],
    ["x.ai/ask_user_question", "question"],
  ]) {
    const [event] = adaptLegacyAcpMessage({
      jsonrpc: "2.0",
      id: 10,
      method,
      params: { sessionId: "session-4" },
    });
    assert.equal(event.event.type, "interaction.requested");
    assert.equal(event.event.kind, kind);
    assert.equal(
      event.event.interactionId,
      kind === "plan" ? "legacy-0" : "10",
    );
  }
});
