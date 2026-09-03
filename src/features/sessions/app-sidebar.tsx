import {
  BeakerIcon,
  BlocksIcon,
  BrainCircuitIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  GitPullRequestIcon,
  InboxIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  RadarIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import { useEffect, useState, type PointerEventHandler } from "react";

import { Button } from "@/components/ui/button";
import { ExpandingSearch } from "@/components/interior/expanding-search";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  isIndependentProject,
  type ProjectDeleteResult,
  type ProjectRecord,
  type SessionRecord,
} from "@/domain/workspace";
import { cn } from "@/lib/utils";

import { SidebarDeleteDialogs } from "./sidebar-delete-dialogs";
import { SidebarProjectsNavigation } from "./sidebar-projects-navigation";
import type {
  ResearchSection,
  SidebarProjectEntry,
  WorkspaceMode,
} from "./sidebar-types";

export type { ResearchSection, WorkspaceMode } from "./sidebar-types";

interface AppSidebarProps {
  activeProject?: ProjectRecord;
  activeResearchSection: ResearchSection;
  activeSessionId?: string;
  loading: boolean;
  workspaceMode: WorkspaceMode;
  settingsActive: boolean;
  projects: ProjectRecord[];
  runningSessions: Record<string, boolean>;
  sessionsByProject: Record<string, SessionRecord[]>;
  sidebarWidth: number;
  onResizeBy: (delta: number) => void;
  onResizeStart: PointerEventHandler<HTMLDivElement>;
  onResetWidth: () => void;
  onDeleteSession: (session: SessionRecord) => void;
  onArchiveProject: (project: ProjectRecord) => void;
  onDeleteProject: (project: ProjectRecord) => Promise<ProjectDeleteResult>;
  onModeChange: (mode: WorkspaceMode) => void;
  onOpenExtensions: () => void;
  onOpenGit: () => void;
  onOpenSettings: () => void;
  onNewSession: (project?: ProjectRecord) => void;
  onRestoreProject: (project: ProjectRecord) => void;
  onSelectProject: (project: ProjectRecord) => void;
  onSelectSession: (session: SessionRecord) => void;
  onSelectResearchSection: (section: ResearchSection) => void;
}

export function AppSidebar({
  activeProject,
  activeResearchSection,
  activeSessionId,
  loading,
  workspaceMode,
  settingsActive,
  projects,
  runningSessions,
  sessionsByProject,
  sidebarWidth,
  onResizeBy,
  onResizeStart,
  onResetWidth,
  onDeleteSession,
  onArchiveProject,
  onDeleteProject,
  onModeChange,
  onNewSession,
  onOpenExtensions,
  onOpenGit,
  onOpenSettings,
  onRestoreProject,
  onSelectProject,
  onSelectSession,
  onSelectResearchSection,
}: AppSidebarProps) {
  const [pendingDelete, setPendingDelete] = useState<SessionRecord>();
  const [pendingDeleteProject, setPendingDeleteProject] =
    useState<ProjectRecord>();
  const [deletingProject, setDeletingProject] = useState(false);
  const [projectDeleteError, setProjectDeleteError] = useState<string>();
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(activeProject ? [activeProject.id] : []),
  );
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [tasksExpanded, setTasksExpanded] = useState(true);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const getVisibleProjectEntry = (
    project: ProjectRecord,
  ): SidebarProjectEntry | undefined => {
    const projectSessions = sessionsByProject[project.id] ?? [];
    if (!normalizedQuery) {
      return { project, sessions: projectSessions };
    }
    const projectMatches = project.name
      .toLocaleLowerCase()
      .includes(normalizedQuery);
    const matchingSessions = projectSessions.filter((session) =>
      session.title.toLocaleLowerCase().includes(normalizedQuery),
    );
    return projectMatches || matchingSessions.length > 0
      ? {
          project,
          sessions: projectMatches ? projectSessions : matchingSessions,
        }
      : undefined;
  };
  const visibleProjects = projects
    .filter((project) => !isIndependentProject(project) && !project.archived)
    .flatMap((project) => {
      const entry = getVisibleProjectEntry(project);
      return entry ? [entry] : [];
    });
  const archivedProjects = projects
    .filter((project) => !isIndependentProject(project) && project.archived)
    .flatMap((project) => {
      const entry = getVisibleProjectEntry(project);
      return entry ? [entry] : [];
    });
  const independentProject = projects.find(isIndependentProject);
  const visibleTask = independentProject
    ? getVisibleProjectEntry(independentProject)
    : undefined;

  useEffect(() => {
    if (!activeProject) {
      return;
    }
    setExpandedProjectIds((current) => {
      if (current.has(activeProject.id)) {
        return current;
      }
      const next = new Set(current);
      next.add(activeProject.id);
      return next;
    });
  }, [activeProject]);

  useEffect(() => {
    if (isIndependentProject(activeProject)) {
      setTasksExpanded(true);
    } else if (activeProject?.archived) {
      setArchivedExpanded(true);
    } else if (activeProject) {
      setProjectsExpanded(true);
    }
  }, [activeProject]);

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r bg-sidebar px-2 pb-2 text-sidebar-foreground"
      data-app-sidebar
      style={{ width: sidebarWidth }}
    >
      <div
        className="harness-window-titlebar shrink-0"
        data-tauri-drag-region
      />

      <div
        className="relative flex h-10 shrink-0 items-center gap-1.5 px-1"
        data-tauri-drag-region
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="min-w-0 justify-start gap-1 px-2 font-semibold text-lg text-sidebar-foreground hover:text-sidebar-foreground"
              variant="ghost"
            >
              <span className="truncate">
                {workspaceMode === "research"
                  ? "Melody Research"
                  : "Melody Work"}
              </span>
              <ChevronDownIcon className="size-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>应用模式</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onModeChange("work")}>
              <SquarePenIcon />
              <div className="min-w-0 flex-1">
                <p className="font-medium">Melody Work</p>
                <p className="text-muted-foreground text-xs">
                  开发任务与工程工具
                </p>
              </div>
              {workspaceMode === "work" ? (
                <span className="size-1.5 rounded-full bg-foreground" />
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onModeChange("research")}>
              <BrainCircuitIcon />
              <div className="min-w-0 flex-1">
                <p className="font-medium">Melody Research</p>
                <p className="text-muted-foreground text-xs">
                  文献、实验与研究智能
                </p>
              </div>
              {workspaceMode === "research" ? (
                <span className="size-1.5 rounded-full bg-foreground" />
              ) : null}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="pointer-events-none absolute inset-0 z-20">
          <div
            className="pointer-events-auto absolute inset-x-1 inset-y-0"
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <ExpandingSearch
              debounce={180}
              label="搜索项目和任务"
              onChange={setSearchInput}
              onSearch={setQuery}
              placeholder="搜索项目和任务"
              value={searchInput}
            />
          </div>
        </div>
      </div>

      <nav aria-label="主导航" className="mt-2 flex flex-col gap-0 px-1">
        <Button
          className={cn(
            "h-9 justify-start rounded-lg px-2 text-base text-sidebar-foreground hover:text-sidebar-foreground",
          )}
          disabled={loading || !activeProject || activeProject.archived}
          onClick={() => onNewSession()}
          variant="ghost"
        >
          <SquarePenIcon data-icon="inline-start" />
          {workspaceMode === "research" ? "新建研究任务" : "新建任务"}
        </Button>
        {workspaceMode === "research" ? (
          <>
            <Button
              className={cn(
                "h-9 justify-start rounded-lg px-2 text-base text-sidebar-foreground hover:text-sidebar-foreground",
                activeResearchSection === "overview" && "bg-sidebar-selected",
              )}
              onClick={() => onSelectResearchSection("overview")}
              variant="ghost"
            >
              <LayoutDashboardIcon data-icon="inline-start" />
              研究总览
            </Button>
            <Button
              className={cn(
                "h-9 justify-start rounded-lg px-2 text-base text-sidebar-foreground hover:text-sidebar-foreground",
                activeResearchSection === "search" && "bg-sidebar-selected",
              )}
              onClick={() => onSelectResearchSection("search")}
              variant="ghost"
            >
              <SearchIcon data-icon="inline-start" />
              自然语言检索
            </Button>
            <Button
              className={cn(
                "h-9 justify-start rounded-lg px-2 text-base text-sidebar-foreground hover:text-sidebar-foreground",
                activeResearchSection === "tracking" && "bg-sidebar-selected",
              )}
              onClick={() => onSelectResearchSection("tracking")}
              variant="ghost"
            >
              <RadarIcon data-icon="inline-start" />
              科研追踪
            </Button>
            <Button
              className={cn(
                "h-9 justify-start rounded-lg px-2 text-base text-sidebar-foreground hover:text-sidebar-foreground",
                activeResearchSection === "inbox" && "bg-sidebar-selected",
              )}
              onClick={() => onSelectResearchSection("inbox")}
              variant="ghost"
            >
              <InboxIcon data-icon="inline-start" />
              研究收件箱
            </Button>
          </>
        ) : (
          <Button
            className="h-9 justify-start rounded-lg px-2 text-base text-sidebar-foreground hover:text-sidebar-foreground"
            disabled={!activeProject}
            onClick={onOpenGit}
            variant="ghost"
          >
            <GitPullRequestIcon data-icon="inline-start" />
            审阅
          </Button>
        )}
        <Button
          className={cn(
            "h-9 justify-start rounded-lg px-2 text-base text-sidebar-foreground hover:text-sidebar-foreground",
            workspaceMode === "research" &&
              activeResearchSection === "capabilities" &&
              "bg-sidebar-selected",
          )}
          onClick={() =>
            workspaceMode === "research"
              ? onSelectResearchSection("capabilities")
              : onOpenExtensions()
          }
          variant="ghost"
        >
          <BlocksIcon data-icon="inline-start" />
          {workspaceMode === "research" ? "科研能力" : "扩展"}
        </Button>
      </nav>

      <div className="mt-5 flex min-h-0 flex-1 flex-col">
        {workspaceMode === "research" ? (
          <>
            <p className="px-3 pb-1.5 font-medium text-sidebar-foreground text-xs uppercase tracking-wide">
              研究
            </p>
            <nav
              aria-label="研究模块"
              className="flex shrink-0 flex-col gap-0.5 px-1"
            >
              {(
                [
                  ["knowledge", BrainCircuitIcon, "知识资产"],
                  ["library", LibraryIcon, "文献库"],
                  ["experiments", FlaskConicalIcon, "实验资源"],
                  ["sandbox", BeakerIcon, "研究沙盒"],
                ] as const
              ).map(([section, Icon, label]) => (
                <Button
                  className={cn(
                    "h-9 justify-start rounded-lg px-2 text-base text-sidebar-foreground hover:text-sidebar-foreground",
                    activeResearchSection === section &&
                      "bg-sidebar-selected font-medium hover:bg-sidebar-selected",
                  )}
                  key={section}
                  onClick={() => onSelectResearchSection(section)}
                  variant="ghost"
                >
                  <Icon data-icon="inline-start" />
                  {label}
                </Button>
              ))}
            </nav>
          </>
        ) : null}
        <SidebarProjectsNavigation
          activeProject={activeProject}
          activeSessionId={activeSessionId}
          archivedExpanded={archivedExpanded}
          archivedProjects={archivedProjects}
          expandedProjectIds={expandedProjectIds}
          loading={loading}
          normalizedQuery={normalizedQuery}
          onArchiveProject={onArchiveProject}
          onNewSession={onNewSession}
          onRequestDelete={setPendingDelete}
          onRequestDeleteProject={setPendingDeleteProject}
          onRestoreProject={onRestoreProject}
          onSelectProject={onSelectProject}
          onSelectSession={onSelectSession}
          onSetArchivedExpanded={setArchivedExpanded}
          onSetExpandedProject={(projectId, open) => {
            setExpandedProjectIds((current) => {
              const next = new Set(current);
              if (open) next.add(projectId);
              else next.delete(projectId);
              return next;
            });
          }}
          onSetProjectsExpanded={setProjectsExpanded}
          onSetTasksExpanded={setTasksExpanded}
          projectsExpanded={projectsExpanded}
          runningSessions={runningSessions}
          tasksExpanded={tasksExpanded}
          visibleProjects={visibleProjects}
          visibleTask={visibleTask}
          workspaceMode={workspaceMode}
        />
      </div>

      <div className="app-sidebar-footer border-t px-1 pt-1.5">
        <Button
          className={cn(
            "h-9 w-full justify-start rounded-lg px-2 text-sidebar-foreground hover:text-sidebar-foreground",
            settingsActive && "bg-sidebar-selected hover:bg-sidebar-selected",
          )}
          onClick={onOpenSettings}
          variant="ghost"
        >
          <span className="min-w-0 flex-1 truncate text-left">设置</span>
          <SettingsIcon className="size-4 text-muted-foreground" />
        </Button>
      </div>

      <SidebarDeleteDialogs
        deletingProject={deletingProject}
        onDeleteProject={onDeleteProject}
        onDeleteSession={onDeleteSession}
        onDeletingProjectChange={setDeletingProject}
        onPendingDeleteChange={setPendingDelete}
        onPendingDeleteProjectChange={setPendingDeleteProject}
        onProjectDeleteErrorChange={setProjectDeleteError}
        pendingDelete={pendingDelete}
        pendingDeleteProject={pendingDeleteProject}
        projectDeleteError={projectDeleteError}
      />

      <div
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemax={420}
        aria-valuemin={224}
        aria-valuenow={Math.round(sidebarWidth)}
        className="group absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onDoubleClick={onResetWidth}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onResizeBy(-8);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            onResizeBy(8);
          } else if (event.key === "Home") {
            event.preventDefault();
            onResizeBy(224 - sidebarWidth);
          } else if (event.key === "End") {
            event.preventDefault();
            onResizeBy(420 - sidebarWidth);
          }
        }}
        onPointerDown={onResizeStart}
        role="separator"
        tabIndex={0}
        title="拖动调整侧边栏宽度，双击恢复默认"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-ring group-focus-visible:bg-ring" />
      </div>
    </aside>
  );
}
