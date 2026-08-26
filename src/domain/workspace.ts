export const INDEPENDENT_PROJECT_ID = "__melody_independent__";

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: number;
  /** Reserved project whose root is managed by MelodyWork for isolated chats. */
  isIndependent?: boolean;
}

export const isIndependentProject = (project?: ProjectRecord) =>
  project?.isIndependent === true || project?.id === INDEPENDENT_PROJECT_ID;

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  acpSessionId?: string;
  timelineJson: string;
  acpCursor?: string;
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
