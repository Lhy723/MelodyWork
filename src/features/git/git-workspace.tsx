import {
  CheckIcon,
  CheckCircle2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TreesIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
import { cn } from "@/lib/utils";

interface GitWorkspaceProps {
  changes: GitChange[];
  cwd: string;
  onClose: () => void;
  onRefreshChanges: () => void;
}

export function GitWorkspace({
  changes,
  cwd,
  onClose,
  onRefreshChanges,
}: GitWorkspaceProps) {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pendingRemoval, setPendingRemoval] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
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
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      setNotice(success);
      await Promise.all([refresh(), Promise.resolve(onRefreshChanges())]);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  };

  const stagedCount = changes.filter((change) => change.staged).length;

  return (
    <section className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-6">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-base">Git</h2>
          <p className="truncate text-muted-foreground text-xs">{cwd}</p>
        </div>
        <Button
          aria-label="刷新 Git"
          disabled={loading || busy}
          onClick={() => void refresh()}
          size="icon"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        <Button
          aria-label="关闭 Git"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-2">
          {error ? (
            <p
              aria-live="assertive"
              className="motion-view-enter col-span-full rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive text-sm"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="motion-success col-span-full rounded-xl border bg-muted/40 px-4 py-3 text-sm">
              {notice}
            </p>
          ) : null}

          <section className="rounded-2xl border">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <GitCommitHorizontalIcon className="size-4 text-muted-foreground" />
              <h3 className="font-medium text-sm">更改</h3>
              <span className="ml-auto text-muted-foreground text-xs">
                {changes.length}
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto p-2">
              {changes.map((change, index) => (
                <div
                  className="motion-list-item flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm"
                  key={change.path}
                  style={{ animationDelay: `${Math.min(index, 6) * 24}ms` }}
                >
                  <span className="min-w-0 flex-1 truncate">{change.path}</span>
                  <span className="text-emerald-700 text-xs">
                    +{change.additions}
                  </span>
                  <span className="text-red-700 text-xs">
                    −{change.deletions}
                  </span>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void runAction(
                        () =>
                          change.staged
                            ? unstageGitPaths(cwd, [change.path])
                            : stageGitPaths(cwd, [change.path]),
                        change.staged ? "文件已取消暂存。" : "文件已暂存。",
                      )
                    }
                    size="sm"
                    variant={change.staged ? "secondary" : "outline"}
                  >
                    {change.staged ? "取消暂存" : "暂存"}
                  </Button>
                </div>
              ))}
              {changes.length === 0 ? (
                <div className="motion-view-enter flex flex-col items-center gap-1 px-3 py-8 text-center">
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
              className="flex gap-2 border-t p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction(async () => {
                  await commitGitChanges(cwd, commitMessage);
                  setCommitMessage("");
                }, "提交已创建。");
              }}
            >
              <Input
                aria-label="提交说明"
                disabled={busy}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="提交说明"
                value={commitMessage}
              />
              <Button
                disabled={busy || stagedCount === 0 || !commitMessage.trim()}
                type="submit"
              >
                提交
              </Button>
            </form>
          </section>

          <section className="rounded-2xl border">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <GitBranchIcon className="size-4 text-muted-foreground" />
              <h3 className="font-medium text-sm">分支</h3>
            </div>
            <div className="max-h-72 overflow-y-auto p-2">
              {branches.map((branch) => (
                <button
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted/60 disabled:pointer-events-none"
                  disabled={busy || branch.current}
                  key={branch.name}
                  onClick={() =>
                    void runAction(
                      () => checkoutGitBranch(cwd, branch.name),
                      `已切换到 ${branch.name}。`,
                    )
                  }
                  type="button"
                >
                  <GitBranchIcon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.current ? <CheckIcon className="size-4" /> : null}
                </button>
              ))}
            </div>
            <form
              className="flex gap-2 border-t p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction(async () => {
                  await createGitBranch(cwd, newBranch);
                  setNewBranch("");
                }, `已创建 ${newBranch}。`);
              }}
            >
              <Input
                aria-label="新分支名称"
                disabled={busy}
                onChange={(event) => setNewBranch(event.target.value)}
                placeholder="新分支"
                value={newBranch}
              />
              <Button disabled={busy || !newBranch.trim()} type="submit">
                <PlusIcon />
                创建
              </Button>
            </form>
          </section>

          <section className="rounded-2xl border lg:col-span-2">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <TreesIcon className="size-4 text-muted-foreground" />
              <h3 className="font-medium text-sm">工作树</h3>
            </div>
            <div className="grid gap-2 p-2 md:grid-cols-2">
              {worktrees.map((worktree, index) => (
                <div
                  className="motion-list-item flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted/40"
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
                    <Button
                      aria-label={`移除 ${worktree.path}`}
                      disabled={busy}
                      onClick={() => {
                        if (pendingRemoval !== worktree.path) {
                          setPendingRemoval(worktree.path);
                          return;
                        }
                        setPendingRemoval(undefined);
                        void runAction(
                          () => removeGitWorktree(cwd, worktree.path),
                          "工作树已移除。",
                        );
                      }}
                      size={pendingRemoval === worktree.path ? "sm" : "icon"}
                      variant={
                        pendingRemoval === worktree.path
                          ? "destructive"
                          : "ghost"
                      }
                    >
                      <Trash2Icon />
                      {pendingRemoval === worktree.path ? (
                        <span className="motion-view-enter">确认移除</span>
                      ) : null}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            <form
              className="grid gap-2 border-t p-3 md:grid-cols-[1fr_1fr_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction(async () => {
                  await createGitWorktree({
                    cwd,
                    path: worktreePath,
                    branch: worktreeBranch,
                    createBranch: true,
                  });
                  setWorktreePath("");
                  setWorktreeBranch("");
                }, "工作树已创建。");
              }}
            >
              <Input
                aria-label="工作树路径"
                disabled={busy}
                onChange={(event) => setWorktreePath(event.target.value)}
                placeholder="工作树目录"
                value={worktreePath}
              />
              <Input
                aria-label="工作树分支"
                disabled={busy}
                onChange={(event) => setWorktreeBranch(event.target.value)}
                placeholder="新分支"
                value={worktreeBranch}
              />
              <Button
                disabled={
                  busy || !worktreePath.trim() || !worktreeBranch.trim()
                }
                type="submit"
              >
                创建工作树
              </Button>
            </form>
          </section>
        </div>
      </div>
    </section>
  );
}
