import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PI_RUN_TERMINAL_COMMAND,
  PI_MONITOR,
  PI_SCHEDULER_CREATE,
  PI_SCHEDULER_LIST,
  PI_SCHEDULER_DELETE,
  PI_RUN_BACKGROUND_TASK,
  PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
  PI_TASK,
  PI_WAIT_TASKS,
  PI_KILL_TASK,
  PI_WAIT_COMMANDS_OR_SUBAGENTS,
  PI_KILL_COMMAND_OR_SUBAGENT,
  PI_SPAWN_SUBAGENT,
  PI_UPDATE_PLAN,
  PI_ASK_USER_QUESTION,
  PI_WORKSPACE_READ_FILE,
  PI_WORKSPACE_READ_TOOL_OUTPUT,
  PI_WORKSPACE_SEARCH,
  PI_WORKSPACE_LIST_DIRECTORY,
  PI_WORKSPACE_EDIT,
  PI_WORKSPACE_APPLY_PATCH,
  PI_WORKSPACE_WRITE_FILE,
  PI_MCP_LIST_TOOLS,
  PI_MCP_CALL_TOOL,
  PI_MEMORY_REMEMBER,
  PI_BROWSER_NAVIGATE,
  PI_BROWSER_TABS,
  PI_BROWSER_SNAPSHOT,
  PI_BROWSER_WAIT,
  PI_BROWSER_SCREENSHOT,
  PI_BROWSER_CLICK,
  PI_BROWSER_TYPE,
  PI_BROWSER_TAB_OPEN,
  PI_BROWSER_TAB_SELECT,
  PI_BROWSER_TAB_CLOSE,
  PI_LSP,
  PI_CODEBASE_NAVIGATION,
  PI_INTERNAL_INSTRUCTION_SCOPE,
  piInstructionScopePathsFor,
  INTERACTION_TIMEOUT_MS,
  PiToolGateway,
  interactionTimeoutMsFor,
  sessionModeAllowsTool,
  intersectPiSubagentCapabilityModes,
  normalizePiSubagentCapabilityMode,
  normalizePiSubagentIsolation,
  subagentCapabilityAllowsTool,
} from "./tool-gateway.ts";
import { createPiInstructionScope } from "./instruction-scope-extension.ts";

test("normalizes subagent isolation aliases and fails closed", () => {
  assert.equal(normalizePiSubagentIsolation(undefined), undefined);
  assert.equal(normalizePiSubagentIsolation("none"), "none");
  assert.equal(normalizePiSubagentIsolation("work_tree"), "worktree");
  assert.equal(normalizePiSubagentIsolation("WORK-TREE"), "worktree");
  assert.throws(
    () => normalizePiSubagentIsolation("shared"),
    (error) => error?.agentError?.code === "pi.invalid_subagent_isolation",
  );
});

test("subagent capability modes form a fail-closed tool policy", () => {
  assert.equal(normalizePiSubagentCapabilityMode(undefined), undefined);
  assert.equal(normalizePiSubagentCapabilityMode("read_only"), "read-only");
  assert.equal(normalizePiSubagentCapabilityMode("readwrite"), "read-write");
  assert.equal(normalizePiSubagentCapabilityMode("EXECUTE"), "execute");
  assert.equal(normalizePiSubagentCapabilityMode("all"), "all");
  assert.throws(
    () => normalizePiSubagentCapabilityMode("shell"),
    (error) =>
      error?.agentError?.code === "pi.invalid_subagent_capability_mode",
  );

  assert.equal(
    intersectPiSubagentCapabilityModes("read-write", "execute"),
    "read-only",
  );
  assert.equal(intersectPiSubagentCapabilityModes("all", "execute"), "execute");
  assert.equal(
    intersectPiSubagentCapabilityModes(undefined, "read-only"),
    "read-only",
  );
  assert.equal(
    subagentCapabilityAllowsTool("read-only", PI_WORKSPACE_READ_FILE),
    true,
  );
  assert.equal(
    subagentCapabilityAllowsTool("read-only", PI_WORKSPACE_WRITE_FILE),
    false,
  );
  assert.equal(
    subagentCapabilityAllowsTool("read-write", PI_WORKSPACE_EDIT),
    true,
  );
  assert.equal(
    subagentCapabilityAllowsTool("read-write", PI_RUN_TERMINAL_COMMAND),
    false,
  );
  assert.equal(
    subagentCapabilityAllowsTool("execute", PI_RUN_TERMINAL_COMMAND),
    true,
  );
  assert.equal(
    subagentCapabilityAllowsTool("execute", PI_WORKSPACE_WRITE_FILE),
    false,
  );
  // A definition that asks for file mutation and a terminal together must not
  // need the unrestricted ceiling.
  assert.equal(
    normalizePiSubagentCapabilityMode("read-write-execute"),
    "read-write-execute",
  );
  assert.equal(
    intersectPiSubagentCapabilityModes("read-write-execute", "execute"),
    "execute",
  );
  assert.equal(
    intersectPiSubagentCapabilityModes("read-write-execute", "read-write"),
    "read-write",
  );
  assert.equal(
    intersectPiSubagentCapabilityModes("read-write-execute", "read-only"),
    "read-only",
  );
  assert.equal(
    intersectPiSubagentCapabilityModes("read-write-execute", "all"),
    "read-write-execute",
  );
  assert.equal(
    subagentCapabilityAllowsTool("read-write-execute", PI_WORKSPACE_WRITE_FILE),
    true,
  );
  assert.equal(
    subagentCapabilityAllowsTool("read-write-execute", PI_RUN_TERMINAL_COMMAND),
    true,
  );
  assert.equal(
    subagentCapabilityAllowsTool("read-write-execute", PI_MCP_CALL_TOOL),
    false,
    "the narrower ceiling still withholds MCP calls",
  );
  assert.equal(subagentCapabilityAllowsTool("all", PI_MCP_CALL_TOOL), true);
});

test("createTools omits tools outside a subagent capability mode", () => {
  const gateway = new PiToolGateway(async () => undefined);
  const readOnly = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    undefined,
    undefined,
    () => "default",
    undefined,
    undefined,
    undefined,
    () => "read-only",
  );
  const readOnlyNames = new Set(readOnly.map((tool) => tool.name));
  assert.equal(readOnlyNames.has(PI_WORKSPACE_READ_FILE), true);
  assert.equal(readOnlyNames.has(PI_WORKSPACE_WRITE_FILE), false);
  assert.equal(readOnlyNames.has(PI_MEMORY_REMEMBER), false);
  assert.equal(readOnlyNames.has(PI_LSP), true);
  assert.equal(readOnlyNames.has(PI_CODEBASE_NAVIGATION), true);
  assert.equal(readOnlyNames.has(PI_RUN_TERMINAL_COMMAND), false);

  const execute = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    undefined,
    undefined,
    () => "default",
    undefined,
    undefined,
    undefined,
    () => "execute",
  );
  const executeNames = new Set(execute.map((tool) => tool.name));
  assert.equal(executeNames.has(PI_RUN_TERMINAL_COMMAND), true);
  assert.equal(executeNames.has(PI_WORKSPACE_EDIT), false);
  assert.equal(executeNames.has(PI_MCP_CALL_TOOL), false);
});

test("grants a bounded child only the MCP tools its definition named", async () => {
  let toolRequest;
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "tool.requested") toolRequest = event;
  });
  const withGrant = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    undefined,
    undefined,
    () => "default",
    undefined,
    undefined,
    undefined,
    () => "read-write",
    () => new Set(["mcp__zotero__zotero_search_items"]),
  );
  const names = new Set(withGrant.map((tool) => tool.name));
  assert.equal(
    names.has(PI_MCP_CALL_TOOL),
    true,
    "an explicit grant makes the call tool reachable",
  );

  const callTool = withGrant.find((tool) => tool.name === PI_MCP_CALL_TOOL);
  await assert.rejects(
    () =>
      callTool.execute("call-mcp", {
        server: "zotero",
        tool: "zotero_delete_everything",
      }),
    (error) => error?.agentError?.code === "pi.subagent_capability_restricted",
    "a tool outside the grant must be rejected before it reaches the Host",
  );

  // A granted pair passes the capability check; the mocked bridge then fails
  // for its own reasons, which must not be the capability error.
  const grantedCall = callTool.execute("call-mcp-2", {
    server: "zotero",
    tool: "zotero_search_items",
  });
  for (let attempt = 0; attempt < 4 && !toolRequest; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  assert.equal(toolRequest?.event.toolName, PI_MCP_CALL_TOOL);
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-mcp-2",
    resolution: { status: "completed", output: "mock MCP result" },
  });
  assert.equal((await grantedCall).content[0].text, "mock MCP result");

  // Without any grant a bounded child cannot call MCP tools at all.
  const withoutGrant = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    undefined,
    undefined,
    () => "default",
    undefined,
    undefined,
    undefined,
    () => "read-write",
    () => new Set(),
  );
  assert.equal(
    withoutGrant.some((tool) => tool.name === PI_MCP_CALL_TOOL),
    false,
  );
});

test("projects the Host question timeout policy only into question interactions", () => {
  assert.equal(
    interactionTimeoutMsFor("question", { enabled: false, timeoutMs: 12_000 }),
    0,
  );
  assert.equal(
    interactionTimeoutMsFor("question", { enabled: true, timeoutMs: 12_000 }),
    12_000,
  );
  assert.equal(
    interactionTimeoutMsFor("permission", {
      enabled: false,
      timeoutMs: 12_000,
    }),
    INTERACTION_TIMEOUT_MS,
  );
  assert.equal(
    interactionTimeoutMsFor("question", { enabled: true, timeoutMs: 0 }),
    INTERACTION_TIMEOUT_MS,
  );
});

test("applies the projected question timeout to the ask-user tool", async () => {
  let interaction;
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "interaction.requested") interaction = event;
  });
  const tools = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    undefined,
    undefined,
    () => "default",
    undefined,
    undefined,
    () => ({ enabled: true, timeoutMs: 10 }),
  );
  const question = tools.find((tool) => tool.name === PI_ASK_USER_QUESTION);
  assert.ok(question);

  await assert.rejects(
    question.execute("call-question-timeout", {
      question: "Continue?",
    }),
    (error) => error?.agentError?.code === "pi.interaction_timeout",
  );
  assert.equal(
    interaction?.event.interactionId,
    "session-1:question:call-question-timeout",
  );
});

test("ToolGateway emits a request and resumes after a host resolution", async () => {
  let request;
  const gateway = new PiToolGateway(async (event) => {
    request = event;
  });

  const pending = gateway.request({
    sessionId: "session-1",
    runId: "run-1",
    cwd: "/tmp/project",
    toolCallId: "call-1",
    toolName: PI_WORKSPACE_READ_FILE,
    arguments: { path: "README.md" },
  });

  await Promise.resolve();
  assert.equal(request?.event.type, "tool.requested");
  assert.equal(request?.event.toolCallId, "call-1");
  assert.deepEqual(request?.event.activity, {
    gateway: "melody",
    arguments: { path: "README.md" },
    cwd: "/tmp/project",
  });

  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-1",
    resolution: { status: "completed", output: "contents" },
  });
  assert.throws(
    () =>
      gateway.resolve({
        type: "tool.resolve",
        sessionId: "session-1",
        runId: "run-1",
        toolCallId: "call-1",
        resolution: { status: "completed", output: "duplicate" },
      }),
    /没有等待中的 Pi tool call/u,
  );
  assert.deepEqual(await pending, {
    status: "completed",
    output: "contents",
  });
});

test("exposes Melody-compatible directory listing through the Host gateway", async () => {
  let request;
  const gateway = new PiToolGateway(async (event) => {
    request = event;
  });
  const tools = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    undefined,
    () => "session-1",
    () => "default",
  );
  const listDirectory = tools.find(
    (tool) => tool.name === PI_WORKSPACE_LIST_DIRECTORY,
  );
  assert.ok(listDirectory);

  const pending = listDirectory.execute("call-directory", {
    path: "src",
    depth: 2,
    includeHidden: false,
  });
  await Promise.resolve();
  assert.equal(request?.event.type, "tool.requested");
  assert.equal(request?.event.toolName, PI_WORKSPACE_LIST_DIRECTORY);
  assert.deepEqual(request?.event.activity, {
    gateway: "melody",
    arguments: { path: "src", depth: 2, includeHidden: false },
    cwd: "/tmp/project",
    permissionMode: "always-approve",
    approved: false,
  });

  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-directory",
    resolution: {
      status: "completed",
      output: "- src/\n  - src/main.ts",
    },
  });
  assert.equal((await pending).content[0].text, "- src/\n  - src/main.ts");
});

test("projects the Host gitignore policy only into workspace search and listing requests", async () => {
  const requests = [];
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "tool.requested") requests.push(event);
  });
  const tools = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    undefined,
    () => "session-1",
    () => "default",
    undefined,
    () => true,
  );
  const search = tools.find((tool) => tool.name === PI_WORKSPACE_SEARCH);
  const listDirectory = tools.find(
    (tool) => tool.name === PI_WORKSPACE_LIST_DIRECTORY,
  );
  assert.ok(search);
  assert.ok(listDirectory);

  const searchPending = search.execute("call-search-ignore", {
    query: "needle",
  });
  await Promise.resolve();
  assert.deepEqual(requests[0]?.event.activity.arguments, {
    query: "needle",
    respectGitignore: true,
  });
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-search-ignore",
    resolution: { status: "completed", output: "ok" },
  });
  await searchPending;

  const listPending = listDirectory.execute("call-list-ignore", {
    path: ".",
  });
  await Promise.resolve();
  assert.deepEqual(requests[1]?.event.activity.arguments, {
    path: ".",
    respectGitignore: true,
  });
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-list-ignore",
    resolution: { status: "completed", output: "ok" },
  });
  await listPending;
});

test("ToolGateway rejects a stale run response without consuming the pending call", async () => {
  const gateway = new PiToolGateway(async () => undefined);
  const pending = gateway.request({
    sessionId: "session-1",
    runId: "run-current",
    toolCallId: "call-run-check",
    toolName: PI_WORKSPACE_READ_FILE,
    arguments: { path: "README.md" },
  });
  await assert.rejects(
    Promise.resolve().then(() =>
      gateway.resolve({
        type: "tool.resolve",
        sessionId: "session-1",
        runId: "run-stale",
        toolCallId: "call-run-check",
        resolution: { status: "completed", output: "wrong" },
      }),
    ),
    (error) => error?.agentError?.code === "pi.tool_call_run_mismatch",
  );
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-current",
    toolCallId: "call-run-check",
    resolution: { status: "completed", output: "right" },
  });
  assert.equal((await pending).output, "right");
});

test("ToolGateway rejects duplicate call IDs and ignores no unresolved call", async () => {
  const gateway = new PiToolGateway(async () => undefined);
  const pending = gateway.request({
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: PI_WORKSPACE_READ_FILE,
    arguments: { path: "README.md" },
  });
  await assert.rejects(
    gateway.request({
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: PI_WORKSPACE_READ_FILE,
      arguments: { path: "README.md" },
    }),
    /已在等待宿主响应/,
  );
  gateway.rejectAll();
  await assert.rejects(pending, /Pi worker 已关闭/);
  assert.throws(
    () =>
      gateway.resolve({
        type: "tool.resolve",
        sessionId: "session-1",
        toolCallId: "call-1",
        resolution: {
          status: "completed",
          output: "late",
        },
      }),
    /没有等待中的 Pi tool call/,
  );
});

test("does not leak a rejected interaction-resolved event after resolving Pi", async () => {
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "interaction.resolved") {
      throw new Error("writer closed");
    }
  });
  const pending = gateway.requestInteraction({
    sessionId: "session-1",
    runId: "run-1",
    interactionId: "interaction-1",
    kind: "question",
    payload: { question: "Continue?" },
  });
  await Promise.resolve();
  gateway.resolveInteraction({
    type: "interaction.resolve",
    sessionId: "session-1",
    interactionId: "interaction-1",
    resolution: { outcome: "skip" },
  });
  assert.deepEqual(await pending, { outcome: "skip" });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
});

test("permission interactions expose only a stable raw input identity", async () => {
  let interaction;
  let toolRequest;
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "interaction.requested") interaction = event;
    if (event.event.type === "tool.requested") toolRequest = event;
  });
  const flush = () =>
    new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  const tools = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "ask",
    () => "/tmp/project",
  );
  const writeTool = tools.find((tool) => tool.name === PI_WORKSPACE_WRITE_FILE);
  assert.ok(writeTool);

  const pending = writeTool.execute("call-1", {
    path: "src/generated.txt",
    content: "do not put this in the permission event",
  });
  await Promise.resolve();
  assert.deepEqual(interaction?.event.payload.rawInput, {
    path: "src/generated.txt",
  });
  assert.equal(interaction?.event.payload.title, PI_WORKSPACE_WRITE_FILE);

  gateway.resolveInteraction({
    type: "interaction.resolve",
    sessionId: "session-1",
    interactionId: "session-1:permission:call-1",
    resolution: { outcome: { outcome: "selected", optionId: "allow_once" } },
  });
  // The tool then waits for the Host-owned tool resolution.
  for (let attempt = 0; attempt < 4 && !toolRequest; attempt += 1) {
    await flush();
  }
  assert.ok(toolRequest);
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-1",
    resolution: { status: "completed", output: "written" },
  });
  assert.equal((await pending).content[0].text, "written");

  // Terminal requests use the command as their stable identity.
  const terminal = tools.find((tool) => tool.name === PI_RUN_TERMINAL_COMMAND);
  assert.ok(terminal);
  const terminalPending = terminal.execute("call-2", {
    command: "git status --short",
  });
  for (
    let attempt = 0;
    attempt < 4 && interaction?.event.payload.toolCallId !== "call-2";
    attempt += 1
  ) {
    await flush();
  }
  assert.equal(
    interaction?.event.payload.rawInput.command,
    "git status --short",
  );
  gateway.resolveInteraction({
    type: "interaction.resolve",
    sessionId: "session-1",
    interactionId: "session-1:permission:call-2",
    resolution: { outcome: { outcome: "selected", optionId: "reject_once" } },
  });
  await assert.rejects(terminalPending, /用户拒绝了这次工具调用/);
});

test("loads newly applicable AGENTS.md before repeating a workspace path tool", async () => {
  const events = [];
  const gateway = new PiToolGateway(async (event) => events.push(event));
  const scope = createPiInstructionScope();
  const extensionHandlers = new Map();
  scope.extensionFactory({
    on: (name, handler) => extensionHandlers.set(name, handler),
  });
  const flush = () =>
    new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  const tools = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "auto",
    () => "/tmp/project",
    undefined,
    () => "session-1",
    () => "default",
    undefined,
    () => false,
    () => undefined,
    undefined,
    undefined,
    scope.activate,
  );
  const read = tools.find((tool) => tool.name === PI_WORKSPACE_READ_FILE);
  assert.ok(read);
  const scopedOutput = JSON.stringify({
    files: [{ path: "packages/AGENTS.md", content: "Use pnpm test." }],
  });
  const resolveScope = (toolCallId) =>
    gateway.resolve({
      type: "tool.resolve",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: `${PI_INTERNAL_INSTRUCTION_SCOPE}:${toolCallId}`,
      resolution: { status: "completed", output: scopedOutput },
    });

  const first = read.execute("call-1", { path: "packages/worker/src.ts" });
  for (let attempt = 0; attempt < 5 && events.length === 0; attempt += 1) {
    await flush();
  }
  assert.equal(events[0].event.toolName, PI_INTERNAL_INSTRUCTION_SCOPE);
  resolveScope("call-1");
  assert.match((await first).content[0].text, /尚未执行原文件操作/u);
  assert.equal(
    events.some((event) => event.event.toolName === PI_WORKSPACE_READ_FILE),
    false,
  );

  const nextPrompt = {
    systemPromptOptions: { contextFiles: [] },
  };
  extensionHandlers.get("before_agent_start")(nextPrompt);
  assert.equal(nextPrompt.systemPromptOptions.contextFiles.length, 1);

  const second = read.execute("call-2", { path: "packages/worker/src.ts" });
  for (let attempt = 0; attempt < 5 && events.length < 2; attempt += 1) {
    await flush();
  }
  resolveScope("call-2");
  for (
    let attempt = 0;
    attempt < 5 && !events.some((event) => event.event.toolCallId === "call-2");
    attempt += 1
  ) {
    await flush();
  }
  const actual = events.find((event) => event.event.toolCallId === "call-2");
  assert.equal(actual.event.toolName, PI_WORKSPACE_READ_FILE);
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-2",
    resolution: { status: "completed", output: "file contents" },
  });
  assert.equal((await second).content[0].text, "file contents");
});

test("collects directory targets from path tools and Melody patch headers", () => {
  assert.deepEqual(
    piInstructionScopePathsFor(PI_WORKSPACE_READ_FILE, { path: "src/app.ts" }),
    ["src/app.ts"],
  );
  assert.deepEqual(
    piInstructionScopePathsFor(PI_WORKSPACE_APPLY_PATCH, {
      patch:
        "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** Add File: docs/new.md\n*** End Patch",
    }),
    ["src/a.ts", "src/b.ts", "docs/new.md"],
  );
});

test("memory remember exposes only its scope in the permission identity", async () => {
  let interaction;
  let toolRequest;
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "interaction.requested") interaction = event;
    if (event.event.type === "tool.requested") toolRequest = event;
  });
  const tool = gateway
    .createTools(
      () => "session-1",
      () => "run-1",
      () => "ask",
      () => "/tmp/project",
    )
    .find((entry) => entry.name === PI_MEMORY_REMEMBER);
  assert.ok(tool);

  const pending = tool.execute("call-memory", {
    content: "Do not put this note in the permission event",
    scope: "global",
  });
  await Promise.resolve();
  assert.deepEqual(interaction?.event.payload.rawInput, { scope: "global" });

  gateway.resolveInteraction({
    type: "interaction.resolve",
    sessionId: "session-1",
    interactionId: "session-1:permission:call-memory",
    resolution: { outcome: { outcome: "selected", optionId: "allow_once" } },
  });
  for (let attempt = 0; attempt < 4 && !toolRequest; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  assert.equal(toolRequest?.event.toolName, PI_MEMORY_REMEMBER);
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-memory",
    resolution: { status: "completed", output: "saved" },
  });
  assert.equal((await pending).content[0].text, "saved");
});

test("browser actions always ask once and never offer a persistent allow", async () => {
  let interaction;
  let toolRequest;
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "interaction.requested") interaction = event;
    if (event.event.type === "tool.requested") toolRequest = event;
  });
  const tool = gateway
    .createTools(
      () => "session-1",
      () => "run-1",
      () => "always-approve",
      () => "/tmp/project",
    )
    .find((entry) => entry.name === PI_BROWSER_NAVIGATE);
  assert.ok(tool);

  const pending = tool.execute("call-browser-nav", {
    url: "https://example.com/path?private=value",
  });
  await Promise.resolve();
  assert.equal(interaction?.event.kind, "permission");
  assert.deepEqual(interaction?.event.payload.rawInput, {
    command: "https://example.com/path",
  });
  assert.equal(
    interaction?.event.payload.options.some(
      (option) => option.optionId === "allow_always",
    ),
    false,
  );

  gateway.resolveInteraction({
    type: "interaction.resolve",
    sessionId: "session-1",
    interactionId: "session-1:permission:call-browser-nav",
    resolution: { outcome: { outcome: "selected", optionId: "allow_once" } },
  });
  for (let attempt = 0; attempt < 4 && !toolRequest; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  assert.equal(toolRequest?.event.toolName, PI_BROWSER_NAVIGATE);
  assert.equal(toolRequest?.event.activity.approved, true);
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-browser-nav",
    resolution: { status: "completed", output: "navigated" },
  });
  assert.equal((await pending).content[0].text, "navigated");
});

test("browser screenshot requires approval and returns model-facing image content", async () => {
  let interaction;
  let toolRequest;
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "interaction.requested") interaction = event;
    if (event.event.type === "tool.requested") toolRequest = event;
  });
  const tool = gateway
    .createTools(
      () => "session-1",
      () => "run-1",
      () => "always-approve",
      () => "/tmp/project",
    )
    .find((entry) => entry.name === PI_BROWSER_SCREENSHOT);
  assert.ok(tool);

  const pending = tool.execute("call-browser-screenshot", {});
  await Promise.resolve();
  assert.equal(interaction?.event.kind, "permission");
  assert.equal(
    interaction?.event.payload.options.some(
      (option) => option.optionId === "allow_always",
    ),
    false,
  );
  gateway.resolveInteraction({
    type: "interaction.resolve",
    sessionId: "session-1",
    interactionId: "session-1:permission:call-browser-screenshot",
    resolution: { outcome: { outcome: "selected", optionId: "allow_once" } },
  });
  for (let attempt = 0; attempt < 4 && !toolRequest; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  assert.equal(toolRequest?.event.toolName, PI_BROWSER_SCREENSHOT);
  assert.equal(toolRequest?.event.activity.approved, true);
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-browser-screenshot",
    resolution: {
      status: "completed",
      output: "data:image/jpeg;base64,aGVsbG8=",
    },
  });
  const result = await pending;
  assert.deepEqual(result.content, [
    { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
    { type: "text", text: "Current approved Browser viewport screenshot." },
  ]);
  assert.equal(result.details.approved, true);
});

test("browser tab listing is read-only and exposes current tab IDs", async () => {
  let interaction;
  let toolRequest;
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "interaction.requested") interaction = event;
    if (event.event.type === "tool.requested") toolRequest = event;
  });
  const tool = gateway
    .createTools(
      () => "session-1",
      () => "run-1",
      () => "always-approve",
      () => "/tmp/project",
    )
    .find((entry) => entry.name === PI_BROWSER_TABS);
  assert.ok(tool);

  const pending = tool.execute("call-browser-tabs", {});
  for (let attempt = 0; attempt < 4 && !toolRequest; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  assert.equal(interaction, undefined);
  assert.equal(toolRequest?.event.toolName, PI_BROWSER_TABS);
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-browser-tabs",
    resolution: {
      status: "completed",
      output: '{"activeTabId":"tab-1","tabs":[{"id":"tab-1","active":true}]}',
    },
  });
  assert.match((await pending).content[0].text, /tab-1/u);
});

test("browser_wait is a read-only condition wait with a bounded result", async () => {
  let interaction;
  let toolRequest;
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "interaction.requested") interaction = event;
    if (event.event.type === "tool.requested") toolRequest = event;
  });
  const tool = gateway
    .createTools(
      () => "session-1",
      () => "run-1",
      () => "always-approve",
      () => "/tmp/project",
    )
    .find((entry) => entry.name === PI_BROWSER_WAIT);
  assert.ok(tool);

  const pending = tool.execute("call-browser-wait", {
    url_contains: "example.com",
    text_contains: "Ready",
    timeout_ms: 750,
  });
  for (let attempt = 0; attempt < 4 && !toolRequest; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  assert.equal(interaction, undefined);
  assert.equal(toolRequest?.event.toolName, PI_BROWSER_WAIT);
  assert.deepEqual(toolRequest?.event.activity.arguments, {
    url_contains: "example.com",
    text_contains: "Ready",
    timeout_ms: 750,
  });
  gateway.resolve({
    type: "tool.resolve",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "call-browser-wait",
    resolution: {
      status: "completed",
      output: '{"matched":true,"snapshot":{"text":"Ready"}}',
    },
  });
  assert.match((await pending).content[0].text, /"matched":true/u);
  assert.equal(sessionModeAllowsTool("plan", PI_BROWSER_WAIT), true);
  assert.equal(sessionModeAllowsTool("ask", PI_BROWSER_WAIT), true);
});

test("browser tab lifecycle tools require one-time approval", async () => {
  let interaction;
  let toolRequest;
  const gateway = new PiToolGateway(async (event) => {
    if (event.event.type === "interaction.requested") interaction = event;
    if (event.event.type === "tool.requested") toolRequest = event;
  });
  const tools = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
  );

  for (const [toolName, callId, params] of [
    [PI_BROWSER_TAB_OPEN, "call-tab-open", { url: "https://example.com" }],
    [PI_BROWSER_TAB_SELECT, "call-tab-select", { tab_id: "tab-1" }],
    [PI_BROWSER_TAB_CLOSE, "call-tab-close", { tab_id: "tab-1" }],
  ]) {
    interaction = undefined;
    toolRequest = undefined;
    const tool = tools.find((entry) => entry.name === toolName);
    assert.ok(tool);
    const pending = tool.execute(callId, params);
    await Promise.resolve();
    assert.equal(interaction?.event.kind, "permission");
    assert.equal(
      interaction?.event.payload.options.some(
        (option) => option.optionId === "allow_always",
      ),
      false,
    );
    gateway.resolveInteraction({
      type: "interaction.resolve",
      sessionId: "session-1",
      interactionId: `session-1:permission:${callId}`,
      resolution: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    for (let attempt = 0; attempt < 4 && !toolRequest; attempt += 1) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
    assert.equal(toolRequest?.event.toolName, toolName);
    assert.equal(toolRequest?.event.activity.approved, true);
    gateway.resolve({
      type: "tool.resolve",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: callId,
      resolution: { status: "completed", output: '{"tabs":[]}' },
    });
    assert.equal((await pending).content[0].text, '{"tabs":[]}');
  }
});

test("session modes enforce their tool policy before permission prompts", async () => {
  assert.equal(sessionModeAllowsTool("default", PI_WORKSPACE_WRITE_FILE), true);
  assert.equal(sessionModeAllowsTool("default", PI_MCP_CALL_TOOL), true);
  assert.equal(sessionModeAllowsTool("plan", PI_MCP_LIST_TOOLS), true);
  assert.equal(sessionModeAllowsTool("plan", PI_LSP), true);
  assert.equal(sessionModeAllowsTool("plan", PI_CODEBASE_NAVIGATION), true);
  assert.equal(sessionModeAllowsTool("plan", PI_BROWSER_SNAPSHOT), true);
  assert.equal(sessionModeAllowsTool("plan", PI_BROWSER_SCREENSHOT), true);
  assert.equal(sessionModeAllowsTool("plan", PI_BROWSER_TABS), true);
  assert.equal(sessionModeAllowsTool("ask", PI_MCP_LIST_TOOLS), true);
  assert.equal(sessionModeAllowsTool("ask", PI_LSP), true);
  assert.equal(sessionModeAllowsTool("ask", PI_CODEBASE_NAVIGATION), true);
  assert.equal(sessionModeAllowsTool("ask", PI_BROWSER_SNAPSHOT), true);
  assert.equal(sessionModeAllowsTool("ask", PI_BROWSER_SCREENSHOT), true);
  assert.equal(sessionModeAllowsTool("ask", PI_BROWSER_TABS), true);
  for (const toolName of [
    PI_BROWSER_TAB_OPEN,
    PI_BROWSER_TAB_SELECT,
    PI_BROWSER_TAB_CLOSE,
  ]) {
    assert.equal(sessionModeAllowsTool("plan", toolName), false);
    assert.equal(sessionModeAllowsTool("ask", toolName), false);
  }
  for (const mode of ["plan", "ask"]) {
    assert.equal(sessionModeAllowsTool(mode, PI_BROWSER_NAVIGATE), false);
    assert.equal(sessionModeAllowsTool(mode, PI_BROWSER_CLICK), false);
    assert.equal(sessionModeAllowsTool(mode, PI_BROWSER_TYPE), false);
  }
  assert.equal(sessionModeAllowsTool("plan", PI_MCP_CALL_TOOL), false);
  assert.equal(sessionModeAllowsTool("ask", PI_MCP_CALL_TOOL), false);
  assert.equal(sessionModeAllowsTool("plan", PI_WORKSPACE_READ_FILE), true);
  assert.equal(
    sessionModeAllowsTool("plan", PI_WORKSPACE_LIST_DIRECTORY),
    true,
  );
  assert.equal(
    sessionModeAllowsTool("plan", PI_WORKSPACE_READ_TOOL_OUTPUT),
    true,
  );
  assert.equal(sessionModeAllowsTool("plan", PI_UPDATE_PLAN), true);
  assert.equal(sessionModeAllowsTool("plan", PI_WORKSPACE_APPLY_PATCH), false);
  assert.equal(sessionModeAllowsTool("ask", PI_WORKSPACE_SEARCH), true);
  assert.equal(sessionModeAllowsTool("ask", PI_WORKSPACE_LIST_DIRECTORY), true);
  assert.equal(
    sessionModeAllowsTool("ask", PI_WORKSPACE_READ_TOOL_OUTPUT),
    true,
  );
  assert.equal(sessionModeAllowsTool("ask", PI_UPDATE_PLAN), false);
  assert.equal(sessionModeAllowsTool("ask", PI_RUN_TERMINAL_COMMAND), false);
  assert.equal(sessionModeAllowsTool("unknown", PI_WORKSPACE_READ_FILE), false);

  const gateway = new PiToolGateway(async () => undefined);
  const tools = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    async () => ({ taskId: "task-1", output: "should not run" }),
    () => "session-1",
    () => "plan",
  );
  const patch = tools.find((tool) => tool.name === PI_WORKSPACE_APPLY_PATCH);
  const subagent = tools.find((tool) => tool.name === PI_SPAWN_SUBAGENT);
  const background = tools.find((tool) => tool.name === PI_RUN_BACKGROUND_TASK);
  assert.ok(patch);
  assert.ok(subagent);
  assert.ok(background);
  await assert.rejects(
    patch.execute("call-plan-patch", {
      patch: "*** Begin Patch\n*** End Patch",
    }),
    /规划模式不允许使用工具 workspace_apply_patch/u,
  );
  await assert.rejects(
    subagent.execute("call-plan-subagent", { task: "delegate" }),
    /规划模式不允许使用工具 spawn_subagent/u,
  );
  await assert.rejects(
    background.execute("call-plan-background", { task: "delegate" }),
    /规划模式不允许使用工具 run_background_task/u,
  );
});

test("exposes Melody-compatible background task output, wait, and kill controls", async () => {
  const calls = [];
  const gateway = new PiToolGateway(async () => undefined);
  const controller = {
    wait: async (input) => {
      calls.push({ type: "wait", input });
      return [
        {
          taskId: "task-1",
          status: "completed",
          output: "done",
          childSessionId: "task-1:session",
        },
      ];
    },
    cancel: async (input) => {
      calls.push({ type: "cancel", input });
      return {
        taskId: "task-2",
        status: "cancelled",
        output: "stopped",
        childSessionId: "task-2:session",
      };
    },
  };
  const tools = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    undefined,
    () => "session-1",
    () => "default",
    controller,
  );
  const getOutput = tools.find(
    (tool) => tool.name === PI_GET_COMMAND_OR_SUBAGENT_OUTPUT,
  );
  const wait = tools.find(
    (tool) => tool.name === PI_WAIT_COMMANDS_OR_SUBAGENTS,
  );
  const kill = tools.find((tool) => tool.name === PI_KILL_COMMAND_OR_SUBAGENT);
  assert.ok(getOutput);
  assert.ok(wait);
  assert.ok(kill);

  const output = await getOutput.execute("call-output", {
    task_id: "task-1",
    timeout_ms: 0,
  });
  assert.deepEqual(JSON.parse(output.content[0].text), [
    {
      taskId: "task-1",
      status: "completed",
      output: "done",
      childSessionId: "task-1:session",
    },
  ]);

  const waited = await wait.execute("call-wait", {
    task_ids: ["task-1", "task-2"],
    mode: "wait_any",
    timeout_ms: 1234,
  });
  assert.deepEqual(JSON.parse(waited.content[0].text), [
    {
      taskId: "task-1",
      status: "completed",
      output: "done",
      childSessionId: "task-1:session",
    },
  ]);

  const killed = await kill.execute("call-kill", { task_id: "task-2" });
  assert.deepEqual(JSON.parse(killed.content[0].text), {
    taskId: "task-2",
    status: "cancelled",
    output: "stopped",
    childSessionId: "task-2:session",
  });
  assert.deepEqual(calls, [
    {
      type: "wait",
      input: {
        taskIds: ["task-1"],
        mode: "wait_any",
        timeoutMs: 0,
        parentSessionId: "session-1",
      },
    },
    {
      type: "wait",
      input: {
        taskIds: ["task-1", "task-2"],
        mode: "wait_any",
        timeoutMs: 1234,
        parentSessionId: "session-1",
      },
    },
    {
      type: "cancel",
      input: { taskId: "task-2", parentSessionId: "session-1" },
    },
  ]);
  assert.equal(
    sessionModeAllowsTool("default", PI_WAIT_COMMANDS_OR_SUBAGENTS),
    true,
  );
  assert.equal(
    sessionModeAllowsTool("plan", PI_WAIT_COMMANDS_OR_SUBAGENTS),
    false,
  );
  assert.equal(
    sessionModeAllowsTool("ask", PI_KILL_COMMAND_OR_SUBAGENT),
    false,
  );
});

test("exposes the original Melody task tool names as Pi compatibility aliases", async () => {
  const spawned = [];
  const gateway = new PiToolGateway(async () => undefined);
  const controller = {
    wait: async () => [
      {
        taskId: "legacy-task",
        status: "completed",
        output: "done",
      },
    ],
    cancel: async () => ({
      taskId: "legacy-task",
      status: "cancelled",
      output: "stopped",
    }),
  };
  const tools = gateway.createTools(
    () => "session-1",
    () => "run-1",
    () => "always-approve",
    () => "/tmp/project",
    async (input) => {
      spawned.push(input);
      return { taskId: "legacy-task", output: "legacy result" };
    },
    () => "session-1",
    () => "default",
    controller,
  );
  const task = tools.find((tool) => tool.name === PI_TASK);
  const output = tools.find((tool) => tool.name === "get_task_output");
  const wait = tools.find((tool) => tool.name === PI_WAIT_TASKS);
  const kill = tools.find((tool) => tool.name === PI_KILL_TASK);
  assert.ok(task);
  assert.ok(output);
  assert.ok(wait);
  assert.ok(kill);

  const result = await task.execute("call-task", {
    prompt: "legacy prompt",
    description: "legacy task",
    subagent_type: "explore",
    run_in_background: false,
    capability_mode: "read_only",
    model: "demo/model",
  });
  assert.match(result.content[0].text, /legacy result/u);
  assert.deepEqual(spawned[0], {
    task: "legacy prompt",
    subagentType: "explore",
    capabilityMode: "read_only",
    modelId: "demo/model",
    background: false,
    parentSessionId: "session-1",
  });

  await output.execute("call-output", { task_ids: ["legacy-task"] });
  await wait.execute("call-wait", {
    task_ids: ["legacy-task"],
    mode: "wait_any",
  });
  await kill.execute("call-kill", { task_id: "legacy-task" });
});

test("a monitor is an execute-class tool and never silently approved", () => {
  const gateway = new PiToolGateway(async () => undefined);
  const namesFor = (capabilityMode) =>
    gateway
      .createTools(
        () => "session-1",
        () => "run-1",
        () => "ask",
        () => "/tmp/project",
        undefined,
        undefined,
        () => "default",
        undefined,
        undefined,
        undefined,
        () => capabilityMode,
      )
      .map((tool) => tool.name);

  // Starting a process is an execute-class capability: a read-only child must
  // not get it, and the write+terminal ceiling must.
  assert.equal(namesFor("read-only").includes(PI_MONITOR), false);
  assert.equal(namesFor("read-write").includes(PI_MONITOR), false);
  assert.equal(namesFor("execute").includes(PI_MONITOR), true);
  assert.equal(namesFor("read-write-execute").includes(PI_MONITOR), true);
  assert.equal(namesFor("all").includes(PI_MONITOR), true);
});

test("plan and ask session modes withhold the monitor tool", () => {
  assert.equal(sessionModeAllowsTool("default", PI_MONITOR), true);
  assert.equal(sessionModeAllowsTool("plan", PI_MONITOR), false);
  assert.equal(sessionModeAllowsTool("ask", PI_MONITOR), false);
});

test("scheduler tools are write-class and blocked in plan/ask modes", () => {
  const gateway = new PiToolGateway(async () => undefined);
  const namesFor = (capabilityMode) =>
    gateway
      .createTools(
        () => "session-1",
        () => "run-1",
        () => "ask",
        () => "/tmp/project",
        undefined,
        undefined,
        () => "default",
        undefined,
        undefined,
        undefined,
        () => capabilityMode,
      )
      .map((tool) => tool.name);

  // Listing a timer is a read; creating or cancelling one changes future
  // autonomous work, so it follows the write ceiling.
  const readOnly = namesFor("read-only");
  assert.equal(readOnly.includes(PI_SCHEDULER_LIST), true);
  assert.equal(readOnly.includes(PI_SCHEDULER_CREATE), false);
  assert.equal(readOnly.includes(PI_SCHEDULER_DELETE), false);
  const readWrite = namesFor("read-write");
  assert.equal(readWrite.includes(PI_SCHEDULER_CREATE), true);
  assert.equal(readWrite.includes(PI_SCHEDULER_DELETE), true);

  for (const mode of ["plan", "ask"]) {
    assert.equal(sessionModeAllowsTool(mode, PI_SCHEDULER_CREATE), false);
    assert.equal(sessionModeAllowsTool(mode, PI_SCHEDULER_DELETE), false);
  }
  assert.equal(sessionModeAllowsTool("default", PI_SCHEDULER_CREATE), true);
});
