import assert from "node:assert/strict";
import test from "node:test";

import {
  settlePlanApproval,
  upsertPlanApproval,
} from "./plan-approval.ts";

test("adds and settles a plan approval request", () => {
  const awaiting = upsertPlanApproval([], {
    content: "# Plan\n\n1. Inspect",
    requestId: 41,
    toolCallId: "exit-plan-1",
  });
  assert.equal(awaiting[0].kind, "plan");
  assert.equal(awaiting[0].status, "awaiting-approval");
  assert.equal(awaiting[0].requestId, 41);

  const approved = settlePlanApproval(
    awaiting,
    "plan-exit-plan-1",
    "approved",
  );
  assert.equal(approved[0].status, "approved");
  assert.equal(approved[0].requestId, undefined);
});

test("supersedes a stale approval when Melody re-parks the plan", () => {
  const first = upsertPlanApproval([], {
    content: "Old plan",
    requestId: 1,
    toolCallId: "old",
  });
  const replayed = upsertPlanApproval(first, {
    content: "Current plan",
    requestId: 2,
    toolCallId: "resume",
  });

  assert.equal(replayed[0].status, "superseded");
  assert.equal(replayed[0].requestId, undefined);
  assert.equal(replayed[1].status, "awaiting-approval");
});
