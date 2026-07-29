import assert from "node:assert/strict";
import test from "node:test";

import {
  isSessionUpdateMethod,
  SessionEventDeduplicator,
  TIMELINE_PROJECTION_VERSION,
  notificationMetadata,
  timelineProjectionVersion,
  usableTimelineProjection,
} from "./session-projection.ts";

const timeline = [
  {
    id: "user-1",
    kind: "message",
    role: "user",
    content: "你好",
  },
];

test("only restores a projection with the current version and a cursor", () => {
  const timelineJson = JSON.stringify(timeline);
  assert.deepEqual(
    usableTimelineProjection({
      timelineJson,
      cursor: "session-7",
      version: TIMELINE_PROJECTION_VERSION,
    }),
    timeline,
  );
  assert.deepEqual(
    usableTimelineProjection({
      timelineJson,
      version: TIMELINE_PROJECTION_VERSION,
    }),
    [],
  );
  assert.deepEqual(
    usableTimelineProjection({
      timelineJson,
      cursor: "session-7",
      version: TIMELINE_PROJECTION_VERSION - 1,
    }),
    [],
  );
});

test("recognizes live and durable Melody session update rails", () => {
  for (const method of [
    "session/update",
    "_x.ai/session/update",
    "x.ai/session/update",
    "_x.ai/session_notification",
    "x.ai/session_notification",
  ]) {
    assert.equal(isSessionUpdateMethod(method), true, method);
  }
  assert.equal(isSessionUpdateMethod("session/request_permission"), false);
  assert.equal(isSessionUpdateMethod(undefined), false);
});

test("does not mark legacy tool rows as a current projection", () => {
  assert.equal(
    timelineProjectionVersion([{
      id: "tool-legacy",
      kind: "tool",
      title: "Edit file",
      command: "src/app.ts",
      output: "",
    }]),
    TIMELINE_PROJECTION_VERSION - 1,
  );
  assert.equal(
    timelineProjectionVersion([{
      id: "tool-current",
      kind: "tool",
      title: "Edit file",
      command: "src/app.ts",
      output: "",
      activity: { operation: "edit" },
    }]),
    TIMELINE_PROJECTION_VERSION,
  );
});

test("replays an orphaned stream but preserves an active stream", () => {
  const streamingTimeline = [{
    id: "assistant-streaming",
    kind: "message",
    role: "assistant",
    content: "已经完成的内容",
    streaming: true,
  }];
  assert.equal(
    timelineProjectionVersion(streamingTimeline),
    TIMELINE_PROJECTION_VERSION - 1,
  );
  assert.equal(
    timelineProjectionVersion(streamingTimeline, true),
    TIMELINE_PROJECTION_VERSION,
  );
});

test("reads the Melody Build replay and cursor metadata", () => {
  assert.deepEqual(
    notificationMetadata({
      _meta: { eventId: "session-8", isReplay: true },
    }),
    { eventId: "session-8", isReplay: true },
  );
});

test("applies an event id once per session without comparing counters", () => {
  const events = new SessionEventDeduplicator(2);
  assert.equal(events.accept("s1", "s1-9"), true);
  assert.equal(events.accept("s1", "s1-9"), false);
  assert.equal(events.accept("s1", "s1-2"), true);
  assert.equal(events.accept("s2", "s1-9"), true);
  assert.equal(events.accept("s1", "s1-3"), true);
  assert.equal(events.accept("s1", "s1-9"), true);
});
