import test from "node:test";
import assert from "node:assert/strict";
import { emptyPiRecoveryPlan, parsePiRecoveryPlan } from "./recovery.ts";

const basePlan = {
  sessionId: "session-1",
  engine: "pi",
  nativeSessionId: "native-1",
  workerEpoch: "epoch-1",
  lastSeq: 9,
  lastOrdinal: 9,
  eventCount: 10,
  scannedEvents: 10,
  scanComplete: true,
  activeRuns: [],
  pendingTools: [],
  pendingInteractions: [],
  activeTasks: [],
  activeMessages: [],
  compactionInProgress: false,
  recommendedAction: "replay",
  reasons: [],
};

test("validates the bounded payload-free recovery summary", () => {
  const plan = parsePiRecoveryPlan({
    ...basePlan,
    pendingTools: [
      {
        toolCallId: "tool-1",
        toolName: "workspace_read_file",
        runId: "run-1",
        status: "pending",
      },
    ],
    pendingInteractions: [
      { interactionId: "interaction-1", kind: "permission", runId: "run-1" },
    ],
  });
  assert.equal(plan.recommendedAction, "replay");
  assert.equal(plan.pendingTools[0].toolCallId, "tool-1");
  assert.equal(plan.pendingInteractions[0].kind, "permission");
});

test("rejects malformed or unbounded recovery output", () => {
  assert.throws(
    () =>
      parsePiRecoveryPlan({
        ...basePlan,
        eventCount: -1,
      }),
    /eventCount/,
  );
  assert.throws(
    () =>
      parsePiRecoveryPlan({
        ...basePlan,
        activeRuns: new Array(4097).fill({
          runId: "run-1",
          status: "running",
        }),
      }),
    /activeRuns/,
  );
  assert.throws(
    () =>
      parsePiRecoveryPlan({
        ...basePlan,
        recommendedAction: "execute",
      }),
    /动作/,
  );
});

test("browser fallback is explicitly not applicable", () => {
  const plan = emptyPiRecoveryPlan("session-1");
  assert.equal(plan.recommendedAction, "not-applicable");
  assert.equal(plan.scanComplete, true);
  assert.deepEqual(plan.activeRuns, []);
});
