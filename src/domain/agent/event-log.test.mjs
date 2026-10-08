import assert from "node:assert/strict";
import test from "node:test";

import {
  asReplayAgentEvent,
  parseAgentEventLogRecord,
  replayAgentEventLog,
} from "./event-log.ts";

const record = (ordinal, overrides = {}) => ({
  sessionId: "session-1",
  ordinal,
  eventId: `event-${ordinal}`,
  workerEpoch: "worker-1",
  seq: ordinal,
  createdAt: 100 + ordinal,
  event: {
    protocolVersion: 1,
    eventId: `event-${ordinal}`,
    sessionId: "session-1",
    workerEpoch: "worker-1",
    seq: ordinal,
    replay: false,
    event: {
      type: "message.delta",
      messageId: "message-1",
      partId: `part-${ordinal}`,
      text: "你好",
      offset: ordinal,
    },
  },
  ...overrides,
});

test("validates a record and marks only delivery metadata as replay", () => {
  const parsed = parseAgentEventLogRecord(record(2));
  const replay = asReplayAgentEvent(parsed);
  assert.equal(replay.replay, true);
  assert.equal(replay.eventId, "event-2");
  assert.equal(replay.seq, 2);
  assert.equal(parsed.event.replay, false);
});

test("rejects mismatched identity and malformed ordering", async () => {
  assert.throws(
    () =>
      parseAgentEventLogRecord(
        record(0, {
          event: { ...record(0).event, eventId: "other" },
        }),
      ),
    /eventId.*不一致/u,
  );

  await assert.rejects(
    () =>
      replayAgentEventLog(
        "session-1",
        async () => [record(1), record(1)],
        () => undefined,
      ),
    /ordinal.*严格递增/u,
  );
});

test("replays pages with a cursor and reports a bounded result", async () => {
  const pages = new Map([
    [-1, [record(0), record(1)]],
    [1, [record(2)]],
  ]);
  const seen = [];
  const result = await replayAgentEventLog(
    "session-1",
    async (_sessionId, afterOrdinal, limit) => {
      assert.ok(limit <= 2);
      return pages.get(afterOrdinal) ?? [];
    },
    (event) => seen.push(event),
    { pageSize: 2, maxEvents: 2 },
  );
  assert.deepEqual(result, {
    delivered: 2,
    nextOrdinal: 1,
    complete: false,
  });
  assert.deepEqual(
    seen.map((event) => [event.eventId, event.replay]),
    [
      ["event-0", true],
      ["event-1", true],
    ],
  );
});

test("finishes when the final page is shorter than its requested limit", async () => {
  const seen = [];
  const result = await replayAgentEventLog(
    "session-1",
    async () => [record(4)],
    (event) => seen.push(event.eventId),
    { pageSize: 2 },
  );
  assert.deepEqual(result, { delivered: 1, nextOrdinal: 4, complete: true });
  assert.deepEqual(seen, ["event-4"]);
});
