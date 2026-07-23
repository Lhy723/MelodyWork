export interface GitChange {
  path: string;
  status: string;
  staged: boolean;
  additions: number;
  deletions: number;
}

export interface GitDiff {
  path: string;
  content: string;
  binary: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitWorktree {
  path: string;
  branch?: string;
  head?: string;
  bare: boolean;
  detached: boolean;
}
