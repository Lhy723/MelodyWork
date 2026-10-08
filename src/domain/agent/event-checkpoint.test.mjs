import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptAgentEvent,
  createAgentEventCheckpoint,
  resetAgentEventCheckpoint,
} from "./event-checkpoint.ts";

const event = (overrides = {}) => ({
  protocolVersion: 1,
  eventId: "event-1",
  sessionId: "session-1",
  replay: false,
  ...overrides,
  event: {
    type: "message.completed",
    messageId: "message-1",
    role: "assistant",
  },
});

test("accepts monotonic events and advances the cursor immutably", () => {
  const initial = createAgentEventCheckpoint("worker-1");
  const result = acceptAgentEvent(
    initial,
    event({ workerEpoch: "worker-1", seq: 0 }),
  );

  assert.equal(result.accepted, true);
  assert.equal(result.reason, "accepted");
  assert.equal(result.checkpoint.lastSeq, 0);
  assert.deepEqual(initial, createAgentEventCheckpoint("worker-1"));
});

test("suppresses duplicate event IDs even when a replay has no sequence", () => {
  const initial = createAgentEventCheckpoint();
  const first = acceptAgentEvent(initial, event());
  const duplicate = acceptAgentEvent(first.checkpoint, event({ replay: true }));

  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, "duplicate");
  assert.deepEqual(duplicate.checkpoint, first.checkpoint);
});

test("rejects stale generations and non-monotonic sequences", () => {
  const initial = createAgentEventCheckpoint("worker-2");
  const stale = acceptAgentEvent(
    initial,
    event({ eventId: "stale", workerEpoch: "worker-1", seq: 8 }),
  );
  assert.equal(stale.reason, "stale-worker");

  const accepted = acceptAgentEvent(
    initial,
    event({ eventId: "current", workerEpoch: "worker-2", seq: 8 }),
  );
  const old = acceptAgentEvent(
    accepted.checkpoint,
    event({ eventId: "old", workerEpoch: "worker-2", seq: 7 }),
  );
  assert.equal(old.reason, "out-of-order");
  assert.equal(old.checkpoint.lastSeq, 8);
});

test("requires an epoch after a worker restart unless legacy mode is explicit", () => {
  const checkpoint = createAgentEventCheckpoint("worker-3");
  const missing = acceptAgentEvent(
    checkpoint,
    event({ eventId: "without-epoch", seq: 1 }),
  );
  assert.equal(missing.reason, "missing-worker-epoch");

  const legacy = acceptAgentEvent(
    checkpoint,
    event({ eventId: "legacy", seq: 1 }),
    { allowMissingWorkerEpoch: true },
  );
  assert.equal(legacy.accepted, true);
  assert.equal(legacy.checkpoint.workerEpoch, "worker-3");
});

test("bounds replay memory while retaining the newest IDs", () => {
  let checkpoint = createAgentEventCheckpoint();
  for (const id of ["one", "two", "three"]) {
    checkpoint = acceptAgentEvent(checkpoint, event({ eventId: id }), {
      maxEventIds: 2,
    }).checkpoint;
  }
  assert.deepEqual(checkpoint.eventIds, ["two", "three"]);
  assert.equal(
    acceptAgentEvent(checkpoint, event({ eventId: "one" }), { maxEventIds: 2 })
      .accepted,
    true,
  );
});

test("resetting a worker generation clears the old sequence and IDs", () => {
  const checkpoint = acceptAgentEvent(
    createAgentEventCheckpoint("worker-1"),
    event({ workerEpoch: "worker-1", seq: 9 }),
  ).checkpoint;
  const reset = resetAgentEventCheckpoint(checkpoint, "worker-2");
  assert.deepEqual(reset, {
    workerEpoch: "worker-2",
    lastSeq: -1,
    eventIds: [],
  });
});
