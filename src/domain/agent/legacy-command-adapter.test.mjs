import assert from "node:assert/strict";
import test from "node:test";

import { toLegacyAcpRequest } from "./legacy-command-adapter.ts";

const open = (overrides = {}) =>
  toLegacyAcpRequest({
    protocolVersion: 1,
    requestId: 7,
    command: {
      type: "session.open",
      cwd: "/tmp/project",
      permissionMode: "ask",
      ...overrides,
    },
  });

test("maps product session.open to ACP without exposing a second protocol", () => {
  assert.deepEqual(open(), {
    jsonrpc: "2.0",
    id: 7,
    method: "session/new",
    params: {
      cwd: "/tmp/project",
      mcpServers: [],
      _meta: {
        clientIdentifier: "melody-work",
        yoloMode: false,
        autoMode: false,
      },
    },
  });
  assert.equal(
    open({ sessionId: "native-1", modelId: "model-1" }).method,
    "session/load",
  );
  assert.equal(open({ sessionId: "native-1" }).params.sessionId, "native-1");
});

test("keeps product permission modes explicit in the legacy mapping", () => {
  const acp = open({ permissionMode: "always-approve" });
  assert.equal(acp.params._meta.yoloMode, true);
  assert.equal(acp.params._meta.autoMode, false);
  assert.equal(open({ permissionMode: "auto" }).params._meta.autoMode, true);
});

test("maps runtime authentication and session configuration explicitly", () => {
  assert.deepEqual(
    toLegacyAcpRequest({
      protocolVersion: 1,
      requestId: 2,
      command: {
        type: "runtime.authenticate",
        methodId: "oauth",
        headless: false,
      },
    }),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "authenticate",
      params: { methodId: "oauth", _meta: { headless: false } },
    },
  );
  assert.deepEqual(
    toLegacyAcpRequest({
      protocolVersion: 1,
      requestId: 4,
      command: {
        type: "session.configure",
        sessionId: "session-1",
        modelId: "model-1",
        reasoningEffort: "high",
      },
    }),
    {
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_model",
      params: {
        sessionId: "session-1",
        modelId: "model-1",
        _meta: { reasoningEffort: "high" },
      },
    },
  );
  assert.equal(
    toLegacyAcpRequest({
      protocolVersion: 1,
      requestId: 6,
      command: {
        type: "session.configure",
        sessionId: "session-1",
        sessionModeId: "plan",
      },
    }).method,
    "session/set_mode",
  );
});

test("does not leak future Pi config fields into a legacy prompt", () => {
  const prompt = toLegacyAcpRequest({
    protocolVersion: 1,
    requestId: 100,
    command: {
      type: "turn.submit",
      sessionId: "session-1",
      promptId: "prompt-1",
      content: "hello",
      attachments: [],
      config: {
        modelId: "model-1",
        reasoningEffort: "high",
        permissionMode: "ask",
        configRevision: 0,
      },
    },
  });
  assert.deepEqual(prompt.params._meta, { promptId: "prompt-1" });
});

test("maps cancellation and interaction resolution to their ACP forms", () => {
  const cancel = toLegacyAcpRequest({
    protocolVersion: 1,
    requestId: "cancel-1",
    command: {
      type: "turn.cancel",
      sessionId: "session-1",
      cancelSubagents: true,
      reason: "user",
    },
  });
  assert.equal(cancel.method, "session/cancel");
  assert.equal(cancel.params._meta.cancelSubagents, true);

  assert.deepEqual(
    toLegacyAcpRequest({
      protocolVersion: 1,
      requestId: 9,
      command: {
        type: "interaction.resolve",
        sessionId: "session-1",
        interactionId: "permission-1",
        resolution: { outcome: "allow_once" },
      },
    }),
    { jsonrpc: "2.0", id: 9, result: { outcome: "allow_once" } },
  );
});
