# Implement — Option A: Git tab + turn-settle refresh

Each step is independently verifiable. Do not add test files: `test:unit` globs
(`package.json:36`) exclude `src/hooks` and `src/features/git`, and
`check:test-coverage` fails on a `*.test.mjs` outside every suite
(`.trellis/spec/frontend/index.md:51-59`). Renderer verification is the manual
script below. Rust is untouched, so no cargo gate is required.

## Step 1 — Refresh hook

Files: `src/hooks/use-git-changes.ts` (+14).

- Add `options?: { revision?: number }` (default `0`); keep the existing
  mount/cwd effect (`:24-26`).
- Add a `RequestGate` (`src/domain/request-gate.ts:5-23`) inside the hook: begin
  a token before `getGitChanges`, apply state only when `gate.isCurrent(token)`.
- Add a `useRef` of the last revision; when it differs, call `refresh()`.

Gate: `pnpm exec tsc --noEmit`.

## Step 2 — Turn-settle revision

File: `src/features/chat/agent-workspace.tsx` (+12).

- After the `chatStatus` selector (`:84`), add `gitRefreshRevision` state and a
  `previousChatStatus` ref; increment only when the status leaves
  `submitted`/`streaming` for `ready`/`error` (sketch in `design.md`).
- Pass it: `const git = useGitChanges(cwd, { revision: gitRefreshRevision });`
  (`:251`).

Gate: `pnpm exec tsc --noEmit`.

## Step 3 — Restore the component, embedded

Files: `src/features/git/git-workspace.tsx` (new ~470, source
`git show 65336d1d:src/features/git/git-workspace.tsx`).

- Props per `design.md` (`changes`, `cwd`, `error`, `loading`,
  `onRefreshChanges`); delete `onClose` and the overlay root/close button.
- Root `size-full`, header `h-12`, single-column section stack; keep the three
  sections (更改+提交, 分支, 工作树) and `runAction`
  (`git-workspace.tsx:124-176`).
- Rename the local `loading` to `refreshing`; render the `error` prop above the
  sections; keep `toUserMessage`, `useGlobalLiveActivity`, `HoldToConfirm`.

Gate: `pnpm exec tsc --noEmit && pnpm exec eslint src/features/git/git-workspace.tsx`.

## Step 4 — Tab host integration

Files: `src/features/workspace/workspace-side-panel.tsx` (+22),
`src/features/chat/workspace-panel-layer.tsx` (+1),
`src/features/chat/agent-workspace-view-types.ts` (+1),
`src/features/chat/agent-workspace-actions.ts` (+10).

- `WorkspaceTab` union: `{ id; kind: "git"; label }` (`:79-101`).
- Lazy import beside `ChangeReview` (`:53-57`), render branch at `:427-435`,
  icon in `tabIcon` (`:128-156`).
- Add `"git"` to `onNewTab` unions (`workspace-side-panel.tsx:111`,
  `workspace-panel-layer.tsx:24`, `agent-workspace-view-types.ts:117`) and to
  `newWorkspaceToolTab` (`agent-workspace-actions.ts:225-250`), labels
  `{ git: "Git" }`.
- Dropdown item `新建 Git` (`:326-344`) and empty-state button (`:346-380`).

Gate: `pnpm exec tsc --noEmit && pnpm lint`.

## Step 5 — Point the count button at the Git tab

File: `src/features/chat/agent-workspace-actions.ts` (`:170-173`).

`openGit` returns `{ id: "git", kind: "git", label: "Git" }`. 审阅 remains in the
new-tab menu.

Gate: `pnpm exec tsc --noEmit`.

## Step 6 — Full gates

```bash
pnpm test:unit
pnpm check
pnpm check:architecture
pnpm lint
pnpm format:check
```

`pnpm check` includes `check:pi-compatibility`, which re-validates every invoked
command against `src-tauri/permissions/default.toml:9-19`; the restored tab
invokes only already-allowlisted commands.

## Manual verification (`pnpm tauri dev`, `pnpm prepare:agent-worker` once)

1. Scratch repo: `mkdir /tmp/git-surface-check && cd $_ && git init -q && echo one > notes.txt`.
2. Open it as a project. Header count shows `1`.
3. Click the count button → Git tab opens (not 审阅).
4. 暂存 `notes.txt` → row flips to 取消暂存, toast 文件已暂存; `git status` shows
   the file staged; count stays `1`.
5. 取消暂存 → row flips back; `git status` shows `??`.
6. Stage again, type a message, 提交 → toast 提交已创建; review tab shows a clean
   tree; badge `0`; `git log -1` shows the message.
7. 分支: create `feature-check` → list marks it current; checkout `main` from the
   list → check mark moves.
8. 工作树: path `/tmp/git-surface-check-wt`, branch `wt-check`, 创建工作树 →
   row appears; 移除 with hold-to-confirm → row disappears; the cwd row shows no
   remove button.
9. Refresh after a turn: ask the agent to write `agent-note.txt`; when the turn
   settles, badge increments to `1` with no 刷新 press, and the Git tab lists the
   file.
10. Cancel path: start a turn that writes a file, cancel it → badge still
    refreshes.
11. Error path: create a branch named `bad name` → error banner shows
    product copy (no raw Rust string), no unhandled rejection in the console.

## Rollback

Revert the five edited files (`git restore <paths>`), delete
`src/features/git/git-workspace.tsx`. No data or schema changes; the Rust and
bridge layers were never touched, so a partial rollback leaves the app consistent
with today's review-only build.
