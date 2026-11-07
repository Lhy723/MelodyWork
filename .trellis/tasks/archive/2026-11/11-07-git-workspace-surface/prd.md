# Git 工作区能力与变更刷新

## Decision (2026-11-07): Option A — C10 is binding; restore stage/commit/branch/worktree UI.

Product owner selected Option A in this session: restore the full Git workspace
as a workspace-panel tab plus the turn-settle refresh. The option analysis below
is kept as the record; options B and C are not pursued.

## Problem

The Git control surface shrank without a product decision. A working workspace
(stage/unstage, commit, branch, worktree) was unmounted by a layout commit and
then deleted as dead code, while its nine bridge helpers and nine Rust commands
remained. Separately, agent turns never refresh the change count, so the sidebar
badge lies until the user presses 刷新.

## Evidence

| Claim | Evidence |
| --- | --- |
| Full Git workspace existed (487 LOC) | `git show 65336d1d:src/features/git/git-workspace.tsx` |
| Unmounted by the side-panel commit | `7ae469b1` removed `import { GitWorkspace }` and its `Presence` mount; pre-commit mount was `git show 7ae469b1^:src/features/chat/agent-workspace.tsx` lines 608-624 |
| Review surface replaced it, not merged with it | `7ae469b1` added `workspace-side-panel.tsx` and an `embedded` variant for `ChangeReview`; `ChangeReview` had no renderer before (`git grep 'change-review' 7ae469b1^ -- src` hits only `src/lib/melody-bridge.ts:144`) |
| File later deleted as unreachable | `767e7cb1` body lists `src/features/git/git-workspace.tsx (487 LOC)`; stat removes 487 lines |
| Nine helpers still exist, zero importers | `src/lib/melody-bridge-git.ts:24,32,41,50,58,67,76,89,100`; `grep` importers = 0 (only `:7` and `:14` are imported) |
| Nine commands still registered and allowlisted | `src-tauri/src/lib.rs:36-37,113-123`; `src-tauri/permissions/default.toml:9-19` |
| Commands implemented, worktree ones in a split module | `src-tauri/src/git_runtime.rs:295,323,341,363,381,394`; `src-tauri/src/git_runtime_worktrees.rs:36,46,70` re-exported at `git_runtime.rs:8-11` |
| No Host tool consumes them | `src-tauri/src/pi_tool_gateway/` has no `git_*` binding; only `subagent_worktrees.rs:62` runs `git worktree add --detach` for itself |
| Parity doc promises all of it | `docs/architecture/pi-migration/feature-parity.md:28` (C10 保留Host, 不改变现有Git工作流); `docs/architecture/pi-migration/acceptance-report.md:163` |
| Review-only surface today | `src/features/git/change-review.tsx:218` calls only `getGitDiff`; `workspace-side-panel.tsx:427-435` mounts it for `kind: "review"` |
| Change count goes stale | `src/hooks/use-git-changes.ts:24-26` refreshes only on mount/cwd; count rendered at `src/features/chat/session-workspace-content.tsx:157,163,169` |
| Turn-complete signal exists in the store | `src/stores/agent-store-receive.ts:369-376` (`chatStatus: "ready"` when `result.completed`); cancel settles the same way at `src/stores/agent-store.ts:171` |

## User-visible impact

1. The only in-app Git action is reading diffs. Staging and committing require a
   terminal; branch checkout and worktree management have no UI at all.
2. The sidebar count and the review tab can show a pre-turn state after the agent
   writes files; users judge the turn finished while the badge still shows the
   old number.
3. C10 and the acceptance report claim a capability the build no longer exposes,
   so parity sign-off is currently inaccurate.

## Scope boundary

In scope

- One workspace surface decision: restore, re-scope, or hybrid (below).
- Refresh of `useGitChanges` after an agent turn settles (all options).
- Panel placement inside the existing tab host if a UI is restored.

Out of scope (all options)

- Rust command behavior or signatures, sandbox checks, commit signing.
- Hunk-level staging, branch delete/merge/rebase, PR creation.
- Agent-tool exposure of git commands (no tool wrapper exists today).
- Changing `git_changes`/`git_diff` contracts.

## Options

| | A. Restore full workspace | B. Review only | C. Hybrid: stage + commit |
| --- | --- | --- | --- |
| Deliverable | Git tab: 更改+暂存/取消暂存, 提交, 分支(切换/新建), 工作树(列表/创建/移除) | Delete 9 helpers + 9 commands; parity says review/diff only | Review tab gains 暂存/取消暂存 + 提交; branch/worktree stay UI-less |
| Files / LOC | `src/features/git/git-workspace.tsx` new ~470 (from 487 recovered); `workspace-side-panel.tsx` +22; `agent-workspace-actions.ts` +10; `agent-workspace-view-types.ts` +1; `agent-workspace.tsx` +12; `use-git-changes.ts` +14 | `melody-bridge-git.ts` 107→~30; `git_runtime.rs` −162 (commands 144 + `run_git_dynamic` 18); `git_runtime_worktrees.rs` −82; `lib.rs` −14; `default.toml` −9; `feature-parity.md:28`, `acceptance-report.md:163`, `use-git-changes.ts` +14 | `change-review.tsx` 354→~520; `melody-bridge-git.ts` 107→~65 (−6 helpers); `workspace-side-panel.tsx` +2; `use-git-changes.ts` +14; no Rust change |
| Reused | 9 helpers, 9 commands, `HoldToConfirm`, `LoadingButton`, `useGlobalLiveActivity`, `GitChange.staged` from `git_runtime.rs:231` | `getGitChanges`, `getGitDiff`, review UI, `RequestGate` | `getGitChanges`/`getGitDiff`, review tree+diff, `HoldToConfirm` for commit? (plain button is enough), `RequestGate` |
| New | Embedded variant of recovered sections; turn-settle refresh; tab kind `"git"` | Doc edits only; refresh wiring | Stage toggle + commit form inside review; refresh wiring |
| Migration / compat risk | Two change lists (Git tab vs 审阅 tab) with different affordances; 487-LOC component must lose its overlay chrome; no Rust risk | Capability loss is irreversible for users; deletes working host code that C10/acceptance report vouch for; parity text must change | Six helpers stay dead forever (no Host tool consumes them), so dead-code cleanup recurs; review tab grows to ~520 LOC |
| Evidence it works | Manual script in `implement.md`: stage/unstage/commit/branch/worktree round-trip on a scratch repo; badge updates after a turn without 刷新 | Gates green; `git grep` shows no helper/command refs; parity row reads review/diff only | Manual script: stage file, commit from review, badge updates after a turn; `git grep` shows 6 helpers still unimported |

### Acceptance criteria

A: with an open workspace, the Git tab stages and unstages a file (count changes
on both staged and total), commits a staged message, checks out and creates a
branch, lists/creates/removes a worktree; each mutation refreshes the badge; the
Rust and bridge layers are untouched.

B: `pnpm check` and `cargo test --lib` pass after deletion; the worktree-only test
`git_runtime_tests.rs:26` is removed with its module while `:36`/`:63` stay; no
source references the nine helpers or nine commands; `feature-parity.md` C10 and
`acceptance-report.md:163` no longer promise staging/commit/branch/worktree in
the app; badge refresh still ships.

C: the 审阅 tab stages and unstages the selected file and commits a message;
branch/worktree helpers may be deleted or kept, and the chosen state is recorded;
badge refresh ships; review tab diff view still works for untracked and binary
files (`git_runtime_tests.rs:36`).

## Product question (must be answered before implementation)

Does MelodyWork still promise in-app Git staging, commit, branch and worktree —
i.e. is C10 (`feature-parity.md:28`) and `acceptance-report.md:163` binding — or
is the product now review/diff-only with everything else delegated to the
terminal? A restored UI is the only way to keep the documented promise; B is the
only way to make the docs and the build agree without a UI.

## Recommendation

Option A. The nine helpers and nine commands are complete, allowlisted and partly
tested; the UI was removed by a layout commit and a later dead-code sweep, not by
a product decision, so restoring it is the only option that gives the orphaned
API a consumer while keeping C10 and the acceptance report true. It needs no Rust
work and reuses the recovered component almost whole; the only new design work is
the embedded chrome, the tab wiring, and the turn-settle refresh. B silently
deletes capability the docs vouch for, and C leaves six helpers permanently dead
with no Host tool to consume them.

If the answer to the product question is "review/diff only", the recommendation
flips to B, because C keeps dead host code alive without a consumer.
