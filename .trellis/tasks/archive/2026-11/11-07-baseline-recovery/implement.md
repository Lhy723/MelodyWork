# Implement — Baseline Recovery

## Preconditions

- On `beta`; do not commit, push, or archive anything.
- Worktree has 266 changes that must be preserved exactly.
- Read `prd.md` and `design.md` first.
- Ask for approval before step 1 (snapshot ref) and before any commit.

## Step 0 — Preflight record

```bash
git branch --show-current
git status --porcelain > .trellis/tasks/11-07-baseline-recovery/baseline-status.txt
grep -c '^??' .trellis/tasks/11-07-baseline-recovery/baseline-status.txt   # expect 109
grep -c '^ M' .trellis/tasks/11-07-baseline-recovery/baseline-status.txt   # expect 101
grep -c '^ D' .trellis/tasks/11-07-baseline-recovery/baseline-status.txt   # expect 56
```

Stop if the counts differ; the premise changed.

## Step 1 — Snapshot (approval gate)

Use the temporary-index method from `design.md`.

```bash
export GIT_INDEX_FILE="$(git rev-parse --git-dir)/wip-snapshot.index"
git read-tree HEAD
git add -A
tree="$(git write-tree)"
snapshot="$(git -c user.name='Trellis Snapshot' -c user.email='snapshot@local' \
  commit-tree "$tree" -p HEAD -m 'wip snapshot: pi migration worktree')"
git update-ref refs/backup/wip-2026-11-07 "$snapshot"
unset GIT_INDEX_FILE
rm -f "$(git rev-parse --git-dir)/wip-snapshot.index"
```

Record in `snapshot.txt`:

- ref name, commit sha, `git ls-tree -r --name-only <ref> | wc -l`
- `git ls-tree -r --name-only <ref> -- <one-untracked-file>` (non-empty)
- `git diff --stat <ref>` (empty)
- `git status --porcelain | wc -l` (still 266)

**Review gate 1:** do not proceed until the snapshot is verified and the
worktree count is unchanged.

## Step 2 — Restore tests

```bash
git status --porcelain | awk '$1=="D"{print $2}' \
  | grep -E '\.test\.mjs$|_tests\.rs$' \
  | grep -v 'acp_policy_tests\.rs$' \
  | tee .trellis/tasks/11-07-baseline-recovery/restored-files.txt \
  | xargs git checkout HEAD --
```

Verify:

```bash
wc -l .trellis/tasks/11-07-baseline-recovery/restored-files.txt   # 55
git status --porcelain | grep -c '^ D'                            # 1 (acp_policy_tests.rs)
```

Every restored file must be byte-identical to `HEAD`:

```bash
git diff --stat HEAD -- $(cat .trellis/tasks/11-07-baseline-recovery/restored-files.txt)
```

Expect empty (restored content equals `HEAD`).

## Step 3 — Restore scripts

Root `package.json`: add the four keys with the exact `HEAD` strings.
`packages/agent-worker/package.json`: add `test`.

Verify:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json'))"
node -e "JSON.parse(require('fs').readFileSync('packages/agent-worker/package.json'))"
pnpm exec prettier --check package.json packages/agent-worker/package.json
```

If Prettier fails, format only those two files.

## Step 4 — Restore Rust wiring

Append to `src-tauri/src/git_runtime.rs`:

```rust
#[path = "git_runtime_tests.rs"]
mod tests;
```

Append to `src-tauri/src/workspace_runtime.rs`:

```rust
#[path = "workspace_runtime_tests.rs"]
mod tests;
```

Do not wire `acp_policy_tests.rs`.

Verify: `cargo test --manifest-path src-tauri/Cargo.toml --lib --no-run`.

A compile error is a result; record it and continue to triage. Do not repair
product code.

## Step 5 — Run suites

Run each command, saving stdout+stderr and the exit code:

```bash
cd .trellis/tasks/11-07-baseline-recovery
pnpm test:unit            > unit.log 2>&1; echo $? > unit.exit
pnpm test:projection      > projection.log 2>&1; echo $? > projection.exit
pnpm test:agent-worker    > worker.log 2>&1; echo $? > worker.exit
cargo test --manifest-path ../../../src-tauri/Cargo.toml --lib \
                          > rust.log 2>&1; echo $? > rust.exit
```

Run from the repo root and redirect into the task directory; adjust the
relative path. If a suite cannot start (missing script, bad flag), record the
error and move on.

## Step 6 — Triage

Produce `triage.md` using the format in `design.md`:

- one row per restored file (55 rows)
- categories: `PASS`, `API_DRIFT`, `OBSOLETE`, `NEEDS_REWRITE`, `RUNNER`
- evidence: test count or first concrete error line
- summary counts and the commands used

Do not edit test bodies or product code.

## Step 7 — Gates and report

```bash
pnpm lint
pnpm check:architecture
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

`pnpm check` is expected to remain blocked by the pre-existing
`src/lib/melody-bridge-workspace.ts:514` error; record it, do not fix it.

Report:

- snapshot ref + sha
- restored file count
- suite exit codes and pass/fail counts
- triage summary
- remaining blockers

## Rollback

- Snapshot only: `git update-ref -d refs/backup/wip-2026-11-07`.
- Restored tests: `rm` the files listed in `restored-files.txt`.
- Scripts: remove the added keys.
- Rust wiring: remove the two `#[path]` blocks.

## Out Of Scope

- Fixing any failing test.
- Re-adding `acp_policy_tests.rs`.
- The TypeScript `ArrayBufferLike` error.
- Committing, pushing, archiving tasks.

## Result (2026-11-07)

Task is `in_progress`; no commit, push, or archive was performed.

### Snapshot

- `refs/backup/wip-2026-11-07`
- commit `89da53381c583caf1aaef45e89976224852620bd`
- tree `5f0290ef785b9f3f035b2e267c600b9abc343c03`
- 858 files captured; tracked diff vs snapshot 0;
  only file added after the snapshot: `snapshot.txt`.

### Restore

- 55 test files restored byte-identical to `HEAD`
  (53 `.mjs` + `git_runtime_tests.rs` + `workspace_runtime_tests.rs`).
- `src-tauri/src/acp_policy_tests.rs` left deleted: orphan in `HEAD` too.
- Restored 4 root `test:*` scripts and the worker `test` script,
  values verified equal to `HEAD`.
- Added `#[path = "git_runtime_tests.rs"] mod tests;` to `git_runtime.rs`.

### Deviation

`workspace_runtime_tests.rs` is restored but **not wired**. Wiring it fails
compilation with 8 errors because the migration moved
`read_workspace_binary_bytes`, `collect_tree`, `terminal_command`, and
`wait_for_terminal_exit` out of `workspace_runtime` scope. It is recorded as
`API_DRIFT` instead of forcing a test rewrite in this task. As a result
`cargo test --lib` runs 19 tests, not the full restored set.

### Suite results

| Suite | Tests | Pass | Fail | Exit |
|-------|-------|------|------|------|
| `pnpm test:unit` | 321 | 273 | 48 | 1 |
| `pnpm test:projection` | 24 | 24 | 0 | 0 |
| `pnpm test:agent-worker` | 68 | 65 | 3 | 1 |
| `cargo test --lib` | 19 | 19 | 0 | 0 |

### Triage

`triage.md`: 47 `PASS`, 8 `API_DRIFT`, 1 `OBSOLETE`, 0 `NEEDS_REWRITE`,
0 `RUNNER` (56 rows including the orphan).

Top API drift causes:

- `GOAL_STATE_ENTRY` no longer exported by `goal-extension.ts`
- `applyModelPolicyOverrides` no longer exported by `session-adapter.ts`
- `MAX_EXPLORER_BRING_BACK_CODEPOINTS` no longer exported by `explorer-branch.ts`
- `capability-report` inputs now yield `undefined` where the test expects arrays
- workspace terminal/path helpers moved into submodules

### Gates

| Command | Result |
|---------|--------|
| `pnpm lint` | pass |
| `pnpm check:architecture` | pass |
| `cargo fmt --check` | pass |
| `pnpm check` | still blocked by pre-existing `melody-bridge-workspace.ts:514` TS error |

### Delta vs snapshot (tracked paths only)

- 55 restored test files: +12,730 lines
- `package.json`: +5/-1
- `packages/agent-worker/package.json`: +2/-1
- `src-tauri/src/git_runtime.rs`: +3

No product source changed.
