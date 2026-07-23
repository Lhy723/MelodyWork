export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: number;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  acpSessionId?: string;
  timelineJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateSessionRequest {
  id: string;
  title?: string;
  acpSessionId?: string;
  timelineJson?: string;
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
