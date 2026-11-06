# Design — Baseline Recovery

## 1. Non-Destructive Snapshot

Requirements: capture tracked modifications, untracked files, and deletions
without touching `HEAD`, the index, or the worktree.

### Rejected

- `git stash push -u` — would reset the worktree, which is the opposite of a
  safe snapshot.
- `git add -A && git commit` — moves `HEAD` on `beta`.
- `git archive HEAD` — captures only committed content, not the 266 changes.
- Peer-copy of the directory — loses git object identity and is slow.

### Chosen: temporary index + commit-tree

```bash
export GIT_INDEX_FILE="$(git rev-parse --git-dir)/wip-snapshot.index"
git read-tree HEAD
git add -A                     # respects .gitignore; includes untracked, records deletions
tree="$(git write-tree)"
snapshot="$(git commit-tree "$tree" -p HEAD -m 'wip snapshot: pi migration worktree')"
git update-ref refs/backup/wip-2026-11-07 "$snapshot"
rm -f "$GIT_INDEX_FILE"
```

Why it is safe:

- `GIT_INDEX_FILE` isolates staging; the real index is untouched.
- `git add -A` stages tracked changes, new files, and deletions, but not ignored
  paths.
- `commit-tree` creates a dangling commit; `update-ref` gives it a stable name.
- The worktree is never written.

If `commit-tree` complains about identity, prefix with
`git -c user.name="Trellis Snapshot" -c user.email="snapshot@local"`.

### Verification

```bash
git ls-tree -r --name-only refs/backup/wip-2026-11-07 | wc -l
git ls-tree -r --name-only refs/backup/wip-2026-11-07 -- <one-untracked-file>
git diff --name-only refs/backup/wip-2026-11-07 -- $(git ls-files)   # tracked: expect empty

# Full worktree-vs-snapshot file set (git diff ignores untracked files)
git ls-tree -r --name-only refs/backup/wip-2026-11-07 | LC_ALL=C sort > /tmp/ref.txt
{ git ls-files | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done; \
  git ls-files --others --exclude-standard; } | LC_ALL=C sort -u > /tmp/wt.txt
comm -13 /tmp/ref.txt /tmp/wt.txt   # only files created after the snapshot
comm -23 /tmp/ref.txt /tmp/wt.txt   # expect empty
```

`git diff <ref>` does **not** compare untracked files: a snapshot that includes
new untracked modules will look like it deletes them. The file-set comparison
above is the authoritative check.

## 2. Restore Test Files

The 56 deletions are all tests and all exist in `HEAD`, so restore is a
path-limited checkout:

```bash
git status --porcelain | awk '$1=="D"{print $2}' \
  | grep -E '\.test\.mjs$|_tests\.rs$' \
  | grep -v 'acp_policy_tests\.rs$' \
  | xargs git checkout HEAD --
```

Notes:

- `git checkout HEAD -- <paths>` restores both worktree and index for exactly
  those paths; no other file is touched.
- Exclude `acp_policy_tests.rs`: `HEAD` has no `acp_policy.rs` and no
  `#[path]` reference `git grep` can find. It is dead in `HEAD`; keep it
  deleted and record it as `OBSOLETE`.
- After restore, `git status` should show 55 fewer `D` entries and 55 restored
  files.

## 3. Restore Commands

Do **not** `git checkout HEAD -- package.json`: the file has unrelated
worktree edits.

Add only the missing keys, using the exact `HEAD` strings:

Root `package.json`:

- `test:agent-worker`
- `test:pi-worker-smoke`
- `test:unit`
- `test:projection`

`packages/agent-worker/package.json`:

- `test`

Insert them next to the other scripts, then verify formatting:

```bash
pnpm format:check
node -e "JSON.parse(require('fs').readFileSync('package.json'))"
```

If `format:check` reports the edited JSON, run Prettier on those two files only.

## 4. Restore Rust Wiring

`git_runtime.rs` and `workspace_runtime.rs` in `HEAD` end with:

```rust
#[path = "git_runtime_tests.rs"]
mod tests;
```

```rust
#[path = "workspace_runtime_tests.rs"]
mod tests;
```

Re-add those two-line blocks at the end of the corresponding files. Position
does not matter semantically (`use super::*` resolves to the file's module),
but keep them last to match `HEAD`.

Do not add a module for `acp_policy_tests.rs`.

## 5. Runner Compatibility

Environment: Node `v24.14.1`, package engines `>=22 <25`.

The restored scripts use `node --experimental-strip-types --test`. On Node 24
type stripping is enabled by default; the flag may still be accepted. Treat a
flag error as `RUNNER`, not `API_DRIFT`, and record the working invocation
(`node --test ...`) in `triage.md`. Do not rewrite the scripts in this task
unless the flag is rejected; if it is, restoring the exact command is more
important than a clean run, so record the failure and propose a follow-up.

Rust: `tauri` dev-dependency already enables the `test` feature. Restored Rust
tests may need APIs that changed during the migration; compile errors are
`API_DRIFT`.

## 6. Triage Format

`triage.md` is a single table, one row per restored file:

| File | Category | Evidence |
|------|----------|----------|
| `src/domain/request-gate.test.mjs` | PASS | 4/4 |
| `packages/agent-worker/src/pi/tool-gateway.test.mjs` | API_DRIFT | `Cannot find export '...'` |

Rules:

- One category per file; no "unknown".
- Evidence is the first concrete error line or the test count.
- Sort by category, then path.
- Add a summary block at the top: counts per category, plus the exact commands
  that produced them.

## 7. Risks

- **Snapshot ref created but wrong content.** Mitigated by the untracked-file
  sample and `git diff --stat` check.
- **Restored tests overwrite newer work.** Impossible for the deleted set: they
  are absent from the worktree; `git checkout HEAD -- <path>` only writes those
  paths.
- **Script restore clobbers unrelated edits.** Mitigated by editing only the
  listed keys, not checking out the file.
- **Rust tests fail to compile, blocking `cargo test`.** That is a valid
  `API_DRIFT` result; record it and do not repair in this task.
- **Restored `.mjs` tests import deleted modules.** Classify `OBSOLETE` or
  `API_DRIFT`; do not delete the test in this task.

## 8. Rollback

- Remove the snapshot name only:
  `git update-ref -d refs/backup/wip-2026-11-07` (objects become unreachable;
  the worktree is unaffected).
- Undo restore: `rm` the 55 restored files (they were deleted before this
  task), not `git checkout`.
- Undo script edits: remove the added keys.
- Undo Rust wiring: remove the two `#[path]` blocks.
