import assert from "node:assert/strict";
import test from "node:test";

import {
  markPromptResponseReceived,
  markPromptStarted,
  promptResponseDisposition,
  shouldCancelBeforeFirstEvent,
} from "./prompt-timeout.ts";

const timeoutMs = 30_000;

test("cancels only when a prompt has produced no ACP event", () => {
  const pending = { createdAt: 0 };

  assert.equal(
    shouldCancelBeforeFirstEvent(pending, timeoutMs, timeoutMs),
    true,
  );
  assert.equal(
    shouldCancelBeforeFirstEvent(
      markPromptStarted(pending, 1),
      timeoutMs * 10,
      timeoutMs,
    ),
    false,
  );
});

test("preserves the first event timestamp for later progress", () => {
  const pending = { createdAt: 100 };
  const started = markPromptStarted(pending, 200);

  assert.deepEqual(markPromptStarted(started, 300), {
    createdAt: 100,
    firstEventAt: 200,
  });
});

test("keeps a successful prompt acknowledgement running until turn completion", () => {
  const pending = { createdAt: 100 };

  assert.equal(promptResponseDisposition(false, false), "accepted");
  assert.deepEqual(markPromptResponseReceived(pending, 200), {
    createdAt: 100,
    responseReceivedAt: 200,
  });
  assert.equal(promptResponseDisposition(false, true), "duplicate");
});

test("settles a prompt response immediately only when ACP reports an error", () => {
  assert.equal(promptResponseDisposition(true, false), "failed");
});
