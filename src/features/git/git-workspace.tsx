import {
  CheckIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TreesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

const messageFrom = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

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

  const refresh = async () => {
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
  };

  useEffect(() => {
    void refresh();
  }, [cwd]);

  const runAction = async (
    action: () => Promise<void>,
    success: string,
  ) => {
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
          aria-label="Refresh Git"
          disabled={loading || busy}
          onClick={() => void refresh()}
          size="icon"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        <Button
          aria-label="Close Git"
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
            <p className="col-span-full rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive text-sm">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="col-span-full rounded-xl border bg-muted/40 px-4 py-3 text-sm">
              {notice}
            </p>
          ) : null}

          <section className="rounded-2xl border">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <GitCommitHorizontalIcon className="size-4 text-muted-foreground" />
              <h3 className="font-medium text-sm">Changes</h3>
              <span className="ml-auto text-muted-foreground text-xs">
                {changes.length}
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto p-2">
              {changes.map((change) => (
                <div
                  className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm"
                  key={change.path}
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
                        change.staged ? "File unstaged." : "File staged.",
                      )
                    }
                    size="sm"
                    variant={change.staged ? "secondary" : "outline"}
                  >
                    {change.staged ? "Unstage" : "Stage"}
                  </Button>
                </div>
              ))}
              {changes.length === 0 ? (
                <p className="px-3 py-8 text-center text-muted-foreground text-sm">
                  Working tree is clean.
                </p>
              ) : null}
            </div>
            <form
              className="flex gap-2 border-t p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction(
                  async () => {
                    await commitGitChanges(cwd, commitMessage);
                    setCommitMessage("");
                  },
                  "Commit created.",
                );
              }}
            >
              <Input
                aria-label="Commit message"
                disabled={busy}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Commit message"
                value={commitMessage}
              />
              <Button
                disabled={busy || stagedCount === 0 || !commitMessage.trim()}
                type="submit"
              >
                Commit
              </Button>
            </form>
          </section>

          <section className="rounded-2xl border">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <GitBranchIcon className="size-4 text-muted-foreground" />
              <h3 className="font-medium text-sm">Branches</h3>
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
                      `Checked out ${branch.name}.`,
                    )
                  }
                  type="button"
                >
                  <GitBranchIcon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.current ? (
                    <CheckIcon className="size-4" />
                  ) : null}
                </button>
              ))}
            </div>
            <form
              className="flex gap-2 border-t p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction(
                  async () => {
                    await createGitBranch(cwd, newBranch);
                    setNewBranch("");
                  },
                  `Created ${newBranch}.`,
                );
              }}
            >
              <Input
                aria-label="New branch name"
                disabled={busy}
                onChange={(event) => setNewBranch(event.target.value)}
                placeholder="New branch"
                value={newBranch}
              />
              <Button disabled={busy || !newBranch.trim()} type="submit">
                <PlusIcon />
                Create
              </Button>
            </form>
          </section>

          <section className="rounded-2xl border lg:col-span-2">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <TreesIcon className="size-4 text-muted-foreground" />
              <h3 className="font-medium text-sm">Worktrees</h3>
            </div>
            <div className="grid gap-2 p-2 md:grid-cols-2">
              {worktrees.map((worktree) => (
                <div
                  className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-muted/40"
                  key={worktree.path}
                >
                  <TreesIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {worktree.branch ?? "Detached HEAD"}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {worktree.path}
                    </span>
                  </span>
                  {worktree.path !== cwd ? (
                    <Button
                      aria-label={`Remove ${worktree.path}`}
                      disabled={busy}
                      onClick={() => {
                        if (pendingRemoval !== worktree.path) {
                          setPendingRemoval(worktree.path);
                          return;
                        }
                        setPendingRemoval(undefined);
                        void runAction(
                          () => removeGitWorktree(cwd, worktree.path),
                          "Worktree removed.",
                        );
                      }}
                      size={
                        pendingRemoval === worktree.path ? "sm" : "icon"
                      }
                      variant={
                        pendingRemoval === worktree.path
                          ? "destructive"
                          : "ghost"
                      }
                    >
                      <Trash2Icon />
                      {pendingRemoval === worktree.path
                        ? "Confirm remove"
                        : null}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            <form
              className="grid gap-2 border-t p-3 md:grid-cols-[1fr_1fr_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction(
                  async () => {
                    await createGitWorktree({
                      cwd,
                      path: worktreePath,
                      branch: worktreeBranch,
                      createBranch: true,
                    });
                    setWorktreePath("");
                    setWorktreeBranch("");
                  },
                  "Worktree created.",
                );
              }}
            >
              <Input
                aria-label="Worktree path"
                disabled={busy}
                onChange={(event) => setWorktreePath(event.target.value)}
                placeholder="Worktree directory"
                value={worktreePath}
              />
              <Input
                aria-label="Worktree branch"
                disabled={busy}
                onChange={(event) => setWorktreeBranch(event.target.value)}
                placeholder="New branch"
                value={worktreeBranch}
              />
              <Button
                disabled={
                  busy || !worktreePath.trim() || !worktreeBranch.trim()
                }
                type="submit"
              >
                Create worktree
              </Button>
            </form>
          </section>
        </div>
      </div>
    </section>
  );
}
