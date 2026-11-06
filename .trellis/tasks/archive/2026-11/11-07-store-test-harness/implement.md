# Implement — Renderer Store Test Harness

## Preconditions

- HEAD is `6bf00f53`; worktree clean.
- Read `prd.md` and `design.md`. The alias hook, module mock, and store import
  path were each verified working; do not re-investigate.
- Baseline: `pnpm test:unit` reports 398 tests.

## Step 1 — Alias resolver

Create:

- `scripts/test-alias-hooks.mjs` (resolve hook, see `design.md` §1)
- `scripts/test-register.mjs` (`register("./test-alias-hooks.mjs", ...)`)

Verify standalone:

```bash
node --experimental-strip-types --import ./scripts/test-register.mjs \
  --input-type=module -e "import('@/domain/request-gate.ts').then(m => console.log(typeof m.RequestGate))"
```

Expect `function`.

## Step 2 — Window guards

| File | Change |
|------|--------|
| `stores/agent-store-runtime.ts:24` | `armSetupTimeout`: `if (typeof window === "undefined") return;` then `globalThis.setTimeout` |
| `stores/agent-store-runtime.ts:138` | sweep: already guarded; switch to `globalThis.setTimeout` inside |
| `lib/melody-bridge-acp.ts:16` | `emitPreviewAcp`: `globalThis.setTimeout` |
| `lib/melody-bridge-runtime.ts:118` | keep `window.open`, but read it after the existing `isTauriRuntime()` branch (already the case); no change needed if it cannot run in Node |

Verify each module imports cleanly:

```bash
node --experimental-strip-types --import ./scripts/test-register.mjs \
  --input-type=module -e "import('@/stores/agent-store-runtime.ts').then(() => console.log('ok'))"
```

## Step 3 — Enable module mocking

Update `test:unit`:

```json
"test:unit": "node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/test-register.mjs --test <existing globs> src/stores/*.test.mjs"
```

Keep every existing glob. Verify the baseline still reports 398 (plus new
files once added).

## Step 4 — `workspace-store` tests

Create `src/stores/workspace-store.test.mjs`.

Structure:

```js
import test, { mock } from "node:test";
import assert from "node:assert/strict";

const project = (id, path = `/repo/${id}`) => ({ id, name: id, path, ... });

test("initialize loads projects", async () => {
  mock.module("@/lib/melody-bridge.ts", {
    namedExports: {
      isTauriRuntime: () => false,
      listProjects: async () => [project("a"), project("b")],
      listStoredSessions: async () => [],
      ...,
    },
  });
  const { useWorkspaceStore } = await import("@/stores/workspace-store.ts");
  useWorkspaceStore.setState({ /* initial */ }, true);
  await useWorkspaceStore.getState().initialize();
  ...
});
```

Rules:

- Stub `@/lib/melody-bridge.ts` (the barrel the store imports).
- Reset the singleton with `setState(initial, true)` per test.
- Assert only public store state.
- The latest-selection test must control resolution order with deferred
  promises, not timers.

Cover the five cases in `design.md` §4.

## Step 5 — `agent-store-session` tests

Create `src/stores/agent-store-session.test.mjs`.

Build the store object directly:

```js
const makeStore = (initial) => {
  let state = initial;
  return {
    get: () => state,
    set: (update) => {
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
    },
  };
};
```

Stub `@/lib/agent-client.ts`, `@/lib/melody-bridge.ts`, and
`@/stores/agent-store-pi.ts` as needed so the activation path runs without
Tauri. Cover the four cases in `design.md` §4.

For the timeout case, do not sleep 20 seconds: capture the scheduled callback
by stubbing `globalThis.setTimeout`, or call `armSetupTimeout` directly with a
fake `getState`/`setState` and assert the generation guard.

## Step 6 — Mutation checks (R6)

At minimum:

| Guard | Neutralization | Expected failure |
|-------|----------------|------------------|
| `RequestGate` latest-selection | accept any token | `latest project selection wins` |
| activation generation guard | commit unconditionally | `stale activation does not overwrite` |

Record the failing assertion and revert each change.

## Step 7 — Full gates

```bash
pnpm test:unit
pnpm check
pnpm lint
pnpm check:architecture
pnpm format:check
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## Step 8 — Spec update

Add to `.trellis/spec/frontend/conventions.md`:

- How a store test stubs a bridge module (`mock.module` + import order).
- The alias resolver files and the flags `test:unit` now carries.
- The rule that a new store slice ships with at least one behavior test.

## Rollback

- Remove the two `scripts/test-*.mjs` files and the two flags.
- Revert the four window call sites.
- Delete the two test files.
- No production behavior to unwind.

## Out Of Scope

- jsdom or any DOM runner.
- Component/feature JSX tests.
- Refactoring the two stores.
- `src/lib/` coverage.

## Result (2026-11-07)

Implemented; task remains `in_progress`; no commit.

### Files

| File | Change |
|------|--------|
| `scripts/test-alias-hooks.mjs` | new: resolves `@/` and extensionless relative imports |
| `scripts/test-register.mjs` | new: `register` bootstrap |
| `package.json` | `test:unit` gains `--experimental-test-module-mocks`, `--import`, and `src/stores/*.test.mjs` |
| `src/stores/agent-store-runtime.ts` | `armSetupTimeout` guarded by `typeof window`; sweep guard restored to `window` |
| `src/lib/melody-bridge-acp.ts` | `emitPreviewAcp` uses `globalThis.setTimeout` |
| `src/stores/workspace-store.test.mjs` | new: 5 behavior tests |
| `src/stores/agent-store-session.test.mjs` | new: 4 behavior tests |
| `.trellis/spec/frontend/conventions.md` | new "Store Tests" section |

### Discovery: a real defect the harness exposed

My first attempt changed `scheduleTransientStateSweep` to
`globalThis.setTimeout`, which made the module self-schedule on import and
kept the Node process alive indefinitely. The original `typeof window` guard
was correct; restoring it fixed the hang. This is exactly the class of defect
that zero store coverage hides.

### Module-mock constraints found by experiment

- `mock.module` may be called once per specifier; a second call throws
  `ERR_INVALID_STATE`.
- It copies exported bindings at registration, so mutating the stub object
  afterwards has no effect. Delegating wrappers over a mutable `impl` work.
- `useStore.setState(x, true)` replaces the whole state and drops actions;
  store tests must merge.

### Test results

| Suite | Before | After |
|-------|--------|-------|
| `pnpm test:unit` | 398 | **407** |
| `pnpm test:agent-worker` | 140 | 140 |
| `pnpm test:projection` | 24 | 24 |
| `cargo test --lib` | 26 | 26 |

### Mutation evidence (R6)

| Guard | Neutralization | Observed |
|-------|----------------|----------|
| `selectProject` latest-selection (two guards) | removed both `projectSelectionGate.isCurrent` checks | `only the latest project selection commits` fails, 406/407 |
| activation generation | `isCurrent = () => true` | 406/407 |

Removing only one of the two selection guards did **not** fail: they are
defence in depth. Both must be removed to observe the regression.

### Gates

`pnpm check`, `pnpm lint`, `pnpm check:architecture`, `pnpm format:check`,
`cargo test --lib` — all pass.
