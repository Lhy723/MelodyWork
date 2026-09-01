import { invoke } from "@tauri-apps/api/core";

import type { GitBranch, GitChange, GitDiff, GitWorktree } from "@/domain/git";
import { PREVIEW_GIT_CHANGES, previewGitDiff } from "@/lib/preview-fixtures";
import { isTauriRuntime } from "./melody-bridge-runtime";

export const getGitChanges = async (cwd: string): Promise<GitChange[]> => {
  if (!isTauriRuntime()) {
    return PREVIEW_GIT_CHANGES.map((change) => ({ ...change }));
  }
  return invoke<GitChange[]>("git_changes", { cwd });
};

export const getGitDiff = async (
  cwd: string,
  path: string,
): Promise<GitDiff> => {
  if (!isTauriRuntime()) {
    return previewGitDiff(path);
  }
  return invoke<GitDiff>("git_diff", { cwd, path });
};

export const getGitBranches = async (cwd: string): Promise<GitBranch[]> =>
  isTauriRuntime()
    ? invoke<GitBranch[]>("git_branches", { cwd })
    : [
        { name: "main", current: true },
        { name: "feature/acp-bridge", current: false },
      ];

export const stageGitPaths = async (
  cwd: string,
  paths: string[],
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_stage", { cwd, paths });
  }
};

export const unstageGitPaths = async (
  cwd: string,
  paths: string[],
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_unstage", { cwd, paths });
  }
};

export const commitGitChanges = async (
  cwd: string,
  message: string,
): Promise<string> =>
  isTauriRuntime()
    ? invoke<string>("git_commit", { cwd, message })
    : `[main preview] ${message}`;

export const checkoutGitBranch = async (
  cwd: string,
  branch: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_checkout_branch", { cwd, branch });
  }
};

export const createGitBranch = async (
  cwd: string,
  branch: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_create_branch", { cwd, branch });
  }
};

export const getGitWorktrees = async (cwd: string): Promise<GitWorktree[]> =>
  isTauriRuntime()
    ? invoke<GitWorktree[]>("git_worktrees", { cwd })
    : [
        {
          path: cwd,
          branch: "main",
          head: "a1b2c3d",
          bare: false,
          detached: false,
        },
      ];

export const createGitWorktree = async (request: {
  cwd: string;
  path: string;
  branch: string;
  createBranch: boolean;
}): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_create_worktree", request);
  }
};

export const removeGitWorktree = async (
  cwd: string,
  path: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_remove_worktree", { cwd, path });
  }
};
