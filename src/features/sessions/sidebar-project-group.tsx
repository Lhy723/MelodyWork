import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";

import { RippleLayer, useRipple } from "@/components/interior/ripple";
import {
  ContextMenu,
  type ContextMenuItem,
} from "@/components/interior/context-menu";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  isIndependentProject,
  type ProjectRecord,
  type SessionRecord,
} from "@/domain/workspace";
import { localizedSessionTitle } from "@/lib/localize";
import { cn } from "@/lib/utils";

import type { WorkspaceMode } from "./sidebar-types";

export interface SidebarProjectGroupProps {
  activeProject?: ProjectRecord;
  activeSessionId?: string;
  expanded: boolean;
  loading: boolean;
  normalizedQuery: string;
  onExpandedChange: (open: boolean) => void;
  onNewSession: (project: ProjectRecord) => void;
  onArchiveProject: (project: ProjectRecord) => void;
  onRequestDeleteProject: (project: ProjectRecord) => void;
  onRequestDelete: (session: SessionRecord) => void;
  onRestoreProject: (project: ProjectRecord) => void;
  onSelectProject: (project: ProjectRecord) => void;
  onSelectSession: (session: SessionRecord) => void;
  project: ProjectRecord;
  projectIndex: number;
  runningSessions: Record<string, boolean>;
  sessions: SessionRecord[];
  workspaceMode: WorkspaceMode;
}

function SidebarSessionRow({
  onRequestDelete,
  onSelectSession,
  running,
  selected,
  session,
}: {
  onRequestDelete: (session: SessionRecord) => void;
  onSelectSession: (session: SessionRecord) => void;
  running: boolean;
  selected: boolean;
  session: SessionRecord;
}) {
  const title = localizedSessionTitle(session.title);
  const { bindings, fadeDuration, ripples } = useRipple({ max: 2 });

  return (
    <div
      className={cn(
        "group flex min-h-8 w-full items-center rounded-lg px-1 text-sm transition-colors",
        selected
          ? "bg-sidebar-selected text-sidebar-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <button
        className="relative isolate min-w-0 flex-1 truncate overflow-hidden rounded-md px-2 py-1 text-left"
        onClick={() => onSelectSession(session)}
        style={{
          WebkitTapHighlightColor: "transparent",
          touchAction: "manipulation",
        }}
        title={title}
        type="button"
        {...bindings}
      >
        <RippleLayer fadeDuration={fadeDuration} ripples={ripples} />
        <span className="relative z-10 block truncate">{title}</span>
      </button>
      {running ? (
        <span
          aria-label="任务正在运行"
          className="relative z-10 mr-1 size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/35 border-t-foreground"
          role="status"
          title="任务正在运行"
        />
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`${title}的操作`}
            className={cn(
              "shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
              selected && "group-hover:opacity-100",
            )}
            size="icon-sm"
            variant="ghost"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onRequestDelete(session)}
          >
            <Trash2Icon />
            删除任务…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function SidebarProjectGroup({
  activeProject,
  activeSessionId,
  expanded,
  loading,
  normalizedQuery,
  onExpandedChange,
  onNewSession,
  onArchiveProject,
  onRequestDeleteProject,
  onRequestDelete,
  onRestoreProject,
  onSelectProject,
  onSelectSession,
  project,
  projectIndex,
  runningSessions,
  sessions,
  workspaceMode,
}: SidebarProjectGroupProps) {
  const independent = isIndependentProject(project);
  const label = independent ? "任务" : project.name;
  const active = project.id === activeProject?.id;
  const { bindings, fadeDuration, ripples } = useRipple({ max: 2 });
  const contextMenuItems: ContextMenuItem[] = [
    {
      id: "switch",
      icon: independent ? <MessageCircleIcon /> : <FolderOpenIcon />,
      label: independent ? "切换到任务" : "切换到项目",
      onSelect: () => onSelectProject(project),
    },
    {
      id: "new-session",
      disabled: project.archived,
      icon: <SquarePenIcon />,
      label: independent
        ? workspaceMode === "research"
          ? "在任务中新建研究任务"
          : "在任务中新建任务"
        : workspaceMode === "research"
          ? "在此项目新建研究任务"
          : "在此项目新建任务",
      onSelect: () => onNewSession(project),
    },
    ...(!independent && project.archived
      ? [
          {
            id: "restore",
            icon: <ArchiveRestoreIcon />,
            label: "取消归档",
            onSelect: () => onRestoreProject(project),
          } satisfies ContextMenuItem,
        ]
      : []),
    ...(!independent && !project.archived
      ? [
          {
            id: "archive",
            icon: <ArchiveIcon />,
            label: "归档项目",
            onSelect: () => onArchiveProject(project),
          } satisfies ContextMenuItem,
        ]
      : []),
    ...(!independent
      ? [
          { id: "separator", type: "separator" } satisfies ContextMenuItem,
          {
            id: "delete",
            icon: <Trash2Icon />,
            label: "删除项目…",
            onSelect: () => onRequestDeleteProject(project),
          } satisfies ContextMenuItem,
        ]
      : []),
  ];
  return (
    <Collapsible
      className="motion-list-item"
      onOpenChange={onExpandedChange}
      open={expanded}
      style={{
        animationDelay: `${Math.min(projectIndex, 6) * 24}ms`,
      }}
    >
      <ContextMenu
        className="w-full rounded-lg"
        items={contextMenuItems}
        label={`${label}的操作`}
      >
        <div
          className={cn(
            "group/project flex h-8 w-full items-center rounded-lg px-1 transition-colors",
            active
              ? "bg-sidebar-selected font-medium text-sidebar-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
          )}
        >
          <CollapsibleTrigger asChild>
            <button
              aria-label={`${expanded ? "收起" : "展开"}${independent ? "任务" : `项目 ${project.name}`}`}
              className="relative isolate flex min-w-0 flex-1 items-center overflow-hidden rounded-md px-1 text-left text-base"
              title={independent ? "MelodyWork 的隔离任务目录" : project.path}
              style={{
                WebkitTapHighlightColor: "transparent",
                touchAction: "manipulation",
              }}
              type="button"
              {...bindings}
            >
              <RippleLayer fadeDuration={fadeDuration} ripples={ripples} />
              <span className="relative z-10 flex min-w-0 items-center gap-1.5">
                <ChevronRightIcon
                  className={cn(
                    "motion-collapsible-chevron size-3.5 shrink-0 text-muted-foreground/70",
                    expanded && "rotate-90",
                  )}
                />
                {independent ? (
                  <MessageCircleIcon className="size-4 shrink-0" />
                ) : (
                  <FolderOpenIcon className="size-4 shrink-0" />
                )}
                <span className="truncate">{label}</span>
              </span>
            </button>
          </CollapsibleTrigger>
          {!project.archived ? (
            <Button
              aria-label={
                independent
                  ? workspaceMode === "research"
                    ? "在任务中新建研究任务"
                    : "在任务中新建任务"
                  : `在 ${project.name} 中新建${workspaceMode === "research" ? "研究任务" : "任务"}`
              }
              disabled={loading}
              onClick={() => onNewSession(project)}
              size="icon-sm"
              title={
                independent
                  ? workspaceMode === "research"
                    ? "在任务中新建研究任务"
                    : "在任务中新建任务"
                  : workspaceMode === "research"
                    ? "在此项目新建研究任务"
                    : "在此项目新建任务"
              }
              variant="ghost"
            >
              <SquarePenIcon />
            </Button>
          ) : null}
        </div>
      </ContextMenu>

      <CollapsibleContent className="motion-collapsible-content">
        <div className="flex flex-col gap-0.5 pl-6 pt-0.5">
          {sessions.map((session) => {
            return (
              <SidebarSessionRow
                onRequestDelete={onRequestDelete}
                onSelectSession={onSelectSession}
                key={session.id}
                running={runningSessions[session.id] === true}
                selected={session.id === activeSessionId}
                session={session}
              />
            );
          })}
          {!loading && sessions.length === 0 ? (
            <p className="px-2 py-2 text-sidebar-foreground text-xs">
              {normalizedQuery ? "没有匹配的任务" : "暂无任务"}
            </p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
