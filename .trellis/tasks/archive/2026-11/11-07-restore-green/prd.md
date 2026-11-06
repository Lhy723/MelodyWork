# Restore Green: Type Error and API Drift

## Goal

Bring the repository from "210 changes committed but 48 tests red" to a
fully green baseline: `pnpm check`, `pnpm test:unit`, `pnpm test:agent-worker`,
`pnpm test:projection`, and `cargo test --lib` all pass.

No product behavior changes. Every fix either restores a removed export the
test legitimately used, or updates a test to a rename that the migration
already made in production.

## Background (verified 2026-11-07 on `752995b6`)

Baseline commit `752995b6` captured the worktree. Current failures:

| Suite | Tests | Pass | Fail |
|-------|-------|------|------|
| `pnpm test:unit` | 321 | 273 | 48 |
| `pnpm test:agent-worker` | 68 | 65 | 3 |
| `pnpm test:projection` | 24 | 24 | 0 |
| `cargo test --lib` | 19 | 19 | 0 |
| `pnpm check` | — | — | TS2322 in `melody-bridge-workspace.ts:514` |

Eight drift files, all in `.trellis/tasks/11-07-baseline-recovery/triage.md`.

## Root causes (already located, no investigation needed)

| # | File | Cause | Fix direction |
|---|------|-------|---------------|
| 1 | `src/lib/melody-bridge-workspace.ts:514` | `TextEncoder().encode().buffer` is `ArrayBufferLike`, declared `Promise<ArrayBuffer>` | Assert the concrete type; no behavior change |
| 2 | `packages/agent-worker/src/pi/goal-extension.test.mjs` | `GOAL_STATE_ENTRY` moved to `goal-state.ts`; `goal-extension.ts` no longer re-exports it | Re-export from `goal-extension.ts` (tests and `compaction-extension.test.mjs` both import it there) |
| 3 | `packages/agent-worker/src/pi/compaction-extension.test.mjs` | same symbol, same import path | Fixed by #2 |
| 4 | `packages/agent-worker/src/pi/session-adapter.test.mjs` | `applyModelPolicyOverrides` lives in `model-policy.ts`; `session-adapter.ts` no longer re-exports it | Re-export from `session-adapter.ts` |
| 5 | `src/domain/agent/capability-report.test.mjs` (19 cases) | `inspectPiCapabilityReport` now requires `mcpServers`; the test calls it 52 times without that field | Test-side: add `mcpServers: []` at the call sites, or give the parameter a default |
| 6 | `src/domain/agent/event-store-adapter.test.mjs` | asserts `patch.acpPhase`; production field is `runtimePhase` | Test-side rename |
| 7 | `src/domain/agent/projection-store-patch.test.mjs` | asserts `patch.acpCursor` / `patch.acpPhase`; production fields are `eventCursor` / `runtimePhase` | Test-side rename |
| 8 | `src/domain/agent/explorer-branch.test.mjs` | `appendExplorerConclusionToDraft` and `MAX_EXPLORER_BRING_BACK_CODEPOINTS` were deleted in the migration; the UI now inserts only a session reference | Restore the two exports from `7e89d128` (still used by the Explorer bring-back path) **or** delete the 3 obsolete tests. Decide from evidence, see R4 |
| 9 | `src-tauri/src/workspace_runtime_tests.rs` | test calls `read_workspace_binary_bytes`, `collect_tree`, `terminal_command`, `wait_for_terminal_exit`; all moved into `workspace_files` / `workspace_terminal` submodules | Re-export them from `workspace_runtime` as `pub(crate)`, or import them in the test |

Note on #5: the only production caller (`src/lib/pi-compatibility.ts:113`) does
pass `mcpServers`, so the required parameter is intentional. Prefer the
test-side fix; do not weaken the production signature.

Note on #8: `src/features/chat/pi-session-explorer.ts:252` calls
`appendExplorerSessionReferenceToDraft`, not the conclusion appender. The
conclusion path is gone from production. That makes the three conclusion tests
either obsolete or a genuine regression — see R4.

## Requirements

**R1 — Fix the type error.** `pnpm check` must pass. One assertion or a
correctly-typed intermediate; no `any`, no signature widening to
`ArrayBufferLike`.

**R2 — Restore legitimate re-exports.** For #2–#4, re-export from the module the
test imports, matching the existing barrel style in `session-adapter.ts`
(`export { ... } from "./model-policy.ts";`). Do not move the implementation
back.

**R3 — Update renamed-field tests.** For #6–#7, change only the asserted field
names. If `acpCursor` in `pi-session-import.test.mjs` and
`session-migration.test.mjs` is a *persistence* column (not a store patch
field), leave it — verify before editing.

**R4 — Decide #8 from evidence, not convenience.** Before deleting the three
Explorer conclusion tests, prove the feature is intentionally gone:

- `git log -S'appendExplorerConclusionToDraft'` shows it existed at `7e89d128`
  and was removed in the migration commit.
- No production caller remains (verified: only `pi-session-explorer.ts:252`
  uses the reference appender).
- `agent-workspace.tsx:196` still wires `bringBack` and
  `agent-timeline.tsx` still renders the bring-back affordance.

If the UI affordance still exists but no longer appends the conclusion, that is
a **product regression**, not test drift. In that case:
restore the two exports and their tests, and record the regression in the task
notes. Only delete the tests if the affordance was also removed. Do not guess.

**R5 — Wire the Rust test.** Make `workspace_runtime_tests.rs` compile by
re-exporting the four helpers at the `workspace_runtime` module boundary
(`pub(crate) use workspace_files::{...};` / `workspace_terminal::{...}`), then
add `#[path = "workspace_runtime_tests.rs"] mod tests;`. If a helper is
intentionally private to its submodule, import it directly in the test instead
of widening visibility.

**R6 — One file, one verification.** Fix and verify each file individually
(`node --experimental-strip-types --test <file>` or `cargo test --lib <name>`)
before moving on. Do not batch-edit.

**R7 — No collateral edits.** Allowed files: the eight drift files, the
`melody-bridge-workspace.ts` line, the re-export blocks, and
`workspace_runtime.rs`. Nothing else.

**R8 — Update the triage.** After each fix, update
`.trellis/tasks/11-07-baseline-recovery/triage.md` so the row moves to `PASS`.

## Acceptance Criteria

- [ ] `pnpm check` passes.
- [ ] `pnpm test:unit` reports 0 failures.
- [ ] `pnpm test:agent-worker` reports 0 failures.
- [ ] `pnpm test:projection` reports 0 failures.
- [ ] `cargo test --lib` passes with `workspace_runtime_tests.rs` wired and
      running.
- [ ] `pnpm lint`, `pnpm check:architecture`, `cargo fmt --check` pass.
- [ ] The #8 decision is recorded with the evidence that justified it.
- [ ] `triage.md` shows every restored file as `PASS` or documented `OBSOLETE`.
- [ ] No production behavior changed except the #8 restoration, which must be
      justified by R4.

## Non-Goals

- Concept consolidation (tool names, model policy, event mapping).
- Directory reorganization or file splitting.
- Adding new tests beyond the restored set.
- Changing `inspectPiCapabilityReport` to make `mcpServers` optional.
- Committing or pushing.

## Constraints

- Branch `beta`; baseline commit `752995b6`.
- Do not revert the baseline commit.
- `refs/backup/wip-2026-11-07` remains the pre-commit fallback.
