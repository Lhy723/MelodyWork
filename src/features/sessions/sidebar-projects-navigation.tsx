import { ArchiveIcon, ChevronRightIcon, FolderOpenIcon } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ProjectRecord, SessionRecord } from "@/domain/workspace";
import { cn } from "@/lib/utils";

import { SidebarProjectGroup } from "./sidebar-project-group";
import type { SidebarProjectEntry, WorkspaceMode } from "./sidebar-types";

interface SidebarProjectsNavigationProps {
  activeProject?: ProjectRecord;
  activeSessionId?: string;
  archivedExpanded: boolean;
  expandedProjectIds: Set<string>;
  loading: boolean;
  normalizedQuery: string;
  onArchiveProject: (project: ProjectRecord) => void;
  onNewSession: (project?: ProjectRecord) => void;
  onRequestDelete: (session: SessionRecord) => void;
  onRequestDeleteProject: (project: ProjectRecord) => void;
  onRestoreProject: (project: ProjectRecord) => void;
  onSelectProject: (project: ProjectRecord) => void;
  onSelectSession: (session: SessionRecord) => void;
  onSetArchivedExpanded: (open: boolean) => void;
  onSetExpandedProject: (projectId: string, open: boolean) => void;
  onSetProjectsExpanded: (open: boolean) => void;
  onSetTasksExpanded: (open: boolean) => void;
  projectsExpanded: boolean;
  runningSessions: Record<string, boolean>;
  tasksExpanded: boolean;
  visibleProjects: SidebarProjectEntry[];
  archivedProjects: SidebarProjectEntry[];
  visibleTask?: SidebarProjectEntry;
  workspaceMode: WorkspaceMode;
}

export function SidebarProjectsNavigation({
  activeProject,
  activeSessionId,
  archivedExpanded,
  expandedProjectIds,
  loading,
  normalizedQuery,
  onArchiveProject,
  onNewSession,
  onRequestDelete,
  onRequestDeleteProject,
  onRestoreProject,
  onSelectProject,
  onSelectSession,
  onSetArchivedExpanded,
  onSetExpandedProject,
  onSetProjectsExpanded,
  onSetTasksExpanded,
  projectsExpanded,
  runningSessions,
  tasksExpanded,
  visibleProjects,
  archivedProjects,
  visibleTask,
  workspaceMode,
}: SidebarProjectsNavigationProps) {
  const renderProject = (
    { project, sessions }: SidebarProjectEntry,
    projectIndex: number,
  ) => (
    <SidebarProjectGroup
      activeProject={activeProject}
      activeSessionId={activeSessionId}
      expanded={Boolean(normalizedQuery) || expandedProjectIds.has(project.id)}
      key={project.id}
      loading={loading}
      normalizedQuery={normalizedQuery}
      onExpandedChange={(open) => onSetExpandedProject(project.id, open)}
      onNewSession={onNewSession}
      onArchiveProject={onArchiveProject}
      onRequestDeleteProject={onRequestDeleteProject}
      onRequestDelete={onRequestDelete}
      onRestoreProject={onRestoreProject}
      onSelectProject={onSelectProject}
      onSelectSession={onSelectSession}
      project={project}
      projectIndex={projectIndex}
      runningSessions={runningSessions}
      sessions={sessions}
      workspaceMode={workspaceMode}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Collapsible
        className={cn("shrink-0", workspaceMode === "research" && "mt-5")}
        onOpenChange={onSetProjectsExpanded}
        open={projectsExpanded || Boolean(normalizedQuery)}
      >
        <div className="group/section flex h-8 w-full items-center rounded-lg px-1 text-sidebar-foreground">
          <CollapsibleTrigger asChild>
            <button
              aria-label={`${projectsExpanded ? "收起" : "展开"}项目`}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-left font-medium text-base hover:text-sidebar-foreground"
              type="button"
            >
              <ChevronRightIcon
                className={cn(
                  "motion-collapsible-chevron size-3.5 shrink-0 text-muted-foreground/70",
                  (projectsExpanded || Boolean(normalizedQuery)) && "rotate-90",
                )}
              />
              <FolderOpenIcon className="size-4 shrink-0" />
              <span className="truncate">项目</span>
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="motion-collapsible-content">
          <nav aria-label="项目" className="flex flex-col gap-0.5 px-1 pb-2">
            {visibleProjects.map(renderProject)}
            {!loading && visibleProjects.length === 0 ? (
              <p className="px-2 py-2 text-sidebar-foreground text-xs">
                {normalizedQuery ? "没有匹配的项目" : "暂无项目"}
              </p>
            ) : null}
          </nav>
        </CollapsibleContent>
      </Collapsible>

      {archivedProjects.length > 0 ? (
        <Collapsible
          className="mt-1 shrink-0"
          onOpenChange={onSetArchivedExpanded}
          open={archivedExpanded || Boolean(normalizedQuery)}
        >
          <div className="group/section flex h-8 w-full items-center rounded-lg px-1 text-sidebar-foreground">
            <CollapsibleTrigger asChild>
              <button
                aria-label={`${archivedExpanded ? "收起" : "展开"}已归档项目`}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-left font-medium text-base hover:text-sidebar-foreground"
                type="button"
              >
                <ChevronRightIcon
                  className={cn(
                    "motion-collapsible-chevron size-3.5 shrink-0 text-muted-foreground/70",
                    (archivedExpanded || Boolean(normalizedQuery)) &&
                      "rotate-90",
                  )}
                />
                <ArchiveIcon className="size-4 shrink-0" />
                <span className="truncate">已归档项目</span>
                <span className="ml-auto pr-1 text-muted-foreground text-xs">
                  {archivedProjects.length}
                </span>
              </button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="motion-collapsible-content">
            <nav
              aria-label="已归档项目"
              className="flex flex-col gap-0.5 px-1 pb-2"
            >
              {archivedProjects.map((entry, index) =>
                renderProject(entry, visibleProjects.length + index),
              )}
            </nav>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {visibleTask ? (
        <nav
          aria-label="任务"
          className="mt-3 flex shrink-0 flex-col gap-0.5 px-1 pb-2"
        >
          <SidebarProjectGroup
            activeProject={activeProject}
            activeSessionId={activeSessionId}
            expanded={tasksExpanded || Boolean(normalizedQuery)}
            loading={loading}
            normalizedQuery={normalizedQuery}
            onExpandedChange={onSetTasksExpanded}
            onNewSession={onNewSession}
            onArchiveProject={onArchiveProject}
            onRequestDeleteProject={onRequestDeleteProject}
            onRequestDelete={onRequestDelete}
            onRestoreProject={onRestoreProject}
            onSelectProject={onSelectProject}
            onSelectSession={onSelectSession}
            project={visibleTask.project}
            projectIndex={visibleProjects.length}
            runningSessions={runningSessions}
            sessions={visibleTask.sessions}
            workspaceMode={workspaceMode}
          />
        </nav>
      ) : null}
    </div>
  );
}
