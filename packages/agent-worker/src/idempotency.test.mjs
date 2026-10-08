import assert from "node:assert/strict";
import test from "node:test";

import { IdempotencyLedger, fingerprintCommand } from "./idempotency.ts";

test("accepts one claim and suppresses an identical retry", () => {
  const ledger = new IdempotencyLedger();
  const first = ledger.claim(" turn-1 ", "digest", "run-1");
  const retry = ledger.claim("turn-1", "digest", "run-1-retry");

  assert.equal(first.kind, "accepted");
  assert.equal(retry.kind, "duplicate");
  assert.equal(retry.claim.runId, "run-1");
  assert.equal(ledger.size, 1);
});

test("rejects reuse of a key for a different command", () => {
  const ledger = new IdempotencyLedger();
  ledger.claim("turn-1", "digest-a", "run-1");
  const conflict = ledger.claim("turn-1", "digest-b", "run-2");

  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.claim.runId, "run-1");
});

test("bounds claims with FIFO eviction and fingerprints commands deterministically", () => {
  const ledger = new IdempotencyLedger(2);
  ledger.claim("one", fingerprintCommand({ value: 1 }), "run-1");
  ledger.claim("two", fingerprintCommand({ value: 2 }), "run-2");
  ledger.claim("three", fingerprintCommand({ value: 3 }), "run-3");

  assert.equal(ledger.size, 2);
  assert.equal(
    ledger.claim("one", fingerprintCommand({ value: 1 }), "run-1").kind,
    "accepted",
  );
});
