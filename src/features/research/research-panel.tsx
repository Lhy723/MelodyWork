import { KnowledgePanel } from "./research-knowledge-panel";
import { LibraryPanel } from "./research-library-panel";
import { TrackingPanel } from "./research-tracking-panel";

export type ResearchPanelKind = "knowledge" | "library" | "search" | "tracking";

interface ResearchPanelProps {
  kind: ResearchPanelKind;
}

export function ResearchPanel({ kind }: ResearchPanelProps) {
  if (kind === "knowledge") return <KnowledgePanel />;
  if (kind === "search") return <LibraryPanel searchMode />;
  if (kind === "tracking") return <TrackingPanel />;
  return <LibraryPanel searchMode={false} />;
}
