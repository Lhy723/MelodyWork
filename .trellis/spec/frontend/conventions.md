# Frontend Conventions

## Layer Map And Import Boundaries

`src/domain/` is the only layer with an enforced import ban. It runs in the
renderer, the worker, and any host that imports it, so it must stay
framework-free.

| Layer | Intended role | Rule |
|-------|---------------|------|
| `src/domain/**` | Pure types, projections, parsers, policies | **Must not** import `@/components`, `@/features`, `@/stores`, `@/lib`, `react`, `react-dom`, or `@tauri-apps/*` |
| `src/lib/**` | Tauri bridge modules and renderer clients | May import `domain` and store *types*; owns `invoke(...)` except the two documented exceptions below |
| `src/stores/**` | Zustand stores and slice functions | May import `domain` and `lib`; no JSX |
| `src/hooks/**` | Reusable React hooks | May import `domain`, `lib`, `stores` |
| `src/features/**` | Product UI and feature-local helpers | May import anything |
| `src/components/**` | Shared presentational components | Import `@/lib/utils` and other components; no feature imports |

Enforcement: `scripts/check-architecture.mjs`

- `forbiddenDomainImports` — the `src/domain` ban above.
- `workerBoundaryViolations` — Pi SDK imports (`@earendil-works/pi-*`) only
  under `packages/agent-worker/src/pi/`.
- `collectRuntimeModuleCycles` — no runtime import cycles across `src/` and
  `packages/` (type-only imports are excluded).

Import specifiers use the `@/` alias for `src/` (`tsconfig.json`,
`vite.config.ts`); workspace files use explicit `.ts` extensions
(`import ... from "./protocol.ts"`).

Anti-pattern: importing `react` or `@tauri-apps/api` into `src/domain/` "just
for a type". Use a plain interface and let the caller adapt.

## State Management

Three Zustand stores: `useAgentStore` (`src/stores/agent-store.ts`),
`useAppSettingsStore`, `useWorkspaceStore`.

### Slice functions, not one giant store body

The agent store is composed from plain functions in `agent-store-<topic>.ts`.
A slice receives the store access object and the action's parameters:

```ts
// src/stores/agent-store.ts
export const useAgentStore = create<AgentStore>((set, get) => ({ ... }));

// src/stores/agent-store-submit.ts
export const submitAgentPrompt = async (
  store: AgentStoreAccess,
  ...args: Parameters<AgentStore["submitPrompt"]>
) => {
  const { get, set } = store;
  ...
};
```

`AgentStoreAccess` is `{ get: () => AgentStore; set: ... }`
(`src/stores/agent-store-types.ts`). State shape lives in
`agent-store-types.ts`; the store body wires slices to actions.

Adding agent state means: extend `AgentStore`, add/extend a slice file, and
wire the action in `agent-store.ts`. Do not put business logic in components.

### Components select narrowly

```ts
// src/features/chat/agent-workspace.tsx
const status = useAgentStore((state) => state.status);
const timeline = useAgentStore((state) => state.timeline);
```

Use one selector per field (or a stable selector) instead of subscribing to the
whole store, which re-renders on every event.

Use the updater form for derived state:

```ts
set((state) => ({ stderr: [...state.stderr.slice(-49), line] }));
```

## Async Work And Stale Results

Two existing tools; pick by scope.

1. **Component-level request lifecycle** — `src/hooks/use-async-operation.ts`.

   ```ts
   const { state, run, reset } = useAsyncOperation();
   await run(() => loadPlugin(id), (plugin) => setPlugin(plugin));
   ```

   It owns `idle | pending | success | error`, applies results only for the
   latest token, and converts failures with `toUserMessage`.

2. **Store/panel-level sequencing** — `src/domain/request-gate.ts`.

   ```ts
   const token = gate.begin();
   const value = await load();
   if (!gate.isCurrent(token)) return;
   ```

   Used by `agent-store-session.ts`, `workspace-store.ts`, and the research
   panels.

For multi-step store flows, snapshot state before the await and re-check it
before committing. `agent-store-submit.ts` compares `localSessionId`,
`runtimeSessionId`, and `chatStatus` after reading Explorer references and
throws a "state changed, resubmit" error otherwise. Copy that shape rather
than applying a result against whatever state exists at resolution time.

Do not model loading with a bare boolean: `Async Operation` is a named concept
in `CONTEXT.md` (`pending/success/error` plus latest-request rule).

## Error Normalization

All user-visible failures go through `src/domain/app-error.ts`:

- `classifyError(reason)` maps transport/HTTP/Rust/IPC shapes to
  `validation | not-found | permission | network | timeout | conflict |
  storage | protocol | unknown`.
- `toUserMessage(reason, fallback)` returns the Chinese user copy, bounded to
  500 characters, and preserves actionable validation text.
- Call sites: ~100 across stores, features, and hooks
  (`grep -rn "toUserMessage" src`).

Rules:

- Catch at the boundary that owns the UI state, then `set` an error field or
  feed `useAsyncOperation`.
- Never render a raw `invoke` rejection, stack, or JSON body.
- When adding a new backend failure shape, extend `classifyError` with a
  pattern that matches the real message; do not special-case one string at a
  call site.

## Tauri Access

New IPC belongs in `src/lib/melody-bridge-<domain>.ts`, typed at the invoke:

```ts
// src/lib/melody-bridge-runtime.ts
return invoke<AgentStatus>("pi_worker_status");
```

Bridge modules also own the browser-preview branch:

```ts
if (!isTauriRuntime()) {
  return { ...fixture };
}
```

`src/lib/melody-bridge.ts` re-exports four domain modules — `runtime`, `git`,
`workspace`, `config` — and `agent-client.ts` owns the agent command path
(`sendAgentCommand` validates, then routes to Pi or the preview fixture).
Bridge modules not re-exported there (`melody-bridge-schedules.ts`,
`melody-bridge-monitors.ts`, `melody-bridge-pi-fork.ts`) are imported directly
by the store or feature that needs them.

Two existing exceptions import `@tauri-apps/*` directly:
`src/features/settings/about-page.tsx` (`getVersion`, `relaunch`) and
`src/features/workspace/browser-panel.tsx` (`listen`). Do not add a third; put
the call in `src/lib/`.

## Verification

```bash
pnpm exec tsc --noEmit
pnpm check:architecture
pnpm lint
pnpm format:check
```

The architecture script is also unit-testable through its exports
(`domainBoundaryViolations`, `workerBoundaryViolations`,
`findRuntimeModuleCycles`) but no runner is configured.

## Store Tests

`src/stores` is covered by `node --test` like `src/domain`. Three pieces make
that work:

- `scripts/test-alias-hooks.mjs` resolves `@/…` and extensionless relative
  imports; `scripts/test-register.mjs` registers it.
- `test:unit` runs with `--experimental-test-module-mocks` and
  `--import ./scripts/test-register.mjs`.
- A test stubs a bridge module once at module scope:

  ```js
  const impl = { listProjects: async () => [] };
  mock.module("@/lib/melody-bridge.ts", {
    namedExports: Object.fromEntries(
      Object.keys(impl).map((name) => [name, (...args) => impl[name](...args)]),
    ),
  });
  const { useWorkspaceStore } = await import("@/stores/workspace-store.ts");
  ```

  `mock.module` copies bindings at registration and may be called only once
  per specifier, so the wrappers delegate to a mutable `impl` that each test
  replaces. Mutating the stubbed object directly does nothing.

`agent-store-session` takes an `AgentStoreAccess` object, so its tests build
`{ get, set }` by hand rather than importing the Zustand singleton. Use
`useStore.setState(partial)` (merge, not replace) to reset a singleton —
replacing drops the action functions.

Modules on these import chains must not touch `window` unguarded; use
`typeof window === "undefined"` (see `armSetupTimeout`) or `globalThis.setTimeout`.
A bare `window.setTimeout` in a module that self-schedules will keep the Node
test process alive forever.
