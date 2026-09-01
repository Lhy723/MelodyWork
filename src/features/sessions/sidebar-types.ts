import type { ProjectRecord, SessionRecord } from "@/domain/workspace";

export type WorkspaceMode = "work" | "research";
export type ResearchSection =
  | "overview"
  | "knowledge"
  | "library"
  | "experiments"
  | "sandbox"
  | "search"
  | "tracking"
  | "inbox"
  | "skills"
  | "capabilities";

export interface SidebarProjectEntry {
  project: ProjectRecord;
  sessions: SessionRecord[];
}
