import assert from "node:assert/strict";
import test from "node:test";

import {
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

const snapshot = (overrides = {}) => ({
  currentSessionId: "session-1",
  timeline: [],
  backgroundTimelines: {},
  backgroundCursors: {},
  contextUsage: undefined,
  backgroundContextUsage: {},
  subagents: {},
  availableModels: [],
  ...overrides,
});

test("routes current-session text, status, cursor and context into one patch", () => {
  let state = createAgentEventProjectionState();
  state = projectAgentEvent(
    state,
    envelope("start", { type: "run.started" }),
    "session-1",
  ).state;
  const result = projectAgentEvent(
    state,
    envelope("context", {
      type: "context.updated",
      tokens: 20,
      limit: 1000,
      confidence: "measured",
    }),
    "session-1",
  );

  const patch = projectAgentEventToStorePatch(snapshot(), result);

  assert.equal(patch.acpCursor, "context");
  assert.equal(patch.acpPhase, undefined);
  assert.deepEqual(patch.contextUsage, { usedTokens: 20, maxTokens: 1000 });
  assert.equal(patch.timeline, result.projection.timeline);
});

test("marks an opened or imported Pi session ready", () => {
  for (const type of ["session.opened", "session.imported"]) {
    const result = projectAgentEvent(
      createAgentEventProjectionState(),
      envelope(`${type}-event`, {
        type,
        ...(type === "session.imported"
          ? { nativeSessionId: "pi-native", importedRecords: 2 }
          : { nativeSessionId: "pi-native" }),
        sessionModeId: "plan",
        permissionMode: "auto",
        modelId: "pi/fast",
        reasoningEffort: "high",
      }),
      "session-1",
    );
    const patch = projectAgentEventToStorePatch(
      snapshot({
        availableModels: [
          {
            id: "pi/fast",
            name: "Fast",
            contextWindowTokens: 1000,
            reasoningEfforts: ["high"],
          },
        ],
      }),
      result,
    );
    assert.equal(patch.chatStatus, "ready");
    assert.equal(patch.acpPhase, "ready");
    assert.equal(patch.selectedSessionModeId, "plan");
    assert.equal(patch.permissionMode, "auto");
    assert.equal(patch.selectedModelId, "pi/fast");
    assert.equal(patch.selectedReasoningEffort, "high");
  }
});

test("keeps background projections out of the visible timeline", () => {
  let state = createAgentEventProjectionState();
  state = projectAgentEvent(
    state,
    envelope(
      "background-delta",
      {
        type: "message.delta",
        messageId: "assistant-1",
        partId: "text-0",
        text: "后台回复",
        offset: 0,
      },
      { sessionId: "session-2" },
    ),
    "session-2",
  ).state;
  const result = projectAgentEvent(
    state,
    envelope(
      "background-finish",
      { type: "run.finished", status: "completed" },
      { sessionId: "session-2" },
    ),
    "session-2",
  );

  const patch = projectAgentEventToStorePatch(snapshot(), result);

  assert.equal(patch.timeline, undefined);
  assert.equal(patch.acpCursor, undefined);
  assert.equal(patch.backgroundCursors["session-2"], "background-finish");
  assert.equal(patch.backgroundTimelines["session-2"].at(-1).streaming, false);
});

test("merges handled subagents without erasing other session records", () => {
  let state = createAgentEventProjectionState();
  const result = projectAgentEvent(
    state,
    envelope("subagent-1", {
      type: "subagent.changed",
      taskId: "task-1",
      status: "running",
      childSessionId: "child-1",
      payload: { description: "读取资料" },
    }),
    "session-1",
  );
  state = result.state;

  const patch = projectAgentEventToStorePatch(
    snapshot({
      subagents: {
        other: {
          subagentId: "other",
          parentSessionId: "session-2",
          childSessionId: "child-2",
          subagentType: "general-purpose",
          description: "另一项",
          status: "completed",
          startedAt: 1,
          updatedAt: 2,
          toolsUsed: [],
        },
      },
    }),
    result,
  );

  assert.equal(patch.subagents.other.description, "另一项");
  assert.equal(patch.subagents["task-1"].childSessionId, "child-1");
});

test("applies a model catalog while preserving a selected available model", () => {
  const result = projectAgentEvent(
    createAgentEventProjectionState(),
    envelope(
      "models",
      {
        type: "runtime.models",
        revision: 2,
        models: [
          {
            provider: "pi",
            id: "fast",
            name: "Fast",
            api: "openai-completions",
            input: ["text"],
            reasoning: false,
            contextWindow: 1000,
            maxTokens: 200,
            availability: "available",
          },
        ],
      },
      { sessionId: undefined },
    ),
  );

  const patch = projectAgentEventToStorePatch(
    snapshot({
      selectedModelId: "pi/fast",
      availableModels: [
        {
          id: "pi/fast",
          name: "Fast",
          contextWindowTokens: 1000,
          reasoningEfforts: [],
        },
      ],
    }),
    result,
  );

  assert.deepEqual(
    patch.availableModels?.map((model) => model.id),
    ["pi/fast"],
  );
  assert.deepEqual(patch.unavailableModels, []);
  assert.deepEqual(patch.modelRefreshErrors, {});
  assert.equal(patch.selectedModelId, "pi/fast");
  assert.equal(patch.timeline, undefined);
  assert.equal(patch.acpCursor, undefined);
});

test("clears a selected model when a refresh removes every available entry", () => {
  const result = projectAgentEvent(
    createAgentEventProjectionState(),
    envelope(
      "models-empty",
      {
        type: "runtime.models",
        revision: 3,
        models: [
          {
            provider: "pi",
            id: "auth-only",
            name: "Auth Only",
            api: "openai-completions",
            input: ["text"],
            reasoning: false,
            contextWindow: 1000,
            maxTokens: 200,
            availability: "auth-needed",
          },
        ],
      },
      { sessionId: undefined },
    ),
  );
  const patch = projectAgentEventToStorePatch(
    snapshot({ selectedModelId: "pi/old" }),
    result,
  );

  assert.equal(patch.selectedModelId, undefined);
  assert.equal("selectedModelId" in patch, true);
  assert.equal("selectedReasoningEffort" in patch, true);
});

test("projects Pi capabilities and diagnostics without touching the current timeline", () => {
  const diagnostics = [
    {
      code: "pi.mcp.configured",
      capability: "mcp",
      severity: "warning",
      message: "当前 Pi 会话中未配置可用 MCP 服务。",
      source: "project",
    },
  ];
  const capabilities = {
    engine: "pi",
    engineVersion: "1.0.1",
    protocolVersion: 1,
    authentication: true,
    modelCatalog: true,
    tools: [],
    sessionTree: true,
    compaction: true,
    plans: true,
    questions: true,
    permissions: true,
    subagents: true,
    backgroundTasks: true,
    mcp: false,
    media: ["image-input"],
    diagnostics,
  };
  const result = projectAgentEvent(
    createAgentEventProjectionState(),
    envelope(
      "ready",
      { type: "runtime.ready", capabilities },
      { sessionId: undefined },
    ),
  );

  const patch = projectAgentEventToStorePatch(snapshot(), result);

  assert.deepEqual(patch.capabilities, capabilities);
  assert.deepEqual(patch.capabilityDiagnostics, diagnostics);
  assert.equal(patch.timeline, undefined);
  assert.equal(patch.acpCursor, undefined);
});

test("projects session configuration revisions and authoritative settings", () => {
  const result = projectAgentEvent(
    createAgentEventProjectionState(),
    envelope("configured", {
      type: "session.configured",
      revision: 4,
      modelId: "pi/fast",
      reasoningEffort: "high",
      sessionModeId: "plan",
      permissionMode: "auto",
    }),
    "session-1",
  );
  const patch = projectAgentEventToStorePatch(
    snapshot({
      availableModels: [
        {
          id: "pi/fast",
          name: "Fast",
          contextWindowTokens: 1000,
          reasoningEfforts: [],
        },
      ],
    }),
    result,
  );

  assert.equal(patch.configRevision, 4);
  assert.equal(patch.selectedModelId, "pi/fast");
  assert.equal(patch.selectedReasoningEffort, "high");
  assert.equal(patch.selectedSessionModeId, "plan");
  assert.equal(patch.permissionMode, "auto");
});

test("ignores a cross-session result when the projector marked it ignored", () => {
  const result = projectAgentEvent(
    createAgentEventProjectionState(),
    envelope(
      "foreign",
      {
        type: "message.delta",
        messageId: "foreign-message",
        partId: "text-0",
        text: "不应进入当前会话",
        offset: 0,
      },
      { sessionId: "session-2" },
    ),
    "session-1",
  );

  assert.deepEqual(projectAgentEventToStorePatch(snapshot(), result), {});
});
