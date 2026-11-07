import {
  CheckIcon,
  CheckCircle2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TreesIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { HoldToConfirm } from "@/components/interior/hold-to-confirm";
import { useGlobalLiveActivity } from "@/components/interior/live-activity";
import { LoadingButton } from "@/components/interior/loading-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toUserMessage as messageFrom } from "@/domain/app-error";
import type { GitBranch, GitChange, GitWorktree } from "@/domain/git";
import {
  checkoutGitBranch,
  commitGitChanges,
  createGitBranch,
  createGitWorktree,
  getGitBranches,
  getGitWorktrees,
  removeGitWorktree,
  stageGitPaths,
  unstageGitPaths,
} from "@/lib/melody-bridge";

const alertClass =
  "motion-view-enter rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-destructive text-sm";
const noticeClass =
  "motion-success rounded-xl border bg-muted/40 px-3 py-2.5 text-sm";

interface GitWorkspaceProps {
  changes: GitChange[];
  cwd: string;
  error?: string;
  loading: boolean;
  onRefreshChanges: () => void | Promise<void>;
}

/**
 * Mutating Git surface for the workspace panel: stage/unstage, commit, branch
 * checkout/creation and worktree management. `changes` is owned by
 * `useGitChanges` so the badge and this tab never drift; branch and worktree
 * data are local because nothing else displays them.
 */
export function GitWorkspace({
  changes,
  cwd,
  error,
  loading,
  onRefreshChanges,
}: GitWorkspaceProps) {
  const {
    fail: failActivity,
    start: startActivity,
    succeed: succeedActivity,
  } = useGlobalLiveActivity();
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [refreshing, setRefreshing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pendingRemoval, setPendingRemoval] = useState<string>();
  const commitButtonRef = useRef<HTMLButtonElement>(null);
  const branchButtonRef = useRef<HTMLButtonElement>(null);
  const worktreeButtonRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(
    async (announce = false) => {
      if (announce) {
        startActivity({
          detail: "正在读取分支和工作树…",
          title: "刷新 Git",
        });
      }
      setRefreshing(true);
      setLocalError(undefined);
      try {
        const [nextBranches, nextWorktrees] = await Promise.all([
          getGitBranches(cwd),
          getGitWorktrees(cwd),
        ]);
        setBranches(nextBranches);
        setWorktrees(nextWorktrees);
        setWorktreeBranch(
          (current) =>
            current ||
            nextBranches.find((branch) => branch.current)?.name ||
            "main",
        );
        if (announce) {
          succeedActivity({
            detail: `已读取 ${nextBranches.length} 个分支和 ${nextWorktrees.length} 个工作树。`,
            title: "Git 已刷新",
          });
        }
      } catch (reason) {
        const message = messageFrom(reason);
        setLocalError(message);
        if (announce) {
          failActivity(
            { detail: message, title: "Git 刷新失败" },
            {
              label: "重试",
              onClick: () => {
                void refresh(true).catch(() => undefined);
              },
            },
          );
        }
      } finally {
        setRefreshing(false);
      }
    },
    [cwd, failActivity, startActivity, succeedActivity],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (
    action: () => Promise<void>,
    success: string,
    propagateError = false,
    activityTitle = "Git 操作",
  ) => {
    startActivity({
      detail: "正在执行 Git 操作…",
      title: activityTitle,
    });
    setBusy(true);
    setLocalError(undefined);
    setNotice(undefined);
    try {
      await action();
      setNotice(success);
      await Promise.all([refresh(), Promise.resolve(onRefreshChanges())]);
      succeedActivity({ detail: success, title: `${activityTitle}完成` });
    } catch (reason) {
      const message = messageFrom(reason);
      setLocalError(message);
      failActivity(
        { detail: message, title: `${activityTitle}失败` },
        {
          label: "重试",
          onClick: () => {
            void runAction(
              action,
              success,
              propagateError,
              activityTitle,
            ).catch(() => undefined);
          },
        },
      );
      if (propagateError) {
        throw reason;
      }
    } finally {
      setBusy(false);
    }
  };

  const stagedCount = changes.filter((change) => change.staged).length;
  const visibleError = error ?? localError;

  return (
    <section className="flex size-full min-h-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-sm">Git</h2>
          <p className="truncate text-muted-foreground text-xs">{cwd}</p>
        </div>
        <LoadingButton
          aria-label="刷新 Git"
          className="shrink-0"
          disabled={loading || refreshing || busy}
          errorLabel="重试"
          icon={<RefreshCwIcon />}
          iconOnly
          onAction={() =>
            Promise.all([refresh(true), Promise.resolve(onRefreshChanges())])
          }
          pendingLabel="刷新中…"
          successLabel="已刷新"
          variant="ghost"
        >
          刷新 Git
        </LoadingButton>
      </header>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
        <div className="grid min-w-0 grid-cols-1 gap-3">
          {visibleError ? (
            <p aria-live="assertive" className={alertClass} role="alert">
              {visibleError}
            </p>
          ) : null}
          {notice ? (
            <p aria-live="polite" className={noticeClass}>
              {notice}
            </p>
          ) : null}

          <section className="min-w-0 rounded-xl border">
            <div className="flex items-center gap-2 border-b px-3 py-2.5">
              <GitCommitHorizontalIcon className="size-4 shrink-0 text-muted-foreground" />
              <h3 className="font-medium text-sm">更改</h3>
              <span className="ml-auto text-muted-foreground text-xs">
                {loading
                  ? "读取中…"
                  : `已暂存 ${stagedCount} / ${changes.length}`}
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto p-1.5">
              {changes.map((change, index) => (
                <div
                  className="motion-list-item flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-sm"
                  key={change.path}
                  style={{ animationDelay: `${Math.min(index, 6) * 24}ms` }}
                >
                  <span className="min-w-0 flex-1 truncate">{change.path}</span>
                  <span className="shrink-0 text-emerald-700 text-xs">
                    +{change.additions}
                  </span>
                  <span className="shrink-0 text-red-700 text-xs">
                    −{change.deletions}
                  </span>
                  <LoadingButton
                    disabled={busy}
                    errorLabel="重试"
                    onAction={() =>
                      runAction(
                        () =>
                          change.staged
                            ? unstageGitPaths(cwd, [change.path])
                            : stageGitPaths(cwd, [change.path]),
                        change.staged ? "文件已取消暂存。" : "文件已暂存。",
                        true,
                        change.staged ? "取消暂存文件" : "暂存文件",
                      )
                    }
                    className="shrink-0"
                    pendingLabel={change.staged ? "取消中…" : "暂存中…"}
                    size="sm"
                    successLabel={change.staged ? "已取消" : "已暂存"}
                    variant={change.staged ? "secondary" : "outline"}
                  >
                    {change.staged ? "取消暂存" : "暂存"}
                  </LoadingButton>
                </div>
              ))}
              {loading && changes.length === 0 ? (
                <p className="px-2 py-6 text-center text-muted-foreground text-xs">
                  正在读取更改…
                </p>
              ) : null}
              {!loading && changes.length === 0 ? (
                <div className="motion-view-enter flex flex-col items-center gap-1 px-2 py-8 text-center">
                  <CheckCircle2Icon
                    aria-hidden="true"
                    className="mb-1 size-5 text-emerald-600"
                  />
                  <p className="text-sm">工作树是干净的。</p>
                  <p className="text-muted-foreground text-xs">
                    可以开始下一步了。
                  </p>
                </div>
              ) : null}
            </div>
            <form
              className="flex min-w-0 gap-2 border-t p-2.5"
              onSubmit={(event) => {
                event.preventDefault();
                commitButtonRef.current?.click();
              }}
            >
              <Input
                aria-label="提交说明"
                className="min-w-0 flex-1"
                disabled={busy}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="提交说明"
                value={commitMessage}
              />
              <LoadingButton
                className="shrink-0"
                disabled={busy || stagedCount === 0 || !commitMessage.trim()}
                errorLabel="重试"
                onAction={() =>
                  runAction(
                    async () => {
                      await commitGitChanges(cwd, commitMessage);
                      setCommitMessage("");
                    },
                    "提交已创建。",
                    true,
                    "创建提交",
                  )
                }
                pendingLabel="提交中…"
                ref={commitButtonRef}
                successLabel="已提交"
              >
                提交
              </LoadingButton>
            </form>
          </section>

          <section className="min-w-0 rounded-xl border">
            <div className="flex items-center gap-2 border-b px-3 py-2.5">
              <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
              <h3 className="font-medium text-sm">分支</h3>
              <span className="ml-auto text-muted-foreground text-xs">
                {branches.length}
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto p-1.5">
              {branches.map((branch) => (
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted/60 disabled:pointer-events-none"
                  disabled={busy || branch.current}
                  key={branch.name}
                  onClick={() =>
                    void runAction(
                      () => checkoutGitBranch(cwd, branch.name),
                      `已切换到 ${branch.name}。`,
                      false,
                      "切换 Git 分支",
                    )
                  }
                  type="button"
                >
                  <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.current ? (
                    <CheckIcon aria-label="当前分支" className="size-4" />
                  ) : null}
                </button>
              ))}
              {refreshing && branches.length === 0 ? (
                <p className="px-2 py-4 text-center text-muted-foreground text-xs">
                  正在读取分支…
                </p>
              ) : null}
            </div>
            <form
              className="flex min-w-0 gap-2 border-t p-2.5"
              onSubmit={(event) => {
                event.preventDefault();
                branchButtonRef.current?.click();
              }}
            >
              <Input
                aria-label="新分支名称"
                className="min-w-0 flex-1"
                disabled={busy}
                onChange={(event) => setNewBranch(event.target.value)}
                placeholder="新分支"
                value={newBranch}
              />
              <LoadingButton
                className="shrink-0"
                disabled={busy || !newBranch.trim()}
                errorLabel="重试"
                icon={<PlusIcon />}
                onAction={() => {
                  const branchName = newBranch;
                  return runAction(
                    async () => {
                      await createGitBranch(cwd, branchName);
                      setNewBranch("");
                    },
                    `已创建 ${branchName}。`,
                    true,
                    "创建 Git 分支",
                  );
                }}
                pendingLabel="创建中…"
                ref={branchButtonRef}
                successLabel="已创建"
              >
                创建
              </LoadingButton>
            </form>
          </section>

          <section className="min-w-0 rounded-xl border">
            <div className="flex items-center gap-2 border-b px-3 py-2.5">
              <TreesIcon className="size-4 shrink-0 text-muted-foreground" />
              <h3 className="font-medium text-sm">工作树</h3>
              <span className="ml-auto text-muted-foreground text-xs">
                {worktrees.length}
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto p-1.5">
              {worktrees.map((worktree, index) => (
                <div
                  className="motion-list-item flex items-center gap-2 rounded-lg px-2 py-2.5"
                  key={worktree.path}
                  style={{ animationDelay: `${Math.min(index, 6) * 24}ms` }}
                >
                  <TreesIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {worktree.branch ?? "分离的 HEAD"}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {worktree.path}
                    </span>
                  </span>
                  {worktree.path !== cwd ? (
                    pendingRemoval === worktree.path ? (
                      <HoldToConfirm
                        aria-label={`确认移除 ${worktree.path}`}
                        confirmLabel={busy ? "移除中…" : "已移除"}
                        disabled={busy}
                        onConfirm={() =>
                          runAction(
                            () => removeGitWorktree(cwd, worktree.path),
                            "工作树已移除。",
                            true,
                            "移除工作树",
                          ).then(() => setPendingRemoval(undefined))
                        }
                        size="sm"
                        variant="destructive"
                      >
                        <Trash2Icon />
                        确认移除
                      </HoldToConfirm>
                    ) : (
                      <Button
                        aria-label={`移除 ${worktree.path}`}
                        disabled={busy}
                        onClick={() => setPendingRemoval(worktree.path)}
                        size="icon"
                        variant="ghost"
                      >
                        <Trash2Icon />
                      </Button>
                    )
                  ) : null}
                </div>
              ))}
              {refreshing && worktrees.length === 0 ? (
                <p className="px-2 py-4 text-center text-muted-foreground text-xs">
                  正在读取工作树…
                </p>
              ) : null}
            </div>
            <form
              className="grid min-w-0 gap-2 border-t p-2.5"
              onSubmit={(event) => {
                event.preventDefault();
                worktreeButtonRef.current?.click();
              }}
            >
              <Input
                aria-label="工作树路径"
                className="min-w-0"
                disabled={busy}
                onChange={(event) => setWorktreePath(event.target.value)}
                placeholder="工作树目录"
                value={worktreePath}
              />
              <div className="flex min-w-0 gap-2">
                <Input
                  aria-label="工作树分支"
                  className="min-w-0 flex-1"
                  disabled={busy}
                  onChange={(event) => setWorktreeBranch(event.target.value)}
                  placeholder="新分支"
                  value={worktreeBranch}
                />
                <LoadingButton
                  className="shrink-0"
                  disabled={
                    busy || !worktreePath.trim() || !worktreeBranch.trim()
                  }
                  errorLabel="重试"
                  onAction={() => {
                    const path = worktreePath;
                    const branch = worktreeBranch;
                    return runAction(
                      async () => {
                        await createGitWorktree({
                          cwd,
                          path,
                          branch,
                          createBranch: true,
                        });
                        setWorktreePath("");
                        setWorktreeBranch("");
                      },
                      "工作树已创建。",
                      true,
                      "创建工作树",
                    );
                  }}
                  pendingLabel="创建中…"
                  ref={worktreeButtonRef}
                  successLabel="已创建"
                >
                  创建工作树
                </LoadingButton>
              </div>
            </form>
          </section>
        </div>
      </div>
    </section>
  );
}
