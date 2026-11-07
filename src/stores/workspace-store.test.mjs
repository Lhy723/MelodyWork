import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Behavior tests for the workspace store.
 *
 * `mock.module` copies the exported bindings at registration time and may only
 * be called once per specifier, so the bridge barrel is stubbed a single time
 * with delegating wrappers. Each test replaces entries in `impl`; the wrappers
 * forward to the current implementation.
 */
const project = (id, overrides = {}) => ({
  id,
  name: id,
  path: `/repo/${id}`,
  lastOpenedAt: 0,
  archived: false,
  isIndependent: false,
  ...overrides,
});

const session = (id, projectId) => ({
  id,
  projectId,
  title: id,
  cwd: `/repo/${projectId}`,
  createdAt: 0,
  updatedAt: 0,
});

const defaults = () => ({
  isTauriRuntime: () => false,
  listProjects: async () => [],
  listStoredSessions: async () => [],
  createStoredSession: async (projectId) =>
    session(`new-${projectId}`, projectId),
  deleteStoredSession: async () => {},
  archiveProject: async (id) => project(id, { archived: true }),
  deleteProject: async () => ({ ok: true }),
  pickWorkspaceDirectory: async () => undefined,
  restoreProject: async (id) => project(id),
  upsertProject: async (path) => project("picked", { path }),
});

let impl = defaults();

const bridgeNames = Object.keys(defaults());
const delegated = Object.fromEntries(
  bridgeNames.map((name) => [name, (...args) => impl[name](...args)]),
);

mock.module("@/lib/melody-bridge.ts", { namedExports: delegated });

const { useWorkspaceStore } = await import("@/stores/workspace-store.ts");

const reset = (overrides = {}) => {
  impl = defaults();
  useWorkspaceStore.setState({
    projects: [],
    sessions: [],
    sessionsByProject: {},
    loading: false,
    initialized: false,
    needsWorkspace: false,
    activeProject: undefined,
    activeSession: undefined,
    error: undefined,
    ...overrides,
  });
};

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("initialize loads projects and clears loading", async () => {
  reset();
  impl.listProjects = async () => [project("alpha"), project("beta")];
  impl.listStoredSessions = async (id) => [session(`s-${id}`, id)];

  await useWorkspaceStore.getState().initialize();

  const state = useWorkspaceStore.getState();
  assert.deepEqual(
    state.projects.map((item) => item.id),
    ["alpha", "beta"],
  );
  assert.equal(state.initialized, true);
  assert.equal(state.loading, false);
  assert.equal(state.error, undefined);
  assert.deepEqual(Object.keys(state.sessionsByProject).sort(), [
    "alpha",
    "beta",
  ]);
});

test("initialize failure surfaces the normalized message", async () => {
  reset();
  impl.listProjects = async () => {
    throw new Error("network down");
  };

  await useWorkspaceStore.getState().initialize();

  const state = useWorkspaceStore.getState();
  assert.equal(state.loading, false);
  assert.equal(state.error, "网络请求失败，请检查网络连接后重试。");
});

test("only the latest project selection commits", async () => {
  reset();
  const first = deferred();
  const second = deferred();
  let call = 0;
  impl.listStoredSessions = async () => {
    call += 1;
    return call === 1 ? first.promise : second.promise;
  };

  const firstSelection = useWorkspaceStore
    .getState()
    .selectProject(project("alpha"));
  const secondSelection = useWorkspaceStore
    .getState()
    .selectProject(project("beta"));

  second.resolve([session("s-beta", "beta")]);
  await secondSelection;

  first.resolve([session("s-alpha", "alpha")]);
  await firstSelection;

  const state = useWorkspaceStore.getState();
  assert.equal(state.activeProject.id, "beta");
  assert.equal(state.activeSession.id, "s-beta");
  assert.deepEqual(Object.keys(state.sessionsByProject), ["beta"]);
});

test("createSession prepends the session for its project", async () => {
  reset({
    projects: [project("alpha")],
    sessionsByProject: { alpha: [session("old", "alpha")] },
    activeProject: project("alpha"),
  });

  await useWorkspaceStore.getState().createSession();

  const state = useWorkspaceStore.getState();
  assert.deepEqual(
    state.sessionsByProject.alpha.map((item) => item.id),
    ["new-alpha", "old"],
  );
  assert.equal(state.activeSession.id, "new-alpha");
  assert.equal(state.loading, false);
});

test("deleteSession removes the target and replaces the active one", async () => {
  const target = session("target", "alpha");
  reset({
    projects: [project("alpha")],
    sessions: [target],
    sessionsByProject: { alpha: [target] },
    activeProject: project("alpha"),
    activeSession: target,
  });

  await useWorkspaceStore.getState().deleteSession(target);

  const state = useWorkspaceStore.getState();
  // Deleting the active session never leaves the project sessionless: the
  // store creates a replacement so the composer always has a target.
  const remaining = state.sessionsByProject.alpha;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "new-alpha");
  assert.notEqual(remaining[0].id, target.id);
  assert.equal(state.activeSession.id, "new-alpha");
  assert.equal(state.loading, false);
});
