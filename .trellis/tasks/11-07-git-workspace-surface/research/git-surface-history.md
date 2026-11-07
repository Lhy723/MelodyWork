# Git surface history and current state

Recovered reference: `git show 65336d1d:src/features/git/git-workspace.tsx` (487 lines).
Deleted in `767e7cb1` ("chore: delete unreachable UI modules and duplicate macOS check");
that commit body lists the file and the diff removes 487 lines.

## Why it was orphaned

- `7ae469b1` ("feat: add resizable workspace side panel") removed
  `import { GitWorkspace }` and its `Presence` mount from
  `src/features/chat/agent-workspace.tsx`. Before the commit the only mount was
  that file's lines 608-624 (`git show 7ae469b1^:src/features/chat/agent-workspace.tsx`).
- The same commit added `src/features/workspace/workspace-side-panel.tsx`
  (389 lines at introduction) and gave `ChangeReview` an `embedded` variant
  (`git show --stat 7ae469b1` reports `change-review.tsx | 38 +-`).
- `ChangeReview` had no renderer before `7ae469b1`: `git grep -n 'change-review'
  7ae469b1^ -- src` matches only the fixture path string in
  `src/lib/melody-bridge.ts:144`. So the side panel did not merge the Git
  workspace into review; it replaced the surface wholesale.
- `767e7cb1` then treated the file as unreachable code and deleted it. The
  deletion recorded intent to remove dead code, not a product decision to drop
  staging/commit/branch/worktree.

## Component contract (the interface to restore)

`git-workspace.tsx:32-37`:

```ts
interface GitWorkspaceProps {
  changes: GitChange[];
  cwd: string;
  onClose: () => void;
  onRefreshChanges: () => void;
}
```

Local state: `branches`, `worktrees`, `commitMessage`, `newBranch`,
`worktreePath`, `worktreeBranch`, `loading`, `busy`, `error`, `notice`,
`pendingRemoval`, plus three submit-button refs (`:46-60`). It calls
`useGlobalLiveActivity()` for global toasts (`:41-45`) and
`HoldToConfirm` for worktree removal (`:430-440`).

Chrome: root `<section className="absolute inset-0 z-20 flex min-h-0 flex-col
bg-background">` with its own 16px header holding title, cwd, refresh and close
(`:179-215`); body is `grid ... lg:grid-cols-2` with the worktree section on
`lg:col-span-2`.

Every mutation runs through `runAction` (`:124-176`), which sets busy/notice,
then `Promise.all([refresh(), Promise.resolve(onRefreshChanges())])`, and on
failure also posts a retry action to the live-activity toast.

## Section → bridge helper → Rust command → permission

| UI section | Bridge helper (`src/lib/melody-bridge-git.ts`) | Rust command | Allowlist |
| --- | --- | --- | --- |
| 更改 list, 暂存 | `stageGitPaths` (`:32`) | `git_stage` (`git_runtime.rs:323`) | `permissions/default.toml:12` |
| 更改 list, 取消暂存 | `unstageGitPaths` (`:41`) | `git_unstage` (`git_runtime.rs:341`) | `:13` |
| 提交 form | `commitGitChanges` (`:50`) | `git_commit` (`git_runtime.rs:363`) | `:14` |
| 分支 list | `getGitBranches` (`:24`) | `git_branches` (`git_runtime.rs:295`) | `:11` |
| 分支 checkout | `checkoutGitBranch` (`:58`) | `git_checkout_branch` (`git_runtime.rs:381`) | `:15` |
| 创建分支 | `createGitBranch` (`:67`) | `git_create_branch` (`git_runtime.rs:394`) | `:16` |
| 工作树 list | `getGitWorktrees` (`:76`) | `git_worktrees` (`git_runtime_worktrees.rs:36`) | `:17` |
| 创建工作树 | `createGitWorktree` (`:89`) | `git_create_worktree` (`git_runtime_worktrees.rs:46`) | `:18` |
| 移除工作树 | `removeGitWorktree` (`:100`) | `git_remove_worktree` (`git_runtime_worktrees.rs:70`) | `:19` |

Worktree commands are exposed through `git_runtime.rs:8-11` (`#[path =
"git_runtime_worktrees.rs"] mod git_runtime_worktrees; pub use
git_runtime_worktrees::*;`) and registered at `src-tauri/src/lib.rs:113-123`.
`git_runtime_tests.rs:26` covers `parse_worktrees`; `:36` covers untracked-file
stats and diffs; `:63` covers unicode/space paths.

## Current consumers of the nine helpers

`grep` over `src` + `packages` finds zero importers for `getGitBranches`,
`stageGitPaths`, `unstageGitPaths`, `commitGitChanges`, `checkoutGitBranch`,
`createGitBranch`, `getGitWorktrees`, `createGitWorktree`,
`removeGitWorktree`. Only `getGitChanges` (`src/hooks/use-git-changes.ts:5`)
and `getGitDiff` (`src/features/git/change-review.tsx:10`) are imported.

No Host tool exposes these commands either: `src-tauri/src/pi_tool_gateway/`
contains no `git_*` command binding; the only git subprocess there is
`subagent_worktrees.rs:62` running `git worktree add --detach` for its own
isolation directory. A terminal session can run the `git` CLI, but that is not
this API.

## What changed around the recovered UI

1. The panel now owns chrome: `workspace-side-panel.tsx:347-476` renders one
   `role="tabpanel"` per tab and `ChangeReview` uses the `embedded` prop
   (`:427-435`). The recovered overlay root and its close button no longer fit.
2. `ChangeReview` owns diff rendering (`change-review.tsx:218` calls
   `getGitDiff`) and a directory tree; the recovered component has a flat list
   with no diff. Restoring it next to review duplicates the file list.
3. Staging state comes from `git_changes`: `git_runtime.rs:231` sets
   `staged = index != ' ' && index != '?'`, so one entry per path can be
   `staged` while also carrying unstaged edits.
4. Dependencies still exist: `useGlobalLiveActivity`
   (`src/components/interior/live-activity.tsx:577`), `HoldToConfirm`
   (`src/components/interior/hold-to-confirm.tsx:20`), `LoadingButton`,
   `Input`, `Button`, `TreeView`-independent markup.
5. Domain types unchanged: `src/domain/git.ts:1-28`.

## Refresh gap

`src/hooks/use-git-changes.ts:24-26` refreshes only when `refresh` changes
(cwd), so the count rendered at `session-workspace-content.tsx:157,163,169`
goes stale after an agent turn until the user presses 刷新. The turn-complete
signal exists in the store: `agent-store-receive.ts:369-376` sets
`chatStatus: "ready"` when `result.completed`; cancel also settles to `ready`
(`agent-store.ts:171`).
