# Implement — Test Suite Configuration and CI Gate

## Preconditions

- Worktree carries the uncommitted store-harness changes; do not revert them.
- Read `prd.md` and `design.md`.
- Capture the baseline below before editing anything.

## Baseline

```bash
pnpm test:unit            # expect 407 pass
pnpm test:agent-worker    # expect 140 pass
pnpm test:projection      # expect 24 pass
git status --porcelain    # note the existing harness files
```

Record the three counts and the wall times.

## Step 1 — Rewrite `test:unit`

Remove every `packages/agent-worker/*` path. Result must be:

```
node --experimental-strip-types --experimental-test-module-mocks
  --import ./scripts/test-register.mjs --test
  src/domain/*.test.mjs
  src/domain/agent/*.test.mjs
  src/features/files/*.test.mjs
  src/features/research/*.test.mjs
  src/stores/*.test.mjs
  packages/agent-contract/src/*.test.mjs
```

Verify: `pnpm test:unit` passes and the count drops by the worker share
(407 → about 269). Record the exact number.

## Step 2 — Rewrite the worker `test` script

In `packages/agent-worker/package.json`, list the 12 pure files, adding
`src/pi/subagent-policy.test.mjs` and removing `src/main.test.mjs` and
`src/worker-smoke.test.mjs`.

Verify: `pnpm test:agent-worker` passes. Its count should equal the worker
share removed from `test:unit` plus `subagent-policy`.

## Step 3 — Add `test:smoke`

Root `package.json`:

```json
"test:smoke": "node --experimental-strip-types --test packages/agent-worker/src/main.test.mjs packages/agent-worker/src/worker-smoke.test.mjs"
```

Verify: `pnpm test:smoke` passes; expect ~4.5s and 3 tests.

## Step 4 — Expansion check

Run the script from `design.md` §Verification. Required outcome:

- no `agent-worker` path inside `test:unit`
- every file under `packages/agent-worker/src/**/*.test.mjs` appears in exactly
  one of `test:agent-worker` or `test:smoke`
- total tests across all suites equals the baseline total (407 + 140 + 24), i.e.
  nothing was dropped or duplicated

Record the printed numbers.

## Step 5 — CI

Add five steps to `.github/workflows/check.yml` after `pnpm check` and before
`pnpm build`:

```yaml
      - run: pnpm test:unit
      - run: pnpm test:agent-worker
      - run: pnpm test:projection
      - run: pnpm test:smoke
      - run: cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Verify the YAML parses:

```bash
node -e "console.log(require('fs').readFileSync('.github/workflows/check.yml','utf8').split('\n').filter(l=>l.includes('- run:')).join('\n'))"
```

## Step 6 — Node 22 compatibility check

CI uses Node 22; the local run used 24. `--experimental-test-module-mocks` must
exist there for the store tests.

If Node 22 is available locally (nvm/fnm/volta), run:

```bash
pnpm test:unit
```

on 22 and record the result. If it is not available, state that explicitly in
`implement.md` and note that CI is the first verification — do not claim the
flag works on 22 without evidence.

If the flag is unavailable, stop and report: the store suite needs a
version guard, which is a separate decision.

## Step 7 — Spec update

- `.trellis/spec/frontend/index.md`: which suite owns renderer/contract tests;
  `test:smoke` exists for process-spawning tests.
- `.trellis/spec/agent-worker/index.md`: the worker suite owns pure worker
  tests; the two spawn tests live in the root `test:smoke`.

Keep both to a few lines; do not restate the file lists.

## Step 8 — Full gates

```bash
pnpm test:unit
pnpm test:agent-worker
pnpm test:projection
pnpm test:smoke
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm check
pnpm lint
pnpm check:architecture
pnpm format:check
```

## Step 9 — Prove no test changed

```bash
git diff --stat -- '*test.mjs'
```

Expected: empty. Only `package.json` files, the workflow, and specs changed.

## Rollback

Every change is a list or a CI step. Restore the previous `test:unit` string,
the worker `test` string, delete `test:smoke`, and remove the five CI steps.

## Out Of Scope

- Editing test content.
- Coverage tooling.
- Suite parallelization.
- Node version bumps.

## Result (2026-11-07)

Implemented; task remains `in_progress`; no commit.

### Changes

| File | Change |
|------|--------|
| `package.json` | `test:unit` loses all 13 worker paths; new `test:smoke` |
| `packages/agent-worker/package.json` | `test` gains `subagent-policy`, loses `main` and `worker-smoke` |
| `.github/workflows/check.yml` | five test steps after `format:check`, before `build` |
| `.trellis/spec/frontend/index.md` | suite ownership; removed the false "no test runner" claim |
| `.trellis/spec/agent-worker/index.md` | removed the false "no test files" claim |

### Suite results

| Suite | Before | After | Wall time before → after |
|-------|--------|-------|--------------------------|
| `test:unit` | 407 | **263** | 5.5s → **0.84s** |
| `test:agent-worker` | 140 | **143** | 2.9s → 1.26s |
| `test:projection` | 24 | 24 | 0.22s |
| `test:smoke` | — | **3** | 2.3s |
| `cargo test --lib` | 26 | 26 | 2.0s |

Totals: 263 + 143 + 24 + 3 = 433 renderer/worker tests, plus 26 Rust.
Before: 407 + 140 + 24 = 571. The difference is the 138 duplicated worker
tests (407 included them) minus the 2 newly owned ones.

### Partition proof

```
on disk worker tests: 14
worker suite: 12 | smoke suite: 2
unit worker paths: 0
OK: every file in exactly one suite
```

### Node 22 verification (the one open risk)

Local runs used Node 24.14.1; CI pins Node 22. Downloaded Node **22.15.0**
temporarily and ran the full unit suite:

```
node --version → v22.15.0
--experimental-test-module-mocks → mock.module: function
tests 263 / pass 263 / fail 0
```

The flag works on 22.15.0, so the store tests run in CI. The temporary Node
install was deleted afterwards. Note: the CI workflow pins `node-version: 22`,
which resolves to the latest 22.x; the tested floor is 22.15.0.

### Gates

`pnpm check`, `pnpm lint`, `pnpm check:architecture`, `pnpm format:check`,
`cargo test --lib` — all pass.

### No test content changed

`git diff --stat -- '*test.mjs' '*_tests.rs'` → empty.
