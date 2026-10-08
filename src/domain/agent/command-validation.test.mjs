import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentCommandEnvelope } from "./command-validation.ts";

const submit = (overrides = {}) => ({
  protocolVersion: 1,
  requestId: 11,
  command: {
    type: "turn.submit",
    sessionId: "session-1",
    promptId: "prompt-1",
    content: "hello",
    attachments: [],
    config: {
      permissionMode: "ask",
      configRevision: 0,
    },
    ...overrides,
  },
});

test("accepts the complete product turn envelope", () => {
  assert.doesNotThrow(() => validateAgentCommandEnvelope(submit()));
  assert.doesNotThrow(() =>
    validateAgentCommandEnvelope({
      ...submit(),
      idempotencyKey: "session-1:prompt-1",
    }),
  );
});

test("rejects protocol versions and IDs that cannot be correlated", () => {
  assert.throws(
    () => validateAgentCommandEnvelope({ ...submit(), protocolVersion: 2 }),
    /protocol.*版本/u,
  );
  assert.throws(
    () => validateAgentCommandEnvelope({ ...submit(), requestId: "" }),
    /requestId.*稳定 ID/u,
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        ...submit(),
        idempotencyKey: " ".repeat(2),
      }),
    /idempotencyKey.*非空/u,
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        ...submit(),
        idempotencyKey: "x".repeat(257),
      }),
    /idempotencyKey.*不能超过/u,
  );
});

test("rejects an ambiguous session configuration", () => {
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: 12,
        command: {
          type: "session.configure",
          sessionId: "session-1",
        },
      }),
    /只包含模型、会话模式或权限模式/u,
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: 13,
        command: {
          type: "session.configure",
          sessionId: "session-1",
          reasoningEffort: "high",
        },
      }),
    /必须和 modelId 一起/u,
  );
});

test("validates optimistic session configuration revisions", () => {
  const command = {
    protocolVersion: 1,
    requestId: 16,
    command: {
      type: "session.configure",
      sessionId: "session-1",
      modelId: "model-1",
      expectedRevision: 3,
    },
  };
  assert.doesNotThrow(() => validateAgentCommandEnvelope(command));
  for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        validateAgentCommandEnvelope({
          ...command,
          command: { ...command.command, expectedRevision },
        }),
      /expectedRevision.*非负整数/u,
    );
  }
});

test("keeps empty text valid when an attachment is present", () => {
  assert.doesNotThrow(() =>
    validateAgentCommandEnvelope(
      submit({
        content: "",
        attachments: [
          {
            url: "data:text/plain,hello%20world",
            mediaType: "text/plain",
            filename: "note.txt",
          },
        ],
      }),
    ),
  );
});

test("accepts a bounded child-session continuation command", () => {
  assert.doesNotThrow(() =>
    validateAgentCommandEnvelope({
      protocolVersion: 1,
      requestId: 18,
      command: {
        type: "task.continue",
        sessionId: "root-session",
        taskId: "child-task",
        content: "继续核对结论，并列出证据来源。",
      },
    }),
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: 19,
        command: {
          type: "task.continue",
          sessionId: "root-session",
          taskId: "child-task",
          content: " \n ",
        },
      }),
    /task\.continue\.content/u,
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: 20,
        command: {
          type: "task.continue",
          sessionId: "root-session",
          taskId: "child-task",
          content: "续".repeat(12_001),
        },
      }),
    /不能超过 12000/u,
  );
});

test("keeps product and engine session identities separate", () => {
  assert.doesNotThrow(() =>
    validateAgentCommandEnvelope({
      protocolVersion: 1,
      requestId: 14,
      command: {
        type: "session.open",
        sessionId: "acp-native-1",
        productSessionId: "melody-session-1",
        cwd: "/tmp/project",
        permissionMode: "ask",
      },
    }),
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: 15,
        command: {
          type: "session.open",
          productSessionId: "",
          cwd: "/tmp/project",
          permissionMode: "ask",
        },
      }),
    /productSessionId.*非空/u,
  );
});

test("validates the read-only Pi model catalog request", () => {
  assert.doesNotThrow(() =>
    validateAgentCommandEnvelope({
      protocolVersion: 1,
      requestId: "models-1",
      sessionId: "session-1",
      command: {
        type: "runtime.models.list",
        sessionId: "session-1",
        refresh: true,
      },
    }),
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: "models-2",
        command: { type: "runtime.models.list", refresh: "yes" },
      }),
    /refresh.*布尔值/u,
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: "models-3",
        sessionId: " ",
        command: { type: "runtime.models.list" },
      }),
    /envelope\.sessionId.*非空/u,
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: "models-4",
        command: {
          type: "runtime.models.list",
          sessionId: " ",
        },
      }),
    /runtime\.models\.list\.sessionId.*非空/u,
  );
});

test("accepts a Pi shutdown request and rejects unknown reasons", () => {
  assert.doesNotThrow(() =>
    validateAgentCommandEnvelope({
      protocolVersion: 1,
      requestId: "shutdown-1",
      command: { type: "runtime.shutdown", reason: "stop" },
    }),
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: "shutdown-2",
        command: { type: "runtime.shutdown", reason: "unknown" },
      }),
    /reason.*受支持/u,
  );
});

test("accepts host-owned ToolGateway resolutions and rejects ambiguous failures", () => {
  assert.doesNotThrow(() =>
    validateAgentCommandEnvelope({
      protocolVersion: 1,
      requestId: "tool-result-1",
      command: {
        type: "tool.resolve",
        sessionId: "session-1",
        runId: "run-1",
        toolCallId: "call-1",
        resolution: { status: "completed", output: "file contents" },
      },
    }),
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        protocolVersion: 1,
        requestId: "tool-result-2",
        command: {
          type: "tool.resolve",
          sessionId: "session-1",
          toolCallId: "call-1",
          resolution: { status: "failed", output: "denied" },
        },
      }),
    /必须包含 error/u,
  );
});
