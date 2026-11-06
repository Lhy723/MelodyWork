# Baseline Recovery: Snapshot and Test Restore

## Goal

Turn the current 266-change worktree into something that can be judged and
changed safely: freeze it as a recoverable ref, restore the test suite that was
deleted during the Pi migration, and produce an honest pass/fail map.

No product behavior changes. No restructuring. No commit on `beta`.

## Background (verified 2026-11-07)

| Fact | Evidence |
|------|----------|
| Worktree has 266 changes | 109 untracked, 101 modified, 56 deleted |
| All 56 deletions are tests | 53 `*.test.mjs` + 3 `src-tauri/src/*_tests.rs` |
| HEAD still has tests and scripts | `git show HEAD:package.json` has `test:unit`, `test:projection`, `test:agent-worker`, `test:pi-worker-smoke` |
| Current tree has no test scripts | `grep '"test' package.json` returns nothing |
| Worker package lost its `test` script | HEAD `packages/agent-worker/package.json` has it; current does not |
| 2 Rust test files lost their wiring | `git_runtime.rs` and `workspace_runtime.rs` dropped `#[path = "..._tests.rs"] mod tests;` |
| 1 Rust test file is a pre-existing orphan | `acp_policy_tests.rs` has no `acp_policy.rs` and no `#[path]` reference in HEAD either |
| Architecture gate still passes | `pnpm check:architecture` |

## Requirements

**R1 — Recoverable snapshot.** Capture the entire worktree (tracked changes,
untracked new files, deletions; ignored files excluded) in a named git ref
without changing `HEAD`, the index, or any working file.

**R2 — Restore `.mjs` tests.** Restore the 53 deleted `*.test.mjs` files from
`HEAD`.

**R3 — Restore Rust tests.** Restore `git_runtime_tests.rs` and
`workspace_runtime_tests.rs`, and re-add their `#[path = "..._tests.rs"]
mod tests;` wiring **where the restored test still compiles**. If it does not,
keep the file restored but unwired and record the missing symbols as
`API_DRIFT`; do not rewrite the test in this task. Do **not** restore
`acp_policy_tests.rs`: it is an orphan in `HEAD` (no owner module, no `#[path]`
reference) and restoring it would add dead code.

**R4 — Restore test commands.** Re-add the four root scripts
(`test:unit`, `test:projection`, `test:agent-worker`, `test:pi-worker-smoke`)
and the worker package `test` script, using the exact `HEAD` definitions.

**R5 — Run and capture.** Run every restored suite and save the raw output in
the task directory. A suite that cannot start is a result, not a blocker.

**R6 — Triage, not repair.** Classify every restored file into exactly one
category:

- `PASS` — runs and passes as-is
- `API_DRIFT` — module exists, imported symbol/signature changed
- `OBSOLETE` — the module it tests no longer exists in the worktree
- `NEEDS_REWRITE` — module exists, behavior intentionally changed
- `RUNNER` — fails because the runner/flags are incompatible

Do not fix test bodies or product code in this task.

**R7 — No collateral edits.** The only allowed deltas beyond restored files
are the two Rust `#[path]` lines and the two `scripts` blocks.

**R8 — Approval gates.** Ask before creating the snapshot ref and before any
`git commit`/branch operation. This task never commits on `beta`.

## Acceptance Criteria

- [ ] A ref under `refs/backup/` exists and contains a sampled untracked file.
- [ ] `git diff --stat <ref>` shows no tracked-file differences against the
      current worktree.
- [ ] The 53 `.mjs` tests and 2 Rust test files are restored; `git status`
      no longer reports them as deleted.
- [ ] Both `scripts` blocks match the `HEAD` definitions for the test keys.
- [ ] `pnpm test:unit`, `pnpm test:projection`, `pnpm test:agent-worker`, and
      `cargo test --manifest-path src-tauri/Cargo.toml --lib` were all invoked.
- [ ] `triage.md` covers all 55 restored files (53 `.mjs` + 2 `.rs`).
- [ ] `git diff` shows no product-source edits outside the allowed set.
- [ ] The routing task `11-06-host-tool-routing-tests` remains `in_progress`
      (it must be committed before archival).

## Non-Goals

- Fixing failing tests.
- Rewriting or modernizing the restored tests.
- Resolving the `melody-bridge-workspace.ts:514` TypeScript error.
- Any directory reorganization or new abstraction.
- Committing, pushing, or archiving tasks.

## Constraints

- Branch `beta`; base `beta`.
- Snapshot must be non-destructive: no `git stash push`, no `git commit`, no
  `git checkout` of the whole tree.
- Ignored files (`node_modules`, `.pnpm-store`, `dist`, `target`) stay out of
  the snapshot.
- Keep the restored tests byte-identical to `HEAD`.
