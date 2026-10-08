import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgentCommandCapabilities,
  supportsAgentCommand,
  unsupportedAgentCommandCapabilities,
} from "./capabilities.ts";

const capabilities = {
  engine: "pi",
  engineVersion: "1.0.1",
  protocolVersion: 1,
  authentication: false,
  modelCatalog: true,
  tools: ["workspace_read_file"],
  sessionTree: true,
  compaction: true,
  plans: false,
  questions: false,
  permissions: false,
  subagents: false,
  backgroundTasks: false,
  mcp: false,
  media: ["image-input"],
};

const submit = (permissionMode = "ask", attachments = []) => ({
  type: "turn.submit",
  sessionId: "session-1",
  promptId: "prompt-1",
  content: "hello",
  attachments,
  config: {
    permissionMode,
    configRevision: 1,
  },
});

test("reports every missing capability without changing the command", () => {
  const command = submit("ask", [
    { url: "data:image/png;base64,aGk=", mediaType: "image/png" },
  ]);
  const missing = unsupportedAgentCommandCapabilities(command, capabilities);
  assert.deepEqual(
    missing.map((item) => item.capability),
    ["permissions"],
  );
  assert.equal(command.config.permissionMode, "ask");
});

test("allows the current read-only Pi subset and rejects unsupported interactions", () => {
  assert.equal(
    supportsAgentCommand(submit("always-approve"), capabilities),
    true,
  );
  assert.throws(
    () =>
      assertAgentCommandCapabilities(
        {
          protocolVersion: 1,
          requestId: "request-1",
          command: { type: "runtime.authenticate", methodId: "oauth" },
        },
        capabilities,
      ),
    (error) =>
      error?.agentError?.code === "agent.capability_unavailable" &&
      /authentication/u.test(error.message),
  );
  assert.deepEqual(
    unsupportedAgentCommandCapabilities(
      {
        type: "interaction.resolve",
        sessionId: "session-1",
        interactionId: "plan-1",
        resolution: { outcome: "approved" },
      },
      capabilities,
      { interactionKind: "plan" },
    ).map((item) => item.capability),
    ["plans"],
  );
});

test("keeps image attachment checks separate from permission checks", () => {
  const noImage = { ...capabilities, media: [] };
  const missing = unsupportedAgentCommandCapabilities(
    submit("always-approve", [
      { url: "data:image/png;base64,aGk=", mediaType: "image/png" },
    ]),
    noImage,
  );
  assert.deepEqual(
    missing.map((item) => item.capability),
    ["media:image-input"],
  );
});
