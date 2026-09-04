import assert from "node:assert/strict";
import test from "node:test";

import {
  applySessionUpdate,
  contextUsageFromTimeline,
  contextUsageFromTotalTokens,
  isPromptCompleteMethod,
  isSessionUpdateMethod,
  parseTimelineProjection,
  readTimelineProjection,
  projectPermissionRequest,
  SessionEventDeduplicator,
  stampLatestTurnContextUsage,
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

test("isolates malformed timeline rows from cursor-based restoration", () => {
  const malformed = JSON.stringify([
    timeline[0],
    { id: "broken", kind: "message", role: "assistant" },
  ]);
  assert.deepEqual(parseTimelineProjection(malformed), timeline);
  assert.deepEqual(readTimelineProjection(malformed), {
    timeline,
    status: "corrupt",
  });
  assert.deepEqual(
    usableTimelineProjection({
      timelineJson: malformed,
      cursor: "session-7",
      version: TIMELINE_PROJECTION_VERSION,
    }),
    [],
  );
  assert.deepEqual(readTimelineProjection("not-json"), {
    timeline: [],
    status: "corrupt",
  });
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
  for (const method of [
    "x.ai/session/prompt_complete",
    "_x.ai/session/prompt_complete",
  ]) {
    assert.equal(isPromptCompleteMethod(method), true, method);
  }
  assert.equal(isPromptCompleteMethod("session/update"), false);
  assert.equal(isPromptCompleteMethod(undefined), false);
});

test("does not mark legacy tool rows as a current projection", () => {
  assert.equal(
    timelineProjectionVersion([
      {
        id: "tool-legacy",
        kind: "tool",
        title: "Edit file",
        command: "src/app.ts",
        output: "",
      },
    ]),
    TIMELINE_PROJECTION_VERSION - 1,
  );
  assert.equal(
    timelineProjectionVersion([
      {
        id: "tool-current",
        kind: "tool",
        title: "Edit file",
        command: "src/app.ts",
        output: "",
        activity: { operation: "edit" },
      },
    ]),
    TIMELINE_PROJECTION_VERSION,
  );
});

test("replays an orphaned stream but preserves an active stream", () => {
  const streamingTimeline = [
    {
      id: "assistant-streaming",
      kind: "message",
      role: "assistant",
      content: "已经完成的内容",
      streaming: true,
    },
  ];
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
  assert.deepEqual(
    notificationMetadata({
      meta: { event_id: "session-9", is_replay: true, prompt_id: "p-9" },
    }),
    { eventId: "session-9", isReplay: true, promptId: "p-9" },
  );
  assert.deepEqual(
    notificationMetadata({
      _meta: { eventId: "session-10", totalTokens: 42 },
    }),
    { eventId: "session-10", isReplay: false, totalTokens: 42 },
  );
});

test("restores context usage from persisted turn metadata", () => {
  const timeline = [
    { id: "user-1", kind: "message", role: "user", content: "first" },
    {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      content: "done",
      tokenUsage: { usedTokens: 120, maxTokens: 1_000 },
    },
  ];
  assert.deepEqual(contextUsageFromTimeline(timeline), {
    usedTokens: 120,
    maxTokens: 1_000,
  });
  assert.deepEqual(
    contextUsageFromTotalTokens(240, { usedTokens: 0, maxTokens: 1_000 }),
    { usedTokens: 240, maxTokens: 1_000 },
  );
  assert.equal(
    contextUsageFromTotalTokens(240, { usedTokens: 0, maxTokens: 0 }),
    undefined,
  );
});

test("stamps the latest completed assistant turn with context usage", () => {
  const timeline = [
    { id: "user-1", kind: "message", role: "user", content: "go" },
    {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      content: "done",
    },
  ];
  assert.deepEqual(
    stampLatestTurnContextUsage(timeline, {
      usedTokens: 120,
      maxTokens: 1_000,
    }),
    [
      timeline[0],
      {
        ...timeline[1],
        tokenUsage: { usedTokens: 120, maxTokens: 1_000 },
      },
    ],
  );
});

test("keeps context usage when a turn has no assistant message yet", () => {
  const timeline = [
    { id: "user-1", kind: "message", role: "user", content: "go" },
  ];
  const stamped = stampLatestTurnContextUsage(timeline, {
    usedTokens: 64,
    maxTokens: 1_000,
  });
  assert.deepEqual(contextUsageFromTimeline(stamped), {
    usedTokens: 64,
    maxTokens: 1_000,
  });
  assert.deepEqual(stamped[0].tokenUsage, {
    usedTokens: 64,
    maxTokens: 1_000,
  });
});

test("preserves the prompt id used to ignore late cancelled events", () => {
  assert.deepEqual(
    notificationMetadata({
      _meta: { eventId: "turn-3", promptId: "melody-work-session-101" },
    }),
    {
      eventId: "turn-3",
      isReplay: false,
      promptId: "melody-work-session-101",
    },
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

test("bounds the number of sessions retained by the deduplicator", () => {
  const events = new SessionEventDeduplicator(2, 2);
  assert.equal(events.accept("s1", "event-1"), true);
  assert.equal(events.accept("s2", "event-2"), true);
  assert.equal(events.accept("s3", "event-3"), true);
  assert.equal(events.accept("s1", "event-1"), true);
});

test("projects and coalesces assistant chunks through the real interface", () => {
  const first = applySessionUpdate([], {
    sessionUpdate: "agent_message_chunk",
    content: { text: "hello" },
  });
  const second = applySessionUpdate(first.timeline, {
    sessionUpdate: "agent_message_chunk",
    content: { text: " world" },
  });

  assert.equal(first.streaming, true);
  assert.equal(second.streaming, true);
  assert.equal(second.timeline.length, 1);
  assert.deepEqual(
    {
      kind: second.timeline[0].kind,
      role: second.timeline[0].role,
      content: second.timeline[0].content,
      streaming: second.timeline[0].streaming,
    },
    {
      kind: "message",
      role: "assistant",
      content: "hello world",
      streaming: true,
    },
  );
});

test("accepts snake-case ACP updates and array content blocks", () => {
  const result = applySessionUpdate([], {
    session_update: "agent_message_chunk",
    content: [{ type: "text", text: "hello" }],
  });

  assert.equal(result.streaming, true);
  assert.equal(result.timeline[0].content, "hello");
});

test("settles an assistant stream when thought projection starts", () => {
  const assistant = applySessionUpdate([], {
    sessionUpdate: "agent_message_chunk",
    content: { text: "answer" },
  });
  const thought = applySessionUpdate(assistant.timeline, {
    sessionUpdate: "agent_thought_chunk",
    content: { text: "checking" },
  });

  assert.equal(thought.timeline[0].streaming, false);
  assert.equal(typeof thought.timeline[0].completedAt, "number");
  assert.deepEqual(
    {
      kind: thought.timeline[1].kind,
      content: thought.timeline[1].content,
      streaming: thought.timeline[1].streaming,
    },
    { kind: "thought", content: "checking", streaming: true },
  );
});

test("keeps assistant message keys unique when a stream resumes after activity", () => {
  const first = applySessionUpdate(
    [],
    {
      sessionUpdate: "agent_message_chunk",
      content: { text: "first" },
    },
    "message-1",
  );
  const withThought = applySessionUpdate(
    first.timeline,
    {
      sessionUpdate: "agent_thought_chunk",
      content: { text: "checking" },
    },
    "thought-1",
  );
  const resumed = applySessionUpdate(
    withThought.timeline,
    {
      sessionUpdate: "agent_message_chunk",
      content: { text: "second" },
    },
    "message-2",
  );

  assert.equal(resumed.timeline.at(-1).id, "assistant-message-2");
  assert.notEqual(resumed.timeline[0].id, resumed.timeline.at(-1).id);
});

test("normalizes user chunks and honors projection metadata", () => {
  const visible = applySessionUpdate(
    [],
    {
      sessionUpdate: "user_message_chunk",
      content: { text: "wire", _meta: { displayText: "visible" } },
      _meta: { promptIndex: 2 },
    },
    "event-7",
  );
  const hidden = applySessionUpdate(visible.timeline, {
    sessionUpdate: "user_message_chunk",
    content: { text: "internal" },
    _meta: { hideFromScrollback: true },
  });

  assert.deepEqual(
    {
      id: visible.timeline[0].id,
      content: visible.timeline[0].content,
      sourcePromptIndex: visible.timeline[0].sourcePromptIndex,
    },
    { id: "user-event-7", content: "visible", sourcePromptIndex: 2 },
  );
  assert.strictEqual(hidden.timeline, visible.timeline);
});

test("normalizes and updates tool activity without losing prior fields", () => {
  const started = applySessionUpdate([], {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Run check",
    rawInput: { command: "pnpm check" },
    status: "running",
  });
  const completed = applySessionUpdate(started.timeline, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    rawOutput: "ok",
    status: "completed",
  });
  const tool = completed.timeline[0];

  assert.equal(tool.kind, "tool");
  assert.equal(tool.title, "Run check");
  assert.equal(tool.command, "pnpm check");
  assert.equal(tool.output, "ok");
  assert.equal(tool.status, "completed");
  assert.equal(typeof tool.completedAt, "number");
});

test("settles a completed turn and stamps normalized billing usage", () => {
  const timeline = [
    { id: "user-1", kind: "message", role: "user", content: "go" },
    {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      content: "done",
      streaming: true,
    },
  ];
  const result = applySessionUpdate(timeline, {
    sessionUpdate: "turn_completed",
    stopReason: "end_turn",
    usage: { inputTokens: 12, outputTokens: 5, modelCalls: 1 },
  });
  const assistant = result.timeline[1];

  assert.equal(result.completed, true);
  assert.equal(assistant.streaming, false);
  assert.deepEqual(assistant.billingUsage, {
    inputTokens: 12,
    outputTokens: 5,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    modelCalls: 1,
    apiDurationMs: 0,
    usageIsIncomplete: false,
    costIsPartial: false,
  });
});

test("settles a turn from snake-case completion fields and terminal result", () => {
  const result = applySessionUpdate(
    [{ id: "user-1", kind: "message", role: "user", content: "go" }],
    {
      session_update: "turn_completed",
      stop_reason: "end_turn",
      agent_result: "done",
    },
  );

  assert.equal(result.completed, true);
  assert.equal(result.timeline.at(-1).role, "assistant");
  assert.equal(result.timeline.at(-1).content, "done");
});

test("shows a visible fallback when a turn completes without an answer", () => {
  const result = applySessionUpdate(
    [{ id: "user-1", kind: "message", role: "user", content: "go" }],
    { sessionUpdate: "turn_completed", stopReason: "end_turn" },
  );

  assert.equal(result.completed, true);
  assert.equal(
    result.timeline.at(-1).content,
    "本轮已完成，但没有返回可显示的文本。",
  );
});

test("projects failures and permission requests as observable timeline state", () => {
  const failure = applySessionUpdate([], {
    sessionUpdate: "retry_state",
    type: "failed",
    message: "network error",
  });
  const permission = projectPermissionRequest(
    [],
    {
      title: "Edit file",
      rawInput: { path: "src/app.ts" },
    },
    41,
    [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  );

  assert.equal(failure.error, "network error");
  assert.equal(
    failure.timeline[0].content,
    "Melody 无法完成请求：network error",
  );
  assert.equal(permission.toolCallId, "permission-41");
  assert.equal(permission.title, "Edit file");
  assert.equal(permission.command, "src/app.ts");
  assert.equal(permission.timeline[0].permission, "pending");
  assert.equal(permission.timeline[0].permissionRequestId, 41);
});

test("surfaces retry exhaustion instead of silently ending the turn", () => {
  const retrying = applySessionUpdate(
    [{ id: "user-1", kind: "message", role: "user", content: "skills" }],
    {
      session_update: "retry_state",
      type: "retrying",
      reason:
        "API error (status 429 Too Many Requests): inference tpm exhausted",
    },
  );
  const exhausted = applySessionUpdate(retrying.timeline, {
    session_update: "retry_state",
    type: "exhausted",
    reason: "API error (status 429 Too Many Requests): inference tpm exhausted",
    is_rate_limited: true,
  });

  assert.equal(retrying.statusMessage, "模型请求受到限流，正在重试…");
  assert.equal(exhausted.completed, true);
  assert.equal(
    exhausted.error,
    "模型请求受到限流（TPM），请稍后再试或切换模型。",
  );
  assert.equal(
    exhausted.timeline.at(-1).content,
    "Melody 无法完成请求：模型请求受到限流（TPM），请稍后再试或切换模型。",
  );
});

test("treats rate-limit turn completion as a visible terminal error", () => {
  const result = applySessionUpdate(
    [{ id: "user-1", kind: "message", role: "user", content: "skills" }],
    {
      session_update: "turn_completed",
      stop_reason: "rate_limit",
    },
  );

  assert.equal(result.completed, true);
  assert.equal(result.error, "模型请求受到限流（TPM），请稍后再试或切换模型。");
  assert.equal(
    result.timeline.at(-1).content,
    "Melody 无法完成请求：模型请求受到限流（TPM），请稍后再试或切换模型。",
  );
});
