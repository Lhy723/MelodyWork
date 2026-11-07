# Design — Option A: Git tab in the workspace panel

## Decision and placement

Restore the recovered Git workspace as a workspace-panel tab (`kind: "git"`),
with no Rust or bridge changes. `changes` stays owned by `useGitChanges`; the
tab owns branch/worktree/commit state locally. Staleness is fixed by refreshing
`useGitChanges` when an agent turn settles, independent of which tab is open. A
new tab kind, not a dedicated panel or overlay: the host already provides tab
switching, lazy mounting, visited-tab persistence, keyboard handling and resize
(`workspace-side-panel.tsx:79-101,245-476`). The recovered `absolute inset-0
z-20` chrome is replaced by the embedded pattern used by
`file-workspace.tsx:318,324` and `change-review.tsx:253`.

审阅 keeps its tree + diff role; the Git tab is the mutating surface. The two
lists overlap by design (staging queue vs diff inspector). They are not merged
because `ChangeReview`'s tree is diff-oriented while the recovered staging list is
flat and per-file actionable.

## Wiring path (exact)

```
useGitChanges(cwd, { revision })             src/hooks/use-git-changes.ts
  └ agent-workspace.tsx:251  git = useGitChanges(...)
    └ AgentWorkspaceView props git={git}     agent-workspace.tsx:512
      └ session-workspace-content.tsx:458-487  WorkspacePanelLayer
        └ workspace-panel-layer.tsx:78-97      WorkspaceSidePanel
          └ workspace-side-panel.tsx:427-435   tab render switch
```

```ts
interface GitWorkspaceProps {
  changes: GitChange[];
  cwd: string;
  error?: string;
  loading: boolean;   // change-list loading (hook), not branch refresh
  onRefreshChanges: () => void | Promise<void>;
}
```

`onClose` is dropped; the tab host closes tabs (`workspace-side-panel.tsx:302-311`).
`onNewTab`'s kind union gains `"git"` in four places:
`workspace-side-panel.tsx:111`, `workspace-panel-layer.tsx:24`,
`agent-workspace-view-types.ts:117`, `agent-workspace-actions.ts:225-250`.
`tabIcon` gains `GitCommitHorizontalIcon` (`:128-156`); add a dropdown item
(`:326-344`) and an empty-state button beside 审阅 (`:346-380`).

`openGit` (`agent-workspace-actions.ts:170-173`) opens the Git tab instead of
review: the header control is a change-count button
(`session-workspace-content.tsx:156-172`) and before `7ae469b1` it opened the
staging surface. 审阅 stays reachable from the new-tab menu.

## State ownership

| State | Owner | Why |
| --- | --- | --- |
| `changes`, `loading`, `error` | `useGitChanges` | One `git_status` read feeds badge, review tab and Git tab; a second copy drifts |
| `stagedCount` | derived from `changes` | `staged` already comes from `git_runtime.rs:231` |
| `branches`, `worktrees` | local to `GitWorkspace` | Only the Git tab needs them; fetched on mount |
| `commitMessage`, inputs | local to `GitWorkspace` | Tab editor state |
| `busy`, `notice`, `pendingRemoval` | local to `GitWorkspace` | Per-action feedback kept from `runAction` (`git-workspace.tsx:124-176`) |
| `revision` | `agent-workspace.tsx` | Turn signal lives there (`chatStatus`, `:84`) |

Rename the component's own `loading` to `refreshing` so it cannot be confused
with hook loading.

## Refresh consistency after agent turns

Both pieces live in the hook so every consumer benefits:

1. `useGitChanges(cwd, { revision = 0 })` keeps a `useRef` of the applied
   revision and calls `refresh()` when it changes, skipping the initial mount
   (the existing effect at `use-git-changes.ts:24-26` already fetches).
2. Wrap the fetch in `RequestGate` (`src/domain/request-gate.ts:5-23`; the
   panel-sequencing rule in `.trellis/spec/frontend/conventions.md:142-151`) so a
   manual 刷新 racing an automatic refresh cannot apply a stale result.

`agent-workspace.tsx` derives the revision from the selected `chatStatus`:

```tsx
const [gitRefreshRevision, setGitRefreshRevision] = useState(0);
const previousChatStatus = useRef(chatStatus);
useEffect(() => {
  const wasRunning =
    previousChatStatus.current === "submitted" ||
    previousChatStatus.current === "streaming";
  previousChatStatus.current = chatStatus;
  if (wasRunning && (chatStatus === "ready" || chatStatus === "error")) {
    setGitRefreshRevision((current) => current + 1);
  }
}, [chatStatus]);
```

`chatStatus` settles on `turn.completed` (`agent-store-receive.ts:369-376`) and on
cancel (`agent-store.ts:171`); refreshing after cancel is right because a
cancelled turn can still have written files. Model/mode responses also set
`ready` (`agent-store-receive-requests.ts:202,231,328`) but never leave a running
state, so they do not bump the revision. No store change; one `git status` per
settled turn, and `RequestGate` absorbs overlaps.

## Component adaptation checklist

- Root `size-full`, header `h-12`, no close button; keep 刷新 Git.
- Single column (panel is 360-960px; `lg:grid-cols-2` is viewport-based): 更改+提交, 分支, 工作树.
- `runAction` keeps `Promise.all([refresh(), onRefreshChanges()])` so mutations
  update both branch/worktree data and the shared change list.
- Keep `useGlobalLiveActivity` (`live-activity.tsx:577`), `HoldToConfirm`
  (`hold-to-confirm.tsx:20`) and `toUserMessage` error copy.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Two change lists confuse users | Distinct labels; count button opens Git |
| Stale staging state after a mutation | `onRefreshChanges` after every mutation; turn-settle refresh (only settled transitions bump the revision) |
| Reintroduced dead code | Copy only what the tab consumes; no recovery-only helpers |

## Out of scope

Rust/bridge edits, hunk staging, diff inside the Git tab, cross-tab selection, branch delete/merge, worktree open-in-new-window, agent tool exposure.
