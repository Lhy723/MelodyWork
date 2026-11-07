import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Behavior tests for the session activation state machine.
 *
 * The slice takes a store access object (`{ get, set }`), so these tests build
 * one directly instead of importing the Zustand singleton. Bridge and client
 * modules are stubbed once at module scope with delegating wrappers; each test
 * replaces entries in `impl`.
 */
const agentClient = { sendAgentCommand: async () => {} };
const bridge = {
  isTauriRuntime: () => false,
  getPiAgentSessionBinding: async () => undefined,
  upsertAgentSessionBinding: async () => {},
  inspectPiSessionRecovery: async () => undefined,
  readPiAgentEventLog: async () => [],
};

mock.module("@/lib/agent-client.ts", {
  namedExports: {
    sendAgentCommand: (...args) => agentClient.sendAgentCommand(...args),
    sendAgentTurn: async () => {},
  },
});
mock.module("@/lib/melody-bridge.ts", {
  namedExports: Object.fromEntries(
    Object.keys(bridge).map((name) => [
      name,
      (...args) => bridge[name](...args),
    ]),
  ),
});
mock.module("@/stores/agent-store-pi.ts", {
  namedExports: {
    resetPiEventProjection: () => {},
    receiveAgentEvent: () => {},
  },
});

const { beginAgentSession } = await import("@/stores/agent-store-session.ts");

const baseState = () => ({
  activeSessionId: "",
  localSessionId: undefined,
  cwd: ".",
  status: { phase: "stopped" },
  runtimePhase: "idle",
  runtimeSessionId: undefined,
  eventCursor: undefined,
  timeline: [],
  backgroundTimelines: {},
  backgroundCursors: {},
  backgroundContextUsage: {},
  contextUsage: undefined,
  subagents: {},
  stderr: [],
  availableModels: [],
  unavailableModels: [],
  modelRefreshErrors: {},
  capabilityDiagnostics: [],
  monitorNotifications: [],
  scheduleRevision: 0,
  configRevision: 0,
  availableSessionModes: [],
  selectedModelId: undefined,
  selectedReasoningEffort: undefined,
  selectedSessionModeId: undefined,
  permissionMode: "ask",
  runningSessions: {},
  chatStatus: "ready",
  archivedReadOnly: false,
});

const makeStore = (initial = baseState()) => {
  let state = initial;
  const store = {
    get: () => state,
    set: (update) => {
      state = {
        ...state,
        ...(typeof update === "function" ? update(state) : update),
      };
    },
  };
  return store;
};

test("preview activation commits the session identity", async () => {
  const store = makeStore();

  await beginAgentSession(store, ".", "session-a", "acp-a");

  const state = store.get();
  assert.equal(state.activeSessionId, "session-a");
  assert.equal(state.localSessionId, "session-a");
  assert.equal(state.runtimePhase, "initializing");
  assert.equal(state.chatStatus, "submitted");
  assert.equal(state.archivedReadOnly, false);
});

test("a stale activation cannot overwrite a newer session", async () => {
  const store = makeStore();
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;
  agentClient.sendAgentCommand = async () => {
    call += 1;
    if (call === 1) await firstGate;
  };

  const first = beginAgentSession(store, ".", "session-a", "acp-a");
  const second = beginAgentSession(store, ".", "session-b", "acp-b");
  await second;

  assert.equal(store.get().activeSessionId, "session-b");

  // The first activation resumes and must not reclaim the store.
  releaseFirst();
  await first;

  const state = store.get();
  assert.equal(state.activeSessionId, "session-b");
  assert.equal(state.localSessionId, "session-b");
});

test("reactivating the same session keeps the newer generation", async () => {
  const store = makeStore();
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;
  agentClient.sendAgentCommand = async () => {
    call += 1;
    if (call === 1) await gate;
  };

  const first = beginAgentSession(store, ".", "session-a", "acp-a");
  const second = beginAgentSession(store, ".", "session-a", "acp-a");
  await second;

  releaseFirst();
  await first;

  const state = store.get();
  assert.equal(state.localSessionId, "session-a");
  assert.notEqual(state.runtimePhase, "error");
});

test("a failed activation reports through the normalized message", async () => {
  const store = makeStore();
  agentClient.sendAgentCommand = async () => {
    throw new Error("fetch failed");
  };

  await beginAgentSession(store, ".", "session-a", "acp-a");

  const state = store.get();
  assert.equal(state.runtimePhase, "error");
  assert.equal(state.chatStatus, "error");
  assert.equal(state.status.message, "网络请求失败，请检查网络连接后重试。");
});
