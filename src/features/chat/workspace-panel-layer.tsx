import type { CSSProperties, PointerEventHandler } from "react";

import type { AgentSubagent } from "@/domain/acp";
import type { GitChange } from "@/domain/git";
import type { ProjectReference } from "@/domain/message-citations";
import type { WorkspaceTab } from "@/features/workspace/workspace-side-panel";
import { WorkspaceSidePanel } from "@/features/workspace/workspace-side-panel";
import {
  MAX_WORKSPACE_PANEL_WIDTH,
  MIN_WORKSPACE_PANEL_WIDTH,
} from "./agent-workspace-utils";

type ResizeState = { startWidth: number; startX: number };

interface WorkspacePanelLayerProps {
  activeTabId?: string;
  changes: GitChange[];
  cwd: string;
  error?: string;
  loading: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: (kind: "files" | "terminal" | "review") => void;
  onOpenFile: (path: string) => void;
  onOpenProjectReference: (reference: ProjectReference) => void;
  onRefreshGit: () => void | Promise<void>;
  onResizeStart: PointerEventHandler<HTMLDivElement>;
  onResetWidth: () => void;
  onResizeBy: (delta: number) => void;
  panelWidth: number;
  resizing?: ResizeState;
  root: string;
  subagents: Record<string, AgentSubagent>;
  tabs: WorkspaceTab[];
  open: boolean;
}

export function WorkspacePanelLayer({
  activeTabId,
  changes,
  cwd,
  error,
  loading,
  onActivateTab,
  onCloseTab,
  onNewTab,
  onOpenFile,
  onOpenProjectReference,
  onRefreshGit,
  onResizeStart,
  onResetWidth,
  onResizeBy,
  panelWidth,
  resizing,
  root,
  subagents,
  tabs,
  open,
}: WorkspacePanelLayerProps) {
  return (
    <div
      aria-hidden={!open}
      className="motion-workspace-layer h-full min-h-0 shrink-0"
      data-collapsed={!open}
      data-resizing={Boolean(resizing)}
      inert={!open}
      style={
        {
          "--workspace-panel-width": `${panelWidth}px`,
          width: open ? panelWidth : 0,
        } as CSSProperties
      }
    >
      <WorkspaceSidePanel
        activeTabId={activeTabId}
        changes={changes}
        cwd={cwd}
        gitError={error}
        gitLoading={loading}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
        onOpenFile={onOpenFile}
        onOpenProjectReference={onOpenProjectReference}
        onRefreshGit={onRefreshGit}
        onResetWidth={onResetWidth}
        onResizeBy={onResizeBy}
        onResizeStart={onResizeStart}
        panelWidth={panelWidth}
        maxPanelWidth={MAX_WORKSPACE_PANEL_WIDTH}
        minPanelWidth={MIN_WORKSPACE_PANEL_WIDTH}
        root={root}
        subagents={subagents}
        tabs={tabs}
      />
    </div>
  );
}
