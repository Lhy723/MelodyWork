export const INDEPENDENT_PROJECT_ID = "__melody_independent__";

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: number;
  archived: boolean;
  /** Reserved project whose root is managed by MelodyWork for isolated chats. */
  isIndependent?: boolean;
}

export interface ProjectDeleteResult {
  deleted: boolean;
  error?: string;
}

export const isIndependentProject = (project?: ProjectRecord) =>
  project?.isIndependent === true || project?.id === INDEPENDENT_PROJECT_ID;

/** Titles a session carries before the user gives it one. */
export const UNTITLED_SESSION_TITLES = ["New session", "新会话"] as const;

export const isUntitledSessionTitle = (title: string) => {
  const trimmed = title.trim();
  return trimmed === "" || UNTITLED_SESSION_TITLES.some((t) => t === trimmed);
};

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  acpSessionId?: string | null;
  timelineJson: string;
  acpCursor?: string | null;
  timelineVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateSessionRequest {
  id: string;
  title?: string;
  acpSessionId?: string;
  timelineJson?: string;
  timelineEntries?: TimelineArchiveEntry[];
  acpCursor?: string | null;
  timelineVersion?: number;
}

export interface TimelineArchiveEntry {
  ordinal: number;
  entryJson: string;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  depth: number;
}

export interface TerminalOutputEvent {
  terminalId: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface TerminalExitEvent {
  terminalId: string;
  code?: number;
}
