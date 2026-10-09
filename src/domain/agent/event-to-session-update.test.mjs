import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_AGENT_MONITOR_NOTIFICATIONS,
  createAgentEventProjectionState,
  projectAgentEvent,
} from "./event-to-session-update.ts";
import { projectAgentEventToStorePatch } from "./projection-store-patch.ts";

const envelope = (id, event, overrides = {}) => ({
  protocolVersion: 1,
  eventId: id,
  sessionId: "session-1",
  replay: false,
  ...overrides,
  event,
});

const project = (state, id, event, overrides) =>
  projectAgentEvent(state, envelope(id, event, overrides), "session-1");

test("projects streamed text and repairs it with the completed message", () => {
  let state = createAgentEventProjectionState([
    { id: "user-1", kind: "message", role: "user", content: "继续" },
  ]);
  state = project(state, "run-start", { type: "run.started" }).state;
  state = project(state, "delta-1", {
    type: "message.delta",
    messageId: "assistant-1",
    partId: "text-0",
    text: "你好",
    offset: 0,
  }).state;
  const second = project(state, "delta-2", {
    type: "message.delta",
    messageId: "assistant-1",
    partId: "text-0",
    text: "，Pi",
    offset: 2,
  });
  state = second.state;
  assert.equal(second.projection.streaming, true);
  assert.equal(state.timeline.at(-1).content, "你好，Pi");

  state = project(state, "message-end", {
    type: "message.completed",
    messageId: "assistant-1",
    role: "assistant",
    content: "你好，Pi（完整结果）",
  }).state;
  assert.equal(state.timeline.at(-1).content, "你好，Pi（完整结果）");
  assert.equal(state.timeline.at(-1).streaming, false);

  const finished = project(state, "run-end", {
    type: "run.finished",
    status: "completed",
  });
  assert.equal(finished.projection.completed, true);
  assert.equal(
    finished.state.timeline.filter((entry) => entry.kind === "message").length,
    2,
  );
  assert.equal(finished.state.timeline.at(-1).content, "你好，Pi（完整结果）");
});

test("shows a clear rate-limit error when a Pi run finishes with provider failure", () => {
  const result = project(
    createAgentEventProjectionState([
      { id: "user-1", kind: "message", role: "user", content: "继续" },
    ]),
    "run-error",
    {
      type: "run.finished",
      status: "failed",
      stopReason: "rate_limit",
      error: {
        code: "pi.provider_rate_limited",
        message: "模型请求受到限流（TPM/RPM），请稍后再试或切换模型。",
        retriable: true,
        scope: "run",
        details: {
          providerMessage: "429: RateLimitExceeded.EndpointTPMExceeded",
        },
      },
    },
  );

  assert.equal(result.projection.completed, true);
  assert.equal(
    result.state.timeline.at(-1).content,
    "Melody 无法完成请求：模型请求受到限流（TPM），请稍后再试或切换模型。",
  );
});

test("treats Pi queue snapshots as a handled auxiliary event", () => {
  const result = project(createAgentEventProjectionState(), "queue", {
    type: "run.queue_updated",
    steering: ["先检查状态"],
    followUp: ["然后总结"],
  });

  assert.equal(result.diagnostic, undefined);
  assert.deepEqual(result.auxiliaryEvent, {
    type: "run.queue_updated",
    steering: ["先检查状态"],
    followUp: ["然后总结"],
  });
  assert.equal(result.projection.timeline.length, 0);
});

test("persists Pi assistant metadata on the completed timeline row", () => {
  let state = createAgentEventProjectionState([
    { id: "user-1", kind: "message", role: "user", content: "继续" },
  ]);
  state = project(state, "delta-1", {
    type: "message.delta",
    messageId: "assistant-1",
    partId: "text-0",
    text: "完成",
    offset: 0,
  }).state;
  state = project(state, "message-end", {
    type: "message.completed",
    messageId: "assistant-1",
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
  }).state;
  assert.deepEqual(state.timeline.at(-1).assistantMetadata, {
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
  });
});

test("projects tool lifecycle into one activity row", () => {
  let state = createAgentEventProjectionState([
    { id: "user-1", kind: "message", role: "user", content: "读文件" },
  ]);
  state = project(state, "tool-request", {
    type: "tool.requested",
    toolCallId: "call-1",
    toolName: "workspace_read_file",
    status: "pending",
  }).state;
  state = project(state, "tool-start", {
    type: "tool.started",
    toolCallId: "call-1",
    toolName: "workspace_read_file",
    status: "running",
    activity: { path: "src/App.tsx" },
  }).state;
  state = project(state, "tool-progress", {
    type: "tool.progress",
    toolCallId: "call-1",
    output: "读取中",
    status: "running",
  }).state;
  const finished = project(state, "tool-end", {
    type: "tool.finished",
    toolCallId: "call-1",
    output: "完成",
    status: "completed",
  });
  const tools = finished.state.timeline.filter(
    (entry) => entry.kind === "tool",
  );
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolCallId, "call-1");
  assert.equal(tools[0].status, "completed");
  assert.equal(tools[0].output, "完成");
  assert.equal(tools[0].activity.operation, "read");
  assert.equal(tools[0].activity.path, "src/App.tsx");
});

test("projects Host gateway arguments as a readable file activity", () => {
  const result = project(createAgentEventProjectionState(), "tool-request", {
    type: "tool.requested",
    toolCallId: "call-host-read",
    toolName: "workspace_read_file",
    status: "pending",
    activity: {
      gateway: "melody",
      arguments: { path: "src/App.tsx" },
      cwd: "/workspace",
    },
  });
  const tool = result.state.timeline[0];

  assert.equal(tool.kind, "tool");
  assert.equal(tool.activity.operation, "read");
  assert.equal(tool.activity.path, "src/App.tsx");
  assert.equal(tool.command, "src/App.tsx");
});

test("projects Host search targets and queries without exposing the JSON wrapper", () => {
  const result = project(createAgentEventProjectionState(), "search-request", {
    type: "tool.requested",
    toolCallId: "call-host-search",
    toolName: "workspace_search",
    status: "pending",
    activity: {
      gateway: "melody",
      arguments: { pattern: "useAgentStore", include: "src/**/*.ts" },
      cwd: "/workspace",
    },
  });
  const tool = result.state.timeline[0];

  assert.equal(tool.activity.operation, "search");
  assert.equal(tool.activity.query, "useAgentStore");
  assert.equal(tool.activity.glob, "src/**/*.ts");
  assert.equal(tool.command, "");
});

test("keeps a cancelled Host tool terminal instead of treating it as failed", () => {
  let state = project(createAgentEventProjectionState(), "tool-request", {
    type: "tool.requested",
    toolCallId: "call-cancelled",
    toolName: "workspace_read_file",
    status: "pending",
  }).state;
  state = project(state, "tool-finish", {
    type: "tool.finished",
    toolCallId: "call-cancelled",
    toolName: "workspace_read_file",
    status: "cancelled",
    error: {
      code: "pi.tool_cancelled",
      message: "Cancelled by user.",
      retriable: false,
      scope: "tool",
    },
  }).state;

  assert.equal(state.timeline[0].status, "cancelled");
  assert.equal(typeof state.timeline[0].completedAt, "number");
});

test("keeps internal instruction-scope lookups out of the session timeline", () => {
  const state = createAgentEventProjectionState();
  const result = project(state, "instruction-scope", {
    type: "tool.requested",
    toolCallId: "melody_internal_instruction_scope:call-1",
    toolName: "melody_internal_instruction_scope",
    status: "pending",
  });

  assert.equal(result.ignored, true);
  assert.equal(result.state.timeline.length, 0);
});

test("marks a cancelled tool as terminal without treating it as a failure", () => {
  let state = createAgentEventProjectionState();
  state = project(state, "tool-request", {
    type: "tool.requested",
    toolCallId: "call-cancelled",
    toolName: "workspace_search",
  }).state;
  const result = project(state, "tool-cancel", {
    type: "tool.finished",
    toolCallId: "call-cancelled",
    status: "cancelled",
  });
  const tool = result.state.timeline[0];
  assert.equal(tool.kind, "tool");
  assert.equal(tool.status, "cancelled");
  assert.equal(typeof tool.completedAt, "number");
});

test("keeps billing and context usage separate and never turns unknown context into zero", () => {
  let state = createAgentEventProjectionState([
    { id: "user-1", kind: "message", role: "user", content: "统计" },
  ]);
  state = project(state, "delta-1", {
    type: "message.delta",
    messageId: "assistant-1",
    partId: "text-0",
    text: "完成",
    offset: 0,
  }).state;
  const usage = project(state, "usage-1", {
    type: "usage.updated",
    usage: {
      inputTokens: 12,
      outputTokens: 5,
      cost: { amount: 0.001, currency: "USD" },
      confidence: "measured",
    },
  });
  state = usage.state;
  assert.equal(usage.billingUsage.usageIsIncomplete, true);
  assert.equal(usage.billingUsage.costIsPartial, false);
  assert.equal(usage.billingUsage.costUsdTicks, 10_000_000);

  const context = project(state, "context-1", {
    type: "context.updated",
    tokens: 23,
    limit: 1000,
    confidence: "measured",
  });
  state = context.state;
  assert.deepEqual(context.projection.contextUsage, {
    usedTokens: 23,
    maxTokens: 1000,
  });
  assert.equal(context.contextConfidence, "measured");

  const finished = project(state, "run-end", {
    type: "run.finished",
    status: "completed",
  });
  assert.equal(
    finished.state.timeline.at(-1).billingUsage.costUsdTicks,
    10_000_000,
  );
  const unknownContext = project(state, "context-unknown", {
    type: "context.updated",
    tokens: null,
    limit: null,
    confidence: "unknown",
  });
  assert.equal(unknownContext.projection.contextUsage, undefined);
  assert.equal(unknownContext.diagnostic.kind, "invalid-context");
});

test("rejects duplicate or cross-session deltas and preserves unhandled diagnostics", () => {
  let state = createAgentEventProjectionState([
    { id: "user-1", kind: "message", role: "user", content: "检查" },
  ]);
  state = project(state, "delta-1", {
    type: "message.delta",
    messageId: "assistant-1",
    partId: "text-0",
    text: "A",
    offset: 0,
  }).state;
  const duplicate = project(state, "delta-duplicate", {
    type: "message.delta",
    messageId: "assistant-1",
    partId: "text-0",
    text: "A",
    offset: 0,
  });
  assert.equal(duplicate.diagnostic.kind, "duplicate-message-delta");
  assert.equal(duplicate.state.timeline.at(-1).content, "A");

  const mismatch = project(
    state,
    "foreign",
    {
      type: "message.delta",
      messageId: "foreign-message",
      partId: "text-0",
      text: "不应进入当前会话",
      offset: 0,
    },
    { sessionId: "session-2" },
  );
  assert.equal(mismatch.ignored, true);
  assert.equal(mismatch.diagnostic.kind, "session-mismatch");
  assert.equal(mismatch.state.timeline.at(-1).content, "A");

  const unhandled = project(state, "legacy-event", {
    type: "protocol.unhandled",
    method: "pi.future_event",
    payload: { reason: "new capability" },
  });
  assert.equal(unhandled.diagnostic.kind, "protocol-unhandled");
  assert.equal(unhandled.diagnostic.method, "pi.future_event");
  assert.deepEqual(unhandled.diagnostic.payload, { reason: "new capability" });
});

test("projects normalized subagent lifecycle without adding a timeline row", () => {
  let state = createAgentEventProjectionState();
  const spawned = project(state, "subagent-start", {
    type: "subagent.changed",
    taskId: "subagent-1",
    status: "running",
    childSessionId: "child-1",
    payload: { description: "检查 Pi 兼容性" },
  });
  state = spawned.state;
  assert.equal(spawned.state.timeline.length, 0);
  assert.equal(
    spawned.state.subagents.get("subagent-1").description,
    "检查 Pi 兼容性",
  );
  assert.equal(
    spawned.state.subagents.get("subagent-1").parentSessionId,
    "session-1",
  );
  assert.equal(spawned.subagentProjection.handled, true);

  const finished = project(state, "subagent-end", {
    type: "subagent.changed",
    taskId: "subagent-1",
    status: "completed",
    childSessionId: "child-1",
    payload: { output: "通过" },
  });
  assert.equal(finished.state.subagents.get("subagent-1").status, "completed");
  assert.equal(finished.state.subagents.get("subagent-1").output, "通过");

  const genericTask = project(finished.state, "task-only", {
    type: "task.changed",
    taskId: "background-1",
    status: "running",
  });
  assert.equal(genericTask.diagnostic, undefined);
  assert.equal(genericTask.state.subagents.size, 1);
});

test("diagnoses malformed normalized subagent events", () => {
  const result = project(createAgentEventProjectionState(), "bad-subagent", {
    type: "subagent.changed",
    taskId: "subagent-1",
    status: "running",
  });
  assert.equal(result.diagnostic.kind, "invalid-subagent");
  assert.equal(result.state.subagents.size, 0);
});

test("settles cancellation without manufacturing an assistant error", () => {
  const state = createAgentEventProjectionState([
    { id: "user-1", kind: "message", role: "user", content: "停止" },
    {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      content: "已输出",
      streaming: true,
    },
  ]);
  const result = project(state, "run-cancel", {
    type: "run.finished",
    status: "cancelled",
  });
  assert.equal(result.projection.completed, true);
  assert.equal(result.projection.error, undefined);
  assert.equal(result.state.timeline.at(-1).streaming, false);
  assert.equal(result.state.timeline.length, 2);
});

test("projects permission interactions and preserves the selected option semantics", () => {
  let state = createAgentEventProjectionState();
  state = project(state, "permission-request", {
    type: "interaction.requested",
    interactionId: "permission-1",
    kind: "permission",
    payload: {
      toolCall: {
        toolCallId: "call-1",
        title: "写文件",
        rawInput: { path: "a.txt" },
      },
      options: [
        { optionId: "allow", name: "允许一次", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
    },
  }).state;
  assert.equal(state.timeline[0].permission, "pending");
  assert.equal(state.timeline[0].permissionOptions.length, 2);

  const resolved = project(state, "permission-resolved", {
    type: "interaction.resolved",
    interactionId: "permission-1",
    kind: "permission",
    payload: {
      resolution: {
        outcome: { outcome: "selected", optionId: "allow" },
      },
    },
  });
  assert.equal(resolved.diagnostic, undefined);
  assert.equal(resolved.state.timeline[0].permission, "allowed");
  assert.equal(resolved.state.timeline[0].status, "completed");
});

test("projects plan approval interactions", () => {
  let state = createAgentEventProjectionState();
  state = project(state, "plan-request", {
    type: "interaction.requested",
    interactionId: "plan-1",
    kind: "plan",
    payload: {
      toolCallId: "plan-call",
      planContent: "先读取配置，再运行检查。",
    },
  }).state;
  assert.equal(state.timeline[0].kind, "plan");
  assert.equal(state.timeline[0].status, "awaiting-approval");

  const resolved = project(state, "plan-resolved", {
    type: "interaction.resolved",
    interactionId: "plan-1",
    kind: "plan",
    payload: { outcome: "approved" },
  });
  assert.equal(resolved.diagnostic, undefined);
  assert.equal(resolved.state.timeline[0].status, "approved");
});

test("projects question interactions and their answers", () => {
  let state = createAgentEventProjectionState();
  state = project(state, "question-request", {
    type: "interaction.requested",
    interactionId: "question-1",
    kind: "question",
    payload: {
      mode: "plan",
      toolCallId: "question-call",
      questions: [
        {
          question: "选择执行方式",
          options: [{ label: "继续", description: "继续执行" }],
        },
      ],
    },
  }).state;
  assert.equal(state.timeline[0].kind, "tool");
  assert.equal(state.timeline[0].question.outcome, "pending");

  const resolved = project(state, "question-resolved", {
    type: "interaction.resolved",
    interactionId: "question-1",
    kind: "question",
    payload: {
      outcome: "accepted",
      answers: { 选择执行方式: ["继续"] },
    },
  });
  assert.equal(resolved.diagnostic, undefined);
  assert.equal(resolved.state.timeline[0].question.outcome, "accepted");
  assert.deepEqual(resolved.state.timeline[0].question.answers, {
    选择执行方式: ["继续"],
  });
});

test("keeps malformed interactions visible as diagnostics instead of mutating the timeline", () => {
  const state = createAgentEventProjectionState();
  const result = project(state, "bad-question", {
    type: "interaction.requested",
    interactionId: "question-bad",
    kind: "question",
    payload: { questions: [] },
  });
  assert.equal(result.diagnostic.kind, "invalid-interaction");
  assert.equal(result.diagnostic.interactionKind, "question");
  assert.equal(result.state.timeline.length, 0);
});

test("projects a normalized model catalog without touching the timeline", () => {
  const result = project(createAgentEventProjectionState(), "models-1", {
    type: "runtime.models",
    revision: 4,
    models: [
      {
        provider: "pi-demo",
        id: "reasoning-model",
        name: "Reasoning Model",
        api: "openai-completions",
        input: ["text"],
        reasoning: true,
        contextWindow: 1000,
        maxTokens: 200,
        availability: "available",
      },
      {
        provider: "pi-demo",
        id: "auth-needed",
        name: "Needs Auth",
        api: "openai-completions",
        input: ["text"],
        reasoning: false,
        contextWindow: 1000,
        maxTokens: 200,
        availability: "auth-needed",
      },
    ],
    refreshErrors: { auth: "需要登录" },
  });

  assert.deepEqual(result.projection.timeline, []);
  assert.deepEqual(
    result.modelCatalogProjection?.availableModels.map((model) => model.id),
    ["pi-demo/reasoning-model"],
  );
  assert.deepEqual(
    result.modelCatalogProjection?.unavailableModels.map((model) => model.id),
    ["auth-needed"],
  );
});

test("treats Host-owned schedule events as auxiliary rather than unknown", () => {
  const state = createAgentEventProjectionState([]);
  const schedule = {
    scheduleId: "schedule-1",
    sessionId: "session-1",
    projectId: "project-1",
    kind: "interval",
    intervalMs: 300_000,
    prompt: "Summarize the open work",
    missedPolicy: "skip",
    status: "active",
    nextRunAt: 1_000_000,
    runCount: 0,
    permissionMode: "ask",
    sessionModeId: "default",
    revision: 1,
    createdAt: 900_000,
    updatedAt: 900_000,
  };
  const changed = project(state, "schedule-changed", {
    type: "schedule.changed",
    change: "created",
    schedule,
  });
  assert.equal(changed.diagnostic, undefined);
  assert.equal(changed.auxiliaryEvent?.type, "schedule.changed");
  assert.equal(changed.projection.timeline.length, 0);

  const fired = project(state, "schedule-fired", {
    type: "schedule.fired",
    scheduleId: "schedule-1",
    runOrdinal: 0,
    status: "skipped",
    firedAt: 1_400_000,
  });
  assert.equal(fired.diagnostic, undefined);
  assert.equal(fired.auxiliaryEvent?.type, "schedule.fired");
  assert.equal(fired.projection.timeline.length, 0);
});

test("accumulates monitor lines in a bounded feed outside the timeline", () => {
  let state = createAgentEventProjectionState([]);
  const notification = (sequence) => ({
    type: "task.notification",
    taskId: "pi-monitor:abc",
    description: "watch the deploy log",
    line: `ERROR ${sequence}`,
    sequence,
    truncated: false,
  });

  const first = project(state, "monitor-1", notification(1));
  assert.equal(first.diagnostic, undefined);
  assert.equal(first.projection.timeline.length, 0);
  assert.equal(first.state.notifications.length, 1);
  assert.equal(first.state.notifications[0].line, "ERROR 1");
  assert.equal(
    first.state.notifications[0].description,
    "watch the deploy log",
  );
  assert.equal(typeof first.state.notifications[0].receivedAt, "number");

  state = first.state;
  for (
    let sequence = 2;
    sequence <= MAX_AGENT_MONITOR_NOTIFICATIONS + 5;
    sequence += 1
  ) {
    state = project(state, `monitor-${sequence}`, notification(sequence)).state;
  }
  // The feed is a ring: a chatty monitor cannot grow renderer state forever,
  // and it never pushes message history out of the timeline.
  assert.equal(state.notifications.length, MAX_AGENT_MONITOR_NOTIFICATIONS);
  assert.equal(
    state.notifications.at(-1).line,
    `ERROR ${MAX_AGENT_MONITOR_NOTIFICATIONS + 5}`,
  );
  assert.equal(state.notifications[0].line, "ERROR 6");
});

test("carries the monitor feed through the store patch", () => {
  const state = createAgentEventProjectionState([]);
  const result = project(state, "monitor-1", {
    type: "task.notification",
    taskId: "pi-monitor:abc",
    description: "watch",
    line: "one line",
    sequence: 1,
    truncated: true,
  });
  const patch = projectAgentEventToStorePatch(
    {
      timeline: [],
      backgroundTimelines: {},
      backgroundCursors: {},
      subagents: {},
      availableModels: [],
    },
    result,
  );
  assert.equal(patch.monitorNotifications?.length, 1);
  assert.equal(patch.monitorNotifications?.[0].line, "one line");
  assert.equal(patch.monitorNotifications?.[0].truncated, true);
  assert.equal(patch.timeline, undefined, "the feed is not a chat timeline");
});

test("bumps a schedule revision instead of mirroring Host rows", () => {
  let state = createAgentEventProjectionState([]);
  assert.equal(state.scheduleRevision, 0);

  const fired = project(state, "schedule-fired", {
    type: "schedule.fired",
    scheduleId: "schedule-1",
    runOrdinal: 0,
    status: "fired",
    firedAt: 1_400_000,
  });
  assert.equal(fired.diagnostic, undefined);
  assert.equal(fired.state.scheduleRevision, 1);
  assert.equal(fired.projection.timeline.length, 0);

  state = fired.state;
  const changed = project(state, "schedule-changed", {
    type: "schedule.changed",
    change: "paused",
    schedule: {
      scheduleId: "schedule-1",
      sessionId: "session-1",
      projectId: "project-1",
      kind: "interval",
      intervalMs: 300_000,
      prompt: "Summarize",
      missedPolicy: "skip",
      status: "paused",
      runCount: 1,
      permissionMode: "ask",
      sessionModeId: "default",
      revision: 2,
      createdAt: 1_000,
      updatedAt: 2_000,
    },
  });
  assert.equal(changed.state.scheduleRevision, 2);

  const patch = projectAgentEventToStorePatch(
    {
      timeline: [],
      backgroundTimelines: {},
      backgroundCursors: {},
      subagents: {},
      availableModels: [],
    },
    changed,
  );
  assert.equal(patch.scheduleRevision, 2);
  assert.equal(patch.timeline, undefined);
});
