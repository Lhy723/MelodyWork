# Test Suite Configuration and CI Gate

## Goal

Fix the test-suite wiring so every existing test runs exactly once, fast
feedback stays fast, and CI actually executes the suites.

No test content changes.

## Background (measured 2026-07-11 on the harness worktree)

Durations:

| Command | Wall time | Tests |
|---------|-----------|-------|
| `pnpm test:unit` | 5.5s | 407 |
| `pnpm test:agent-worker` | 2.9s | 140 |
| `pnpm test:projection` | 0.2s | 24 |
| `pnpm check` | 9.0s | — |
| `cargo test --lib` | 2.0s | 26 |

Three process-spawning tests dominate the unit suite:

| Test | Time |
|------|------|
| `runtime.shutdown stops stdin before later commands are admitted` | 2.4s |
| `Pi worker health handshake works with source and packaged entrypoints` | 2.3s |
| `one model tool call produces exactly one gateway request and finishes the turn` | 1.9s |
| the other 404 tests | ~0.3s combined |

### Defects found

1. **Duplicate execution.** `test:unit` lists 13 `packages/agent-worker`
   files; `test:agent-worker` runs 12 of the same. 138 tests run twice
   (~2.2s wasted, 40% of the unit suite).
2. **Two files sit in the wrong suite.**
   - `instruction-scope-extension.test.mjs` runs only in `test:agent-worker`.
   - `subagent-policy.test.mjs` runs only in `test:unit`.
   Both execute exactly once today, but each is in the suite that does not own
   it. Any future edit to one list silently changes which worker tests run.
3. **CI runs no tests.** `.github/workflows/check.yml` runs `pnpm check`,
   `check:ui-font`, `check:architecture`, `lint`, `format:check`, `build`,
   `cargo fmt`. There is no `test:unit`, `test:agent-worker`,
   `test:projection`, or `cargo test`.

## Requirements

**R1 — One owner per suite.** `test:unit` covers `src/**` and
`packages/agent-contract/**` only. Every `packages/agent-worker` test runs in
`test:agent-worker` and nowhere else.

**R2 — Every file runs.** Both suites must cover the complete on-disk set:

- `test:unit`: all `src/**/*.test.mjs` plus `packages/agent-contract/src/*.test.mjs`
- `test:agent-worker`: all `packages/agent-worker/src/**/*.test.mjs`

Verify by comparing the glob-expanded set against `find`, not by trusting the
list.

**R3 — Fast feedback is fast.** Add `test:smoke` for the three
process-spawning tests (they live in `main.test.mjs` and
`worker-smoke.test.mjs`). `test:smoke` runs those two files; the rest of the
worker suite stays in `test:agent-worker`.

Target: `pnpm test:unit` under 1s after R1.

**R4 — CI executes the suites.** `.github/workflows/check.yml` gains:

```yaml
- run: pnpm test:unit
- run: pnpm test:agent-worker
- run: pnpm test:projection
- run: pnpm test:smoke
- run: cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Order them after `pnpm check` (type errors should fail first) and before
`pnpm build`.

**R5 — No test content changes.** Do not delete, rewrite, or weaken any test.
Only suite membership and CI steps change.

**R6 — Document the split.** `.trellis/spec/frontend/index.md` and
`.trellis/spec/agent-worker/index.md` state which suite owns which tests and
what `test:smoke` is for.

## Acceptance Criteria

- [ ] `test:unit` contains no `packages/agent-worker` path.
- [ ] `test:agent-worker` runs all 14 worker test files, including
      `subagent-policy.test.mjs` and `instruction-scope-extension.test.mjs`.
- [ ] `test:smoke` exists and runs the two process-level files.
- [ ] `pnpm test:unit` completes in under 1.5s.
- [ ] Total test count across suites is 407 + 140 (no file runs twice, none is
      skipped); record the exact numbers.
- [ ] `check.yml` includes all five test steps.
- [ ] `pnpm check`, `pnpm lint`, `pnpm check:architecture`,
      `pnpm format:check` still pass.
- [ ] No test file content changed.

## Non-Goals

- Reducing assertions or deleting tests.
- Introducing a coverage tool.
- Parallelizing suites or adding a test cache.
- Changing `cargo test` scope.
- Touching the Rust test module layout.

## Constraints

- Branch `beta`; base `beta`.
- CI must keep working on `ubuntu-latest` with Node 22.
- Do not reorder unrelated workflow steps.
