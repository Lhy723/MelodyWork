import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentCommandEnvelope } from "./validation.ts";

const importEnvelope = (backup) => ({
  protocolVersion: 1,
  requestId: "request-1",
  command: {
    type: "session.import",
    sessionId: "session-1",
    migrationId: "migration-1",
    cwd: "/workspace/demo",
    plan: { version: 1, entries: [] },
    ...(backup === undefined ? {} : { backup }),
  },
});

test("session.import requires an explicit backup choice", () => {
  assert.throws(
    () => validateAgentCommandEnvelope(importEnvelope(undefined)),
    /session\.import\.backup/u,
  );
  assert.doesNotThrow(() => validateAgentCommandEnvelope(importEnvelope(true)));
  assert.doesNotThrow(() =>
    validateAgentCommandEnvelope(importEnvelope(false)),
  );
});

test("validates a Host-owned Pi resource refresh manifest", () => {
  const envelope = {
    protocolVersion: 1,
    requestId: "resources-1",
    command: {
      type: "session.resources.refresh",
      manifest: {
        cwd: "/workspace/demo",
        skillRoots: [
          {
            path: "/workspace/demo/.agents/skills",
            scope: "project",
            disabled: ["legacy"],
          },
        ],
        promptRoots: [
          { path: "/workspace/demo/.agents/commands", disabled: [] },
        ],
        questionTimeoutPolicy: { enabled: false, timeoutMs: 12_500 },
        goalPolicy: {
          tokenBudget: 50_000,
          stallDetection: true,
          stallTimeoutSecs: 120,
          maxBlockedAttempts: 4,
        },
      },
    },
  };
  assert.doesNotThrow(() => validateAgentCommandEnvelope(envelope));
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        ...envelope,
        command: {
          ...envelope.command,
          manifest: {
            ...envelope.command.manifest,
            skillRoots: [{ path: "/tmp", scope: "project", disabled: "no" }],
          },
        },
      }),
    /disabled 必须是数组/u,
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        ...envelope,
        command: {
          ...envelope.command,
          manifest: {
            ...envelope.command.manifest,
            questionTimeoutPolicy: { enabled: true, timeoutMs: 0 },
          },
        },
      }),
    /questionTimeoutPolicy\.timeoutMs/u,
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        ...envelope,
        command: {
          ...envelope.command,
          manifest: {
            ...envelope.command.manifest,
            goalPolicy: { tokenBudget: 0 },
          },
        },
      }),
    /goalPolicy\.tokenBudget/u,
  );
});

test("accepts every Host-projected subagent capability mode on resource refresh", () => {
  const makeEnvelope = (agents) => ({
    protocolVersion: 1,
    requestId: "resources-subagents-1",
    command: {
      type: "session.resources.refresh",
      manifest: {
        cwd: "/workspace/demo",
        skillRoots: [],
        promptRoots: [],
        subagentPolicies: {
          enabled: true,
          roles: [],
          personas: [],
          agents,
          models: {},
          toggle: {},
        },
      },
    },
  });
  const supportedModes = [
    "read-only",
    "read-write",
    "read-write-execute",
    "execute",
    "all",
  ];

  for (const mode of supportedModes) {
    assert.doesNotThrow(
      () =>
        validateAgentCommandEnvelope(
          makeEnvelope([{ name: "worker", defaultCapabilityMode: mode }]),
        ),
      `Host-projected mode ${mode} must be accepted`,
    );
  }

  const agents = Array.from({ length: 8 }, (_, index) => ({
    name: `worker-${index}`,
    defaultCapabilityMode: index === 7 ? "read-write-execute" : "read-only",
  }));
  assert.doesNotThrow(() => validateAgentCommandEnvelope(makeEnvelope(agents)));

  assert.throws(
    () =>
      validateAgentCommandEnvelope(
        makeEnvelope([
          { name: "worker", defaultCapabilityMode: "unrestricted" },
        ]),
      ),
    /subagentPolicies\.agents\[0\]\.defaultCapabilityMode 不是受支持的值/u,
  );
});

test("validates the bounded Host-owned model sync payload", () => {
  const envelope = {
    protocolVersion: 1,
    requestId: "models-1",
    command: {
      type: "runtime.models.sync",
      providerIds: ["melody-demo-123"],
      credentials: [
        { name: "MELODY_PI_MODEL_KEY_0_0", value: "secret" },
        { name: "MELODY_PI_MODEL_HEADER_0_1", value: "team" },
      ],
    },
  };
  assert.doesNotThrow(() => validateAgentCommandEnvelope(envelope));
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        ...envelope,
        command: {
          ...envelope.command,
          credentials: [
            { name: "OTHER_SECRET", value: "must-not-cross-boundary" },
          ],
        },
      }),
    /Host 生成的 Pi 模型变量/u,
  );
  assert.throws(
    () =>
      validateAgentCommandEnvelope({
        ...envelope,
        command: {
          ...envelope.command,
          providerIds: ["melody-demo-123", "melody-demo-123"],
        },
      }),
    /重复项/u,
  );
});
