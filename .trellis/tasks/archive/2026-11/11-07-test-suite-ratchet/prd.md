# Test Suite Coverage Ratchet

## Goal

Make an orphaned or double-run `*.test.mjs` file a hard failure, and make the
frontend spec describe which suite actually owns which test files.

## Defects

1. `test:unit` runs an explicit glob list, not `src/**/*.test.mjs`. A test file
   added under `src/hooks/`, `src/lib/`, `src/components/`, `src/features/chat/`
   or any other unlisted directory is silently never executed.
2. `.trellis/spec/frontend/index.md` claims `test:unit` owns `src/**/*.test.mjs`,
   which is false and hides defect 1.
3. `src/domain/research-source-adapter.test.mjs` derives the concurrent-slot
   wait from the real clock and asserts an exact `[25]`, so two calls crossing a
   millisecond boundary flake under load; fixing it is in scope for this
   test-suite-integrity task.

## Requirements

- New `scripts/check-test-suite-coverage.mjs` discovers every `*.test.mjs`
  under `src/` and `packages/` and reads the suite definitions from their real
  sources: root `package.json` `test:unit` and `test:smoke`, and
  `packages/agent-worker/package.json` `test`.
- It fails when a file is covered by no suite (orphan) or more than one suite
  (duplicate execution), prints a count summary, and lists every offender.
- Only single-segment `*` globs are expanded, matching
  `scripts/check-format-coverage.mjs`. No new dependencies.
- Wire it as `pnpm check:test-coverage` and append it to the end of `pnpm check`.
- Correct the "Suite ownership" paragraph in `.trellis/spec/frontend/index.md`.
- Do not change test content beyond the defect-3 flake fix, add test files, or
  modify CI workflows.

## Acceptance Criteria

- [x] `pnpm check:test-coverage` exits 0 on the current tree with correct counts.
- [x] An orphan probe file makes both `pnpm check:test-coverage` and `pnpm check`
      exit 1 and names the file; removing it restores both.
- [x] Adding a unit-owned file to `test:smoke` is reported as a duplicate.
- [x] `test:unit`, `test:agent-worker`, `test:smoke`, `cargo test --lib`,
      `lint`, `check:architecture`, `format:check` and `pnpm check` pass.
- [x] The new script and `package.json` pass `prettier --check`.

## Non-Goals

- Rewriting `test:unit` to a recursive glob.
- Adding tests or changing test file content.
- Changing CI workflow files.
