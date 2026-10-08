import test from "node:test";
import assert from "node:assert/strict";
import { mapPiEvent, stripInjectedMemoryContext } from "./event-mapper.ts";
import { PI_GATEWAY_TOOL_NAMES } from "./tool-gateway.ts";

const context = () => ({
  sessionId: "session-1",
  runId: "run-1",
  promptId: "prompt-1",
  gatewayToolNames: undefined,
  offsets: new Map(),
  activeMessageIds: new Map(),
  nextMessageId: (() => {
    let value = 0;
    return () => String(++value);
  })(),
});

test("maps Pi text deltas to monotonic normalized offsets", () => {
  const ctx = context();
  const first = mapPiEvent(
    {
      type: "message_update",
      message: { id: "assistant-1", role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "你好",
      },
    },
    ctx,
  );
  const second = mapPiEvent(
    {
      type: "message_update",
      message: { id: "assistant-1", role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "，Pi",
      },
    },
    ctx,
  );
  assert.equal(first[0].event.type, "message.delta");
  assert.equal(first[0].event.offset, 0);
  assert.equal(second[0].event.offset, 2);
  assert.equal(second[0].event.messageId, first[0].event.messageId);
});

test("keeps an id-less Pi assistant message stable across start, updates, and end", () => {
  const ctx = context();
  const started = mapPiEvent(
    { type: "message_start", message: { role: "assistant" } },
    ctx,
  )[0].event;
  const update = mapPiEvent(
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Pi",
      },
    },
    ctx,
  )[0].event;
  const completed = mapPiEvent(
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Pi" }] },
    },
    ctx,
  )[0].event;
  assert.equal(started.type, "message.started");
  assert.equal(update.type, "message.delta");
  assert.equal(completed.type, "message.completed");
  assert.equal(update.messageId, started.messageId);
  assert.equal(completed.messageId, started.messageId);
});

test("hides the Host first-turn memory marker from product messages", () => {
  const marker =
    "<melody-memory-context>\n**File:** ~/.melody/memory/MEMORY.md\n</melody-memory-context>\n\n原始问题";
  assert.equal(stripInjectedMemoryContext(marker), "原始问题");
  const event = mapPiEvent(
    {
      type: "message_end",
      message: { id: "user-1", role: "user", content: marker },
    },
    context(),
  )[0]?.event;
  assert.deepEqual(event, {
    type: "message.completed",
    messageId: "user-1",
    role: "user",
    content: "原始问题",
  });
});

test("maps Pi usage fields and USD cost", () => {
  const events = mapPiEvent(
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "完成" }],
        usage: {
          input: 11,
          output: 7,
          cacheRead: 3,
          cacheWrite: 2,
          reasoning: 4,
          totalTokens: 23,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0.0001,
            cacheWrite: 0.0002,
            total: 0.0033,
          },
        },
      },
    },
    context(),
  );
  assert.deepEqual(
    events.find((item) => item.event.type === "usage.updated")?.event,
    {
      type: "usage.updated",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cachedReadTokens: 3,
        reasoningTokens: 4,
        cost: { amount: 0.0033, currency: "USD" },
        confidence: "measured",
      },
    },
  );
});

test("preserves Pi assistant metadata needed for native session reopening", () => {
  const events = mapPiEvent(
    {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-completions",
        model: "gpt-test",
        responseId: "response-1",
        stopReason: "stop",
        content: [{ type: "text", text: "完成" }],
        usage: {
          input: 11,
          output: 7,
          cacheRead: 3,
          cacheWrite: 2,
          totalTokens: 23,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0.0001,
            cacheWrite: 0.0002,
            total: 0.0033,
          },
        },
      },
    },
    context(),
  );
  assert.deepEqual(
    events.find((item) => item.event.type === "message.completed")?.event,
    {
      type: "message.completed",
      messageId: "session-1:response:response-1",
      role: "assistant",
      content: "完成",
      assistantMetadata: {
        provider: "openai",
        api: "openai-completions",
        model: "gpt-test",
        responseId: "response-1",
        stopReason: "stop",
        usage: {
          input: 11,
          output: 7,
          cacheRead: 3,
          cacheWrite: 2,
          totalTokens: 23,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0.0001,
            cacheWrite: 0.0002,
            total: 0.0033,
          },
        },
      },
    },
  );
});

test("maps tool lifecycle and compaction events", () => {
  const ctx = context();
  assert.equal(
    mapPiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "a" },
      },
      ctx,
    )[0].event.type,
    "tool.started",
  );
  assert.equal(
    mapPiEvent({ type: "compaction_start", reason: "threshold" }, ctx)[0].event
      .type,
    "session.compacting",
  );
  assert.equal(
    mapPiEvent({ type: "compaction_end", reason: "threshold" }, ctx)[0].event
      .type,
    "session.compacted",
  );
});

test("maps queued steering and follow-up messages without leaking mutable Pi arrays", () => {
  const steering = ["先检查状态"];
  const followUp = ["然后给我总结"];
  const mapped = mapPiEvent(
    { type: "queue_update", steering, followUp },
    context(),
  );

  assert.deepEqual(mapped, [
    {
      event: {
        type: "run.queue_updated",
        steering: ["先检查状态"],
        followUp: ["然后给我总结"],
      },
    },
  ]);
  steering.push("不应出现在已映射事件中");
  assert.deepEqual(mapped[0].event.steering, ["先检查状态"]);
});

// Pi's streaming tool events carry the call inside `partial.content[index]`,
// not as top-level fields; a fixture with top-level fields never exercised the
// real shape.
const streamedToolCall = (name, id, contentIndex = 0) => ({
  type: "message_update",
  message: { role: "assistant", id: "assistant-1" },
  assistantMessageEvent: {
    type: "toolcall_start",
    contentIndex,
    partial: {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: {} }],
    },
  },
});

test("a streamed gateway tool call produces no provider-level request", () => {
  const ctx = context();
  ctx.gatewayToolNames = new Set(PI_GATEWAY_TOOL_NAMES);
  const events = mapPiEvent(
    streamedToolCall("scheduler_create", "call-1"),
    ctx,
  );
  assert.deepEqual(events, []);
});

test("a streamed extension tool call is named and keeps its provider id", () => {
  const ctx = context();
  ctx.gatewayToolNames = new Set(PI_GATEWAY_TOOL_NAMES);
  const events = mapPiEvent(streamedToolCall("todo_write", "call-7"), ctx);
  assert.deepEqual(events[0].event, {
    type: "tool.requested",
    toolCallId: "call-7",
    toolName: "todo_write",
    status: "pending",
  });
  // The later execution events must land on the same row.
  const started = mapPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call-7",
      toolName: "todo_write",
      args: {},
    },
    ctx,
  );
  assert.equal(started[0].event.toolCallId, "call-7");
});

test("an unidentifiable streamed tool call never becomes a blank row", () => {
  const ctx = context();
  const events = mapPiEvent(
    {
      type: "message_update",
      message: { role: "assistant", id: "assistant-1" },
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
    },
    ctx,
  );
  assert.deepEqual(events, []);
});

test("every gateway tool suppresses its provider-level request, not just the newest one", () => {
  // Driven by the gateway's own name list: a tool that is registered but
  // missing from that list would surface as a duplicate tool card carrying the
  // provider's raw arguments, which is how `monitor`/`scheduler_*` drifted.
  for (const toolName of PI_GATEWAY_TOOL_NAMES) {
    const ctx = context();
    ctx.gatewayToolNames = new Set(PI_GATEWAY_TOOL_NAMES);
    const events = mapPiEvent(
      streamedToolCall(toolName, `call-${toolName}`),
      ctx,
    );
    assert.equal(
      events.some((item) => item.event.type === "tool.requested"),
      false,
      `${toolName} 不应产生 provider 级重复请求`,
    );
  }
});

test("does not duplicate a ToolGateway request from provider toolcall metadata", () => {
  const ctx = context();
  ctx.gatewayToolNames = new Set(["workspace_read_file"]);
  const events = mapPiEvent(
    {
      type: "message_update",
      message: { role: "assistant", id: "assistant-1" },
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        id: "call-1",
        toolName: "workspace_read_file",
      },
    },
    ctx,
  );
  assert.equal(
    events.some((item) => item.event.type === "tool.requested"),
    false,
  );
  assert.deepEqual(
    mapPiEvent(
      {
        type: "message_update",
        message: { role: "assistant", id: "assistant-1" },
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          id: "call-2",
          toolName: "other_tool",
        },
      },
      ctx,
    )[0].event,
    {
      type: "tool.requested",
      toolCallId: "call-2",
      toolName: "other_tool",
      status: "pending",
    },
  );
});
