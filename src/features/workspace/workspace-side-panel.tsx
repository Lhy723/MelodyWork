import {
  BotIcon,
  FileCode2Icon,
  FilesIcon,
  GitCompareArrowsIcon,
  LibraryIcon,
  PlusIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { type PointerEventHandler } from "react";

import {
  MOTION_EASE,
  MOTION_LEAVE_EASE,
} from "@/components/motion/page-transition";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentSubagent } from "@/domain/acp";
import type { GitChange } from "@/domain/git";
import type { ProjectReference } from "@/domain/message-citations";
import { FilePreview } from "@/features/files/file-preview";
import { FileWorkspace } from "@/features/files/file-workspace";
import { ChangeReview } from "@/features/git/change-review";
import {
  ResearchPanel,
  type ResearchPanelKind,
} from "@/features/research/research-panel";
import { TerminalPanel } from "@/features/terminal/terminal-panel";
import { SubagentConversation } from "@/features/workspace/subagent-conversation";
import { cn } from "@/lib/utils";

export type WorkspaceTab =
  | { id: string; kind: "files"; label: string }
  | { id: string; kind: "terminal"; label: string }
  | { id: string; kind: "review"; label: string }
  | {
      id: string;
      kind: "research";
      label: string;
      panel: ResearchPanelKind;
    }
  | {
      id: string;
      kind: "file";
      label: string;
      path: string;
    }
  | {
      id: string;
      kind: "subagent";
      label: string;
      subagentId: string;
      childSessionId: string;
    };

interface WorkspaceSidePanelProps {
  activeTabId?: string;
  changes: GitChange[];
  cwd: string;
  gitError?: string;
  gitLoading: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: (kind: "files" | "terminal" | "review") => void;
  onOpenFile: (path: string) => void;
  onOpenProjectReference: (reference: ProjectReference) => void;
  onResizeBy: (delta: number) => void;
  onResizeStart: PointerEventHandler<HTMLDivElement>;
  onResetWidth: () => void;
  onRefreshGit: () => void;
  root: string;
  subagents: Record<string, AgentSubagent>;
  tabs: WorkspaceTab[];
}

const tabIcon = (tab: WorkspaceTab) => {
  if (tab.kind === "files") {
    return <FilesIcon />;
  }
  if (tab.kind === "terminal") {
    return <TerminalSquareIcon />;
  }
  if (tab.kind === "review") {
    return <GitCompareArrowsIcon />;
  }
  if (tab.kind === "subagent") {
    return <BotIcon />;
  }
  if (tab.kind === "research") {
    return <LibraryIcon />;
  }
  return <FileCode2Icon />;
};

export function WorkspaceSidePanel({
  activeTabId,
  changes,
  cwd,
  gitError,
  gitLoading,
  onActivateTab,
  onCloseTab,
  onNewTab,
  onOpenFile,
  onOpenProjectReference,
  onResizeBy,
  onResizeStart,
  onResetWidth,
  onRefreshGit,
  root,
  subagents,
  tabs,
}: WorkspaceSidePanelProps) {
  return (
    <aside
      aria-label="右侧工作区"
      className="motion-workspace-panel relative flex size-full min-h-0 shrink-0 flex-col border-l bg-background shadow-[-12px_0_30px_-24px_rgba(0,0,0,0.35)]"
      style={{ width: "var(--workspace-panel-width, 35rem)" }}
    >
      <div
        aria-label="调整右侧工作区宽度"
        aria-orientation="vertical"
        className="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onDoubleClick={onResetWidth}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onResizeBy(24);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            onResizeBy(-24);
          } else if (event.key === "Home") {
            event.preventDefault();
            onResetWidth();
          }
        }}
        onPointerDown={onResizeStart}
        role="separator"
        tabIndex={0}
        title="拖拽调整宽度，双击恢复默认"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-ring group-focus-visible:bg-ring" />
      </div>
      <header
        className="harness-window-titlebar flex shrink-0 items-center border-b"
        data-tauri-drag-region
      >
        <div
          aria-label="工作区标签页"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1"
          data-tauri-drag-region
          role="tablist"
        >
          {tabs.map((tab) => (
            <div
              className={cn(
                "group relative flex h-8 min-w-0 max-w-52 shrink-0 items-center rounded-md border border-transparent text-muted-foreground transition-colors",
                activeTabId === tab.id && "text-foreground",
              )}
              key={tab.id}
            >
              {activeTabId === tab.id ? (
                <motion.span
                  className="absolute inset-0 rounded-md border border-border/80 bg-muted/70 shadow-sm"
                  layoutId="workspace-tab-active"
                  transition={{
                    duration: 0.2,
                    ease: MOTION_EASE,
                  }}
                />
              ) : null}
              <button
                aria-selected={activeTabId === tab.id}
                className="relative z-10 flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-2.5 text-xs outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onActivateTab(tab.id)}
                role="tab"
                title={tab.kind === "file" ? tab.path : tab.label}
                type="button"
              >
                <span className="[&>svg]:size-3.5">{tabIcon(tab)}</span>
                <span className="truncate">{tab.label}</span>
              </button>
              <Button
                aria-label={`关闭 ${tab.label}`}
                className="mr-1 size-7 shrink-0 opacity-55 hover:opacity-100"
                onClick={() => onCloseTab(tab.id)}
                size="icon-sm"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="新建工作区标签页"
              className="mr-1 size-7 shrink-0"
              size="icon-xs"
              title="新建标签页"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onNewTab("terminal")}>
              <TerminalSquareIcon />
              新建终端
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewTab("files")}>
              <FilesIcon />
              新建文件
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewTab("review")}>
              <GitCompareArrowsIcon />
              新建审阅
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="grid size-full place-items-center p-6">
            <div className="w-full max-w-xs">
              <p className="mb-4 text-center text-muted-foreground text-sm">
                打开一个标签页
              </p>
              <div className="grid gap-2">
                <Button
                  className="justify-start"
                  onClick={() => onNewTab("files")}
                  variant="outline"
                >
                  <FilesIcon />
                  文件
                </Button>
                <Button
                  className="justify-start"
                  onClick={() => onNewTab("review")}
                  variant="outline"
                >
                  <GitCompareArrowsIcon />
                  审阅
                </Button>
                <Button
                  className="justify-start"
                  onClick={() => onNewTab("terminal")}
                  variant="outline"
                >
                  <TerminalSquareIcon />
                  终端
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {tabs.map((tab) => (
          <motion.div
            aria-hidden={activeTabId !== tab.id}
            animate={{
              opacity: activeTabId === tab.id ? 1 : 0,
              scale: activeTabId === tab.id ? 1 : 0.99,
              y: activeTabId === tab.id ? 0 : 8,
            }}
            className="absolute inset-0"
            inert={activeTabId !== tab.id}
            key={tab.id}
            role="tabpanel"
            initial={false}
            style={{
              pointerEvents: activeTabId === tab.id ? "auto" : "none",
              willChange: "opacity, transform",
            }}
            transition={{
              duration: activeTabId === tab.id ? 0.28 : 0.16,
              ease: activeTabId === tab.id ? MOTION_EASE : MOTION_LEAVE_EASE,
            }}
          >
            {tab.kind === "files" ? (
              <FileWorkspace embedded onOpenFile={onOpenFile} root={root} />
            ) : tab.kind === "terminal" ? (
              <TerminalPanel cwd={cwd} embedded />
            ) : tab.kind === "review" ? (
              <ChangeReview
                changes={changes}
                cwd={cwd}
                embedded
                error={gitError}
                loading={gitLoading}
                onRefresh={onRefreshGit}
              />
            ) : tab.kind === "file" ? (
              <FilePreview path={tab.path} root={root} />
            ) : tab.kind === "research" ? (
              <ResearchPanel kind={tab.panel} />
            ) : subagents[tab.subagentId] ? (
              <SubagentConversation
                active={activeTabId === tab.id}
                cwd={cwd}
                onOpenProjectReference={onOpenProjectReference}
                projectRoot={root}
                subagent={subagents[tab.subagentId]}
              />
            ) : (
              <div className="grid size-full place-items-center p-6 text-center">
                <div>
                  <BotIcon className="mx-auto mb-3 size-5 text-muted-foreground" />
                  <p className="font-medium text-sm">Subagent 不可用</p>
                  <p className="mt-1 text-muted-foreground text-xs">
                    该子会话可能属于另一个对话。
                  </p>
                </div>
              </div>
            )}
          </motion.div>
        ))}
      </div>
    </aside>
  );
}
