# Design — Renderer Store Test Harness

## 1. Alias Resolution

`node --test` resolves ESM specifiers literally; `@/domain/app-error` is not a
real path. Two committed files solve it:

`scripts/test-alias-hooks.mjs` — a `resolve` hook:

```js
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const projectRoot = resolvePath(import.meta.dirname, "..");
const withExtension = (target) => {
  if (/\.[cm]?[jt]sx?$/u.test(target)) return target;
  for (const candidate of [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return target;
};

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const target = resolvePath(projectRoot, "src", specifier.slice(2));
    return next(pathToFileURL(withExtension(target)).href, context);
  }
  return next(specifier, context);
}
```

`scripts/test-register.mjs`:

```js
import { register } from "node:module";
register("./test-alias-hooks.mjs", import.meta.url);
```

`test:unit` gains two flags:

```json
"test:unit": "node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/test-register.mjs --test ..."
```

Verified working: `--experimental-test-module-mocks` + `--import` + a resolve
hook compose correctly on Node 24.14.1.

Rejected alternatives:

- Adding `imports` to `package.json` — `#alias` syntax, not `@/`; would
  require rewriting 207 files.
- A `node_modules/@` symlink — pollutes install state and breaks `pnpm`.
- Copying stores into `domain` — moves the code to satisfy the test runner.

## 2. Window Guards

Four call sites, all inside functions that only run in a browser or Tauri:

| File | Line | Current |
|------|------|---------|
| `stores/agent-store-runtime.ts` | 24 | `window.setTimeout(...)` in `armSetupTimeout` |
| `stores/agent-store-runtime.ts` | 138 | `window.setTimeout(...)` in the sweep |
| `lib/melody-bridge-acp.ts` | 16 | `window.setTimeout(...)` in the preview emitter |
| `lib/melody-bridge-runtime.ts` | 118 | `window.open(...)` in the link opener |

`agent-store-runtime.ts:141` already demonstrates the local convention:

```ts
if (typeof window === "undefined") return;
```

Apply the same guard shape:

- `armSetupTimeout`: return early when `window` is absent. In Node the timeout
  is meaningless; the store still commits the same state without it.
- The sweep: already guarded; verify the timer call is inside the guard.
- `emitPreviewAcp`: use `globalThis.setTimeout` (available in Node) — the
  preview emitter is browser-only, but `setTimeout` needs no DOM.
- `window.open`: keep `window.open` but reach it via a guarded lookup, since
  the function already throws a user-facing error when the browser blocks it.

`globalThis.setTimeout` is the smallest change for the timer sites and keeps
browser semantics identical.

## 3. Module Mocking

`mock.module(specifier, { namedExports })` with
`--experimental-test-module-mocks`. Pattern:

```js
test("initialize loads projects", async () => {
  mock.module("@/lib/melody-bridge.ts", {
    namedExports: { listProjects: async () => [project], ... },
  });
  const { useWorkspaceStore } = await import("@/stores/workspace-store.ts");
  ...
});
```

Constraints:

- Stub before import; ESM bindings are resolved once per test file.
- Stub the module the store actually imports. `workspace-store.ts` imports
  from `@/lib/melody-bridge` (the barrel), not the individual bridge files.
- Zustand stores are module singletons. A test that needs a clean store
  resets it with `useWorkspaceStore.setState(initial, true)` rather than
  re-importing.

## 4. Test Scope

### `workspace-store` (R4)

Pure state machine over injected bridge calls. Tests assert observable store
state, never private helpers.

| Test | Setup | Assertion |
|------|-------|-----------|
| `initialize loads projects` | bridge returns 2 projects | `projects` populated, `initialized === true`, `loading === false` |
| `initialize failure surfaces a message` | `listProjects` throws `Error("boom")` | `error` is the normalized Chinese copy, `loading === false` |
| `latest project selection wins` | two `selectProject` calls, first resolves last | `activeProject` is the second; first result discarded |
| `createSession appends to its project` | bridge returns a session | `sessionsByProject[projectId]` contains it |
| `deleteSession removes it` | bridge succeeds | session gone from `sessionsByProject` and `sessions` |

The `RequestGate` test is the important one: it is the exact mechanism
recorded as fixed in earlier slices but never executed here.

### `agent-store-session` (R5)

Drives `beginAgentSession(store, ...)` with a hand-built store object
(`{ get, set }`), matching the slice-function signature.

| Test | Setup | Assertion |
|------|-------|-----------|
| `commits for the live generation` | single activation, non-Tauri | `runtimePhase` reaches the expected phase |
| `stale activation does not overwrite` | activate A, then B, then let A finish | B's session fields remain |
| `same-session reopen stays idempotent` | activate A twice | the second call does not invalidate the first generation |
| `setup timeout respects generation` | arm a timeout for A, activate A again | the old timer does not set `error` on the new generation |

Timeout tests must not depend on wall-clock `20_000`; drive `armSetupTimeout`
directly with a fake `getState`/`setState` pair and a short timer, or assert
the guard by invoking the captured callback.

## 5. Risks

| Risk | Mitigation |
|------|-----------|
| `mock.module` is experimental and may warn | Accept the warning; it is already required for this approach and documented in the spec |
| Zustand singleton leaks between tests | Reset with `setState(initial, true)` in each test |
| Store tests become implementation mirrors | Assert only public store state; no private helper access |
| The resolver changes Vite/tsc behavior | It only registers inside `node --test`; Vite keeps its own alias |
| Timeout tests get flaky | No real sleeping; invoke captured callbacks |

## 6. Verification

```bash
pnpm test:unit
pnpm check
pnpm lint
pnpm check:architecture
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Plus the mutation probes from R6.
