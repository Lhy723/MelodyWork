import assert from "node:assert/strict";
import test from "node:test";

import { AgentEventStream } from "./event-stream.ts";

const event = (id, seq, overrides = {}) => ({
  protocolVersion: 1,
  eventId: id,
  sourceEventId: id,
  sessionId: "session-1",
  workerEpoch: "worker-1",
  seq,
  replay: false,
  ...overrides,
  event: {
    type: "message.completed",
    messageId: id,
    role: "assistant",
  },
});

const record = (id, ordinal, seq) => ({
  sessionId: "session-1",
  ordinal,
  eventId: id,
  sourceEventId: id,
  workerEpoch: "worker-1",
  seq,
  event: event(id, seq),
  createdAt: ordinal + 1,
});

test("buffers live events behind replay and flushes them in one checkpoint", async () => {
  const delivered = [];
  let releasePage;
  const page = new Promise((resolve) => {
    releasePage = resolve;
  });
  const stream = new AgentEventStream((value) => delivered.push(value), {
    allowMissingWorkerEpoch: false,
  });

  const replay = stream.replay(
    "session-1",
    async (_sessionId, afterOrdinal) => {
      assert.equal(afterOrdinal, -1);
      await page;
      return [record("persisted", 0, 0)];
    },
  );
  assert.equal(stream.consume(event("live", 1)), false);
  assert.deepEqual(delivered, []);

  releasePage();
  const result = await replay;
  assert.deepEqual(
    delivered.map((value) => [value.eventId, value.replay]),
    [
      ["persisted", true],
      ["live", false],
    ],
  );
  assert.deepEqual(result, { delivered: 1, nextOrdinal: 0, complete: true });
});

test("suppresses a live event that overlaps a replay row", async () => {
  const delivered = [];
  const stream = new AgentEventStream((value) => delivered.push(value), {
    allowMissingWorkerEpoch: false,
  });
  let releasePage;
  const page = new Promise((resolve) => {
    releasePage = resolve;
  });
  const replay = stream.replay("session-1", async () => {
    await page;
    return [record("same", 0, 0)];
  });

  assert.equal(stream.consume(event("same", 0)), false);
  releasePage();
  await replay;
  assert.deepEqual(
    delivered.map((value) => value.eventId),
    ["same"],
  );
  assert.equal(delivered[0].replay, true);
});

test("shares an in-flight replay for the same session", async () => {
  const delivered = [];
  const stream = new AgentEventStream((value) => delivered.push(value), {
    allowMissingWorkerEpoch: false,
  });
  let calls = 0;
  const readPage = async () => {
    calls += 1;
    return [record("once", 0, 0)];
  };
  const first = stream.replay("session-1", readPage);
  const second = stream.replay("session-1", readPage);
  assert.strictEqual(first, second);
  await first;
  assert.equal(calls, 1);
  assert.deepEqual(
    delivered.map((value) => value.eventId),
    ["once"],
  );
});

test("flushes buffered events even when reading the replay fails", async () => {
  const delivered = [];
  const stream = new AgentEventStream((value) => delivered.push(value), {
    allowMissingWorkerEpoch: false,
  });
  const replay = stream.replay("session-1", async () => {
    throw new Error("database unavailable");
  });
  assert.equal(stream.consume(event("after-failure", 0)), false);
  await assert.rejects(replay, /database unavailable/);
  assert.deepEqual(
    delivered.map((value) => value.eventId),
    ["after-failure"],
  );
});
