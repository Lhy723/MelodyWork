# Native acceptance — Git workspace tab

## Environment

- macOS 27.2 (darwin/arm64), MelodyWork `beta` at `d1c5fe11`.
- Desktop automation: Tern (`so.stencil.tern`) with Screen Recording, Input and
  Accessibility granted (`capturePermission`, `inputPermission`,
  `axPermission` = granted, 2 displays).
- App: `pnpm tauri dev` (dev build `target/debug/melody-work`), webview served by
  the Tauri dev Vite server; window 1280x821 at screen (320,146).
- Scratch repo: `/tmp/git-surface-check`, `git init -b main`, one commit.
  Because the prep committed `notes.txt`, it was untracked once with
  `git rm --cached notes.txt` + commit `untrack notes` so the script's
  untracked expectation held.
- A fresh child process ran the UI steps because the primary desktop session
  had been closed by an earlier `computer.close()`; all actions stayed on the
  scratch project.

## Per-step results

| Step | Result | Evidence |
| --- | --- | --- |
| 1 add scratch project | PASS `/tmp/git-native/01-project-added.png` | Sidebar showed `git-surface-check`; added through the task-screen project popup → 添加项目目录… → NSOpenPanel (`/tmp/git-surface-check`) |
| 2 enter a task | PASS `/tmp/git-native/02-session-with-git-tab.png` | Git header showed `/private/tmp/git-surface-check`; no prompt required |
| 3 count button opens Git, menu has 新建 Git | PASS `/tmp/git-native/03-count-button-opens-git.png`, `/tmp/git-native/03b-new-tab-menu.png` | Closed Git tab → pressed `0 项更改` → tab strip returned with `Git`; menu listed 新建终端/文件/审阅/Git/浏览器 |
| 4 stage `notes.txt` | PASS `/tmp/git-native/04b-staged.png` | Row flipped to 取消暂存, `已暂存 1 / 1`, notice 文件已暂存。; `git -C /tmp/git-surface-check status --porcelain` → `A  notes.txt` |
| 5 unstage | PASS `/tmp/git-native/05-unstaged.png` | `git -C /tmp/git-surface-check status --porcelain` → `?? notes.txt` |
| 6 commit | PASS `/tmp/git-native/06b-committed.png` | Message `qa: native check`; `git log -1 --format=%s` → `qa: native check`; list 工作树是干净的, badge `0 项更改` |
| 7 branch create + checkout | PARTIAL before fix, PASS after | Pre-fix create PASS (`/tmp/git-native/07-branch-created.png`; `git branch` → `* feature-check`, `main`) but checkout failed (`/tmp/git-native/07b-checkout-failed.png`; banner `error: pathspec 'main' did not match any file(s) known to git`). After `d1c5fe11`: create → `* feature-check`, click `main` → toast 已切换到 main。, no banner, `git branch --show-current` → `main` (`/tmp/git-native/07d-checkout-fixed.png`) |
| 8 worktree create + remove | PASS | Create wt-check: `git worktree list` showed `/private/tmp/git-surface-check-wt cb4108a [wt-check]` (`/tmp/git-native/08-worktree-created.png`); removed (`/tmp/git-native/08b-worktree-removed.png`). Re-check with wt2: `/tmp/git-native/08-worktree-created-wt2.png`, removal `/tmp/git-native/08c-worktree-hold.png`; `git worktree list` → only `[main]`, `-wt2` directory gone |
| 9 invalid branch copy | FAIL before fix, PASS after | Pre-fix banner was raw `fatal: 'bad name' is not a valid branch name` (`/tmp/git-native/09-invalid-branch-error.png`). After `d1c5fe11`: 分支名「bad name」不合法。请避免空格、~ ^ : ? * [ \ 等字符，且不要以 - 或 / 开头或结尾。 — no `fatal:`, no branch created (`/tmp/git-native/09b-invalid-branch-copy.png`) |
| 10 turn-settle refresh | PASS | Sent `hi` (deepseek-v4-flash), appended `two` to `notes.txt` while running (`git status` → ` M notes.txt`), badge stayed `0 项更改` (`/tmp/git-native/10a-mid-turn-badge-0.png`), then became `1 项更改` at settle without 刷新 (`/tmp/git-native/10-turn-settle-badge-1.png`) |

Worktree removal is two-stage by design: the trash button first arms
`确认移除`, then one ~1.5 s `HoldToConfirm` removes it. After arming, a single
hold sufficed; only one attempt was needed in the fixed-build re-check.

## Defects found and fixes

1. **Branch checkout never worked.** `git_checkout_branch` ran
   `git checkout -- <branch>`, so Git parsed the branch as a pathspec.
   Fixed by running `checkout <branch>` after validation, by resolving
   `checkout_branch_at` / `create_branch_at`, and by checking existence with
   `rev-parse --verify --quiet refs/heads/<branch>`.
2. **Raw `fatal:` branch-name stderr reached the UI.** `validate_branch_name`
   now trims, rejects empty and leading `-`, and maps `check-ref-format`
   failures to bounded Chinese copy; create/checkout failures are prefixed with
   无法创建/无法切换 context instead of raw stderr.

Both fixed in `d1c5fe11` (3 files, +180/−23) with four new tests:
`rejects_invalid_branch_names_with_product_copy`,
`rejects_branch_names_that_look_like_options`,
`checkout_switches_head_to_an_existing_branch`,
`checkout_missing_branch_returns_not_found_copy`.

## Not verified

- DevTools console during step 9: the app exposes no readable console to the
  automation harness. No crash, hang, or unhandled-rejection banner was observed,
  and the app kept responding, but console cleanliness is unverified.

## Open observation (known a11y defect, not part of this task)

`src/components/interior/live-activity.tsx:244-249` builds the screen-reader
announcement as `` `${activity.title}已完成。` `` / `` `${activity.title}失败。` ``.
Git workspace callers already end the title with the state at
`src/features/git/git-workspace.tsx:149` (`` title: `${activityTitle}完成` ``) and
`:154` (`` title: `${activityTitle}失败` ``), so the announcement reads
`创建 Git 分支失败失败。` / `移除工作树完成已完成。`. The visible toast body and
the inline banner carry the correct single message; only the spoken text is
duplicated.
