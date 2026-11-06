# Renderer Store Test Harness

## Goal

Make `src/stores/` testable under the existing `node --test` runner, then
cover the two highest-churn untested stores with behavior tests that can
actually fail.

## Background (verified 2026-07-11 on `6bf00f53`)

Coverage versus size:

| Directory | Lines | Test files |
|-----------|-------|-----------|
| `src/domain` | 9,939 | 33 |
| `src/stores` | 4,573 | **0** |
| `src/features` | 27,899 | 4 |
| `src/components` | 16,468 | **0** |
| `src/lib` | 3,052 | **0** |

Churn (80 commits, excluding the last 3):

| File | Lines | Appearances | Tests |
|------|-------|-------------|-------|
| `stores/workspace-store.ts` | 568 | 10 | 0 |
| `stores/agent-store-session.ts` | 645 | 4 | 0 |
| `stores/agent-store-runtime.ts` | — | — | 0 |

### Three blockers, each measured

1. **`@/` alias.** 207 files import `@/...`; `node --test` cannot resolve it.
   A `module.register` resolve hook works — verified: `workspace-store.ts`
   imported successfully under Node with a stubbed bridge (44 state fields).
2. **Bare `window` calls** that break a Node import chain:
   `stores/agent-store-runtime.ts:24,138`, `lib/melody-bridge-acp.ts:16`,
   `lib/melody-bridge-runtime.ts:118`. The same file already uses
   `typeof window === "undefined"` guards elsewhere (line 141), so the fix is
   consistent with local style.
3. **No module mocking by default.** `node:test`'s `mock.module` requires
   `--experimental-test-module-mocks`. Verified working together with the
   resolve hook and `--experimental-strip-types`.

## Requirements

**R1 — Ship the alias resolver.** Add a committed resolve hook that maps
`@/x` to `src/x` and appends `.ts` / `.tsx` / `index.ts`, plus a register
bootstrap. Wire both into the `test:unit` command. Keep it under `scripts/`
so it is a first-class repository file, not a hidden dotfile.

**R2 — Guard bare `window` usage.** Change the four call sites to a
`typeof window` guard or a local helper. No behavior change in a browser or
Tauri; the modules must merely import cleanly in Node.

**R3 — Enable module mocking.** Add `--experimental-test-module-mocks` to
`test:unit`. Document in the spec that a test stubs a bridge module via
`mock.module` before importing the store.

**R4 — Cover `workspace-store`.** Behavior tests for:

- `initialize()` loads projects and marks `initialized`
- `initialize()` failure surfaces `error` through `toUserMessage`
- project selection keeps only the latest request (the `RequestGate` path)
- `createSession` and `deleteSession` update `sessionsByProject`
- `loading` returns to `false` after each terminal path

**R5 — Cover `agent-store-session`.** Behavior tests for:

- an activation commits when the generation and session identity still match
- a stale activation does **not** overwrite a newer session's state
- the same-session idempotent re-open does not invalidate the live generation
- setup-timeout fires only for the generation that is still `creating`

These mirror the invariants recorded for the earlier `Slice 189/192` work,
which currently has no executable proof in this checkout.

**R6 — Tests must be able to fail.** For at least two guards, neutralize the
production condition and record the resulting assertion failure, then revert.

**R7 — No behavior change.** `pnpm check`, `pnpm lint`,
`pnpm check:architecture` still pass; existing 398 unit tests still pass.

**R8 — Do not introduce a DOM runner.** No jsdom, happy-dom, vitest, or
testing-library. Component and feature JSX coverage stays out of scope.

## Acceptance Criteria

- [ ] `pnpm test:unit` resolves `@/` imports and runs store tests.
- [ ] The four bare `window` call sites import cleanly under Node.
- [ ] `workspace-store` has ≥5 behavior tests, all passing.
- [ ] `agent-store-session` has ≥4 behavior tests, all passing.
- [ ] Mutation evidence recorded for ≥2 guards.
- [ ] Existing suites unchanged in count except for the new files.
- [ ] Full gate set green.

## Non-Goals

- Component/feature JSX tests.
- Refactoring `workspace-store.ts` or `agent-store-session.ts`.
- Covering `src/lib/` bridge modules.
- Changing the production store API.

## Constraints

- Branch `beta`; base `beta`.
- Tests use `node:test` + `node:assert/strict`, matching every existing test.
- No new runtime dependency.
- The resolver must not change how Vite or `tsc` resolve imports.
