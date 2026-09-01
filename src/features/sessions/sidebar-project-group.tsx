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
  return (
    <Collapsible
      className="motion-list-item"
      onOpenChange={onExpandedChange}
      open={expanded}
      style={{
        animationDelay: `${Math.min(projectIndex, 6) * 24}ms`,
      }}
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
            className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-left text-base"
            title={independent ? "MelodyWork 的隔离任务目录" : project.path}
            type="button"
          >
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
          </button>
        </CollapsibleTrigger>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`${label}的操作`}
              className="opacity-0 group-hover/project:opacity-100 focus:opacity-100"
              size="icon-sm"
              variant="ghost"
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuItem
              className="whitespace-nowrap"
              onSelect={() => onSelectProject(project)}
            >
              {independent ? <MessageCircleIcon /> : <FolderOpenIcon />}
              {independent ? "切换到任务" : "切换到项目"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="whitespace-nowrap"
              disabled={project.archived}
              onSelect={() => onNewSession(project)}
            >
              <SquarePenIcon />
              {independent
                ? workspaceMode === "research"
                  ? "在任务中新建研究任务"
                  : "在任务中新建任务"
                : workspaceMode === "research"
                  ? "在此项目新建研究任务"
                  : "在此项目新建任务"}
            </DropdownMenuItem>
            {!independent && project.archived ? (
              <DropdownMenuItem
                className="whitespace-nowrap"
                onSelect={() => onRestoreProject(project)}
              >
                <ArchiveRestoreIcon />
                取消归档
              </DropdownMenuItem>
            ) : null}
            {!independent && !project.archived ? (
              <DropdownMenuItem
                className="whitespace-nowrap"
                onSelect={() => onArchiveProject(project)}
              >
                <ArchiveIcon />
                归档项目
              </DropdownMenuItem>
            ) : null}
            {!independent ? (
              <DropdownMenuItem
                className="whitespace-nowrap"
                onSelect={() => onRequestDeleteProject(project)}
                variant="destructive"
              >
                <Trash2Icon />
                删除项目…
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
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

      <CollapsibleContent className="motion-collapsible-content">
        <div className="flex flex-col gap-0.5 pl-6 pt-0.5">
          {sessions.map((session) => {
            const selected = session.id === activeSessionId;
            const running = runningSessions[session.id] === true;
            return (
              <div
                className={cn(
                  "group flex min-h-8 w-full items-center rounded-lg px-1 text-sm transition-colors",
                  selected
                    ? "bg-sidebar-selected text-sidebar-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
                key={session.id}
              >
                <button
                  className="min-w-0 flex-1 truncate px-2 py-1 text-left"
                  onClick={() => onSelectSession(session)}
                  title={localizedSessionTitle(session.title)}
                  type="button"
                >
                  {localizedSessionTitle(session.title)}
                </button>
                {running ? (
                  <span
                    aria-label="任务正在运行"
                    className="mr-1 size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/35 border-t-foreground"
                    role="status"
                    title="任务正在运行"
                  />
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={`${localizedSessionTitle(session.title)}的操作`}
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
