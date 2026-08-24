import assert from "node:assert/strict";
import test from "node:test";

import { RequestGate } from "./request-gate.ts";

test("only the newest request remains current", () => {
  const gate = new RequestGate();
  const first = gate.begin();
  const second = gate.begin();

  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test("invalidate marks an in-flight request as stale", () => {
  const gate = new RequestGate();
  const request = gate.begin();

  gate.invalidate();

  assert.equal(gate.isCurrent(request), false);
});
