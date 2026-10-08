import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPiRecovery,
  coordinatePiRecovery,
} from "./recovery-coordinator.ts";

const plan = (overrides = {}) => ({
  sessionId: "session-1",
  engine: "pi",
  nativeSessionId: "native-1",
  workerEpoch: "epoch-1",
  lastSeq: 3,
  lastOrdinal: 3,
  eventCount: 4,
  scannedEvents: 4,
  scanComplete: true,
  activeRuns: [],
  pendingTools: [],
  pendingInteractions: [],
  activeTasks: [],
  activeMessages: [],
  compactionInProgress: false,
  recommendedAction: "replay",
  reasons: [],
  ...overrides,
});

test("allows replay only for a complete terminal summary", () => {
  assert.equal(classifyPiRecovery(plan()), "replay");
  assert.equal(classifyPiRecovery(plan({ scanComplete: false })), "manual");
  assert.equal(
    classifyPiRecovery(
      plan({
        activeRuns: [{ runId: "run-1", status: "running" }],
      }),
    ),
    "manual",
  );
});

test("does not perform work for clean or non-applicable sessions", () => {
  assert.equal(
    classifyPiRecovery(plan({ recommendedAction: "clean" })),
    "noop",
  );
  assert.equal(
    classifyPiRecovery(plan({ recommendedAction: "not-applicable" })),
    "noop",
  );
});

test("maps blocked and reconcile recommendations to manual handling", () => {
  assert.equal(
    classifyPiRecovery(plan({ recommendedAction: "blocked" })),
    "manual",
  );
  assert.equal(
    classifyPiRecovery(plan({ recommendedAction: "reconcile" })),
    "manual",
  );
});

test("coordinates replay through the injected bounded log reader", async () => {
  const inspected = [];
  const replayed = [];
  const result = await coordinatePiRecovery(
    "session-1",
    (event) => replayed.push(event),
    { afterOrdinal: 4, pageSize: 32, maxEvents: 64 },
    {
      inspect: async (sessionId) => {
        inspected.push(sessionId);
        return plan();
      },
      replay: async (sessionId, onEvent, options) => {
        assert.equal(sessionId, "session-1");
        assert.deepEqual(options, {
          afterOrdinal: 4,
          pageSize: 32,
          maxEvents: 64,
        });
        onEvent({ eventId: "event-1" });
        return { delivered: 1, nextOrdinal: 5, complete: true };
      },
    },
  );
  assert.deepEqual(inspected, ["session-1"]);
  assert.deepEqual(replayed, [{ eventId: "event-1" }]);
  assert.equal(result.action, "replay");
  assert.deepEqual(result.replay, {
    delivered: 1,
    nextOrdinal: 5,
    complete: true,
  });
});

test("does not invoke replay for manual reconciliation and rejects mismatched plans", async () => {
  let replayCalls = 0;
  const dependencies = {
    inspect: async () => plan({ recommendedAction: "reconcile" }),
    replay: async () => {
      replayCalls += 1;
      return { delivered: 0, nextOrdinal: -1, complete: true };
    },
  };
  const manual = await coordinatePiRecovery(
    "session-1",
    () => undefined,
    {},
    dependencies,
  );
  assert.equal(manual.action, "manual");
  assert.equal(replayCalls, 0);

  await assert.rejects(
    coordinatePiRecovery(
      "session-1",
      () => undefined,
      {},
      {
        ...dependencies,
        inspect: async () => plan({ sessionId: "session-2" }),
      },
    ),
    /另一个会话/u,
  );
});
