import {
  BeakerIcon,
  BlocksIcon,
  BrainCircuitIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FlaskConicalIcon,
  FolderOpenIcon,
  GitPullRequestIcon,
  LibraryIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RadarIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useState,
  type PointerEventHandler,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectRecord, SessionRecord } from "@/domain/workspace";
import { localizedSessionTitle } from "@/lib/localize";
import { cn } from "@/lib/utils";

export type WorkspaceMode = "work" | "research";
export type ResearchSection =
  | "knowledge"
  | "library"
  | "experiments"
  | "sandbox"
  | "search"
  | "tracking"
  | "skills";

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
  onChooseProject: () => void;
  onDeleteSession: (session: SessionRecord) => void;
  onModeChange: (mode: WorkspaceMode) => void;
  onOpenExtensions: () => void;
  onOpenGit: () => void;
  onOpenSettings: () => void;
  onNewSession: (project?: ProjectRecord) => void;
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
  onChooseProject,
  onDeleteSession,
  onModeChange,
  onNewSession,
  onOpenExtensions,
  onOpenGit,
  onOpenSettings,
  onSelectProject,
  onSelectSession,
  onSelectResearchSection,
}: AppSidebarProps) {
  const [pendingDelete, setPendingDelete] = useState<SessionRecord>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(activeProject ? [activeProject.id] : []),
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProjects = projects.flatMap((project) => {
    const projectSessions = sessionsByProject[project.id] ?? [];
    if (!normalizedQuery) {
      return [{ project, sessions: projectSessions }];
    }
    const projectMatches = project.name
      .toLocaleLowerCase()
      .includes(normalizedQuery);
    const matchingSessions = projectSessions.filter((session) =>
      session.title.toLocaleLowerCase().includes(normalizedQuery),
    );
    return projectMatches || matchingSessions.length > 0
      ? [{
          project,
          sessions: projectMatches ? projectSessions : matchingSessions,
        }]
      : [];
  });

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

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r bg-sidebar px-2 pb-2 text-sidebar-foreground"
      data-app-sidebar
      style={{ width: sidebarWidth }}
    >
      <div className="h-8 shrink-0" data-tauri-drag-region />

      <div
        className="flex h-10 shrink-0 items-center gap-1.5 px-1"
        data-tauri-drag-region
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="min-w-0 justify-start gap-1 px-2 font-semibold text-lg text-sidebar-foreground hover:text-sidebar-foreground"
              variant="ghost"
            >
              <span
                className={cn(
                  "truncate",
                  workspaceMode === "research" && "research-serif",
                )}
              >
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
                <p className="research-serif font-medium">Melody Research</p>
                <p className="text-muted-foreground text-xs">
                  文献、实验与研究智能
                </p>
              </div>
              {workspaceMode === "research" ? (
                <span className="size-1.5 rounded-full bg-foreground" />
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>当前工作区</DropdownMenuLabel>
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onSelect={() => onSelectProject(project)}
              >
                <FolderOpenIcon />
                <span className="truncate">{project.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onChooseProject}>
              <PlusIcon />
              打开工作区…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          aria-label={searchOpen ? "关闭搜索" : "搜索任务"}
          className="ml-auto shrink-0 text-sidebar-foreground hover:text-sidebar-foreground"
          onClick={() => {
            setSearchOpen((current) => !current);
            if (searchOpen) {
              setQuery("");
            }
          }}
          size="icon"
          variant="ghost"
        >
          {searchOpen ? <XIcon /> : <SearchIcon />}
        </Button>
      </div>

      {searchOpen ? (
        <div className="motion-view-enter px-1 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-lg border bg-background/70 px-2.5 shadow-xs">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-sidebar-foreground text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目和任务"
              value={query}
            />
          </div>
        </div>
      ) : null}

      <nav aria-label="主导航" className="mt-2 flex flex-col gap-0 px-1">
        <Button
          className="h-9 justify-start rounded-lg px-2 text-[15px] text-sidebar-foreground hover:text-sidebar-foreground"
          disabled={loading || !activeProject}
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
                "h-9 justify-start rounded-lg px-2 text-[15px] text-sidebar-foreground hover:text-sidebar-foreground",
                activeResearchSection === "search" &&
                  "bg-sidebar-selected",
              )}
              onClick={() => onSelectResearchSection("search")}
              variant="ghost"
            >
              <SearchIcon data-icon="inline-start" />
              自然语言检索
            </Button>
            <Button
              className={cn(
                "h-9 justify-start rounded-lg px-2 text-[15px] text-sidebar-foreground hover:text-sidebar-foreground",
                activeResearchSection === "tracking" &&
                  "bg-sidebar-selected",
              )}
              onClick={() => onSelectResearchSection("tracking")}
              variant="ghost"
            >
              <RadarIcon data-icon="inline-start" />
              科研追踪
            </Button>
          </>
        ) : (
          <Button
            className="h-9 justify-start rounded-lg px-2 text-[15px] text-sidebar-foreground hover:text-sidebar-foreground"
            disabled={!activeProject}
            onClick={onOpenGit}
            variant="ghost"
          >
            <GitPullRequestIcon data-icon="inline-start" />
            Git 工作区
          </Button>
        )}
        <Button
          className={cn(
            "h-9 justify-start rounded-lg px-2 text-[15px] text-sidebar-foreground hover:text-sidebar-foreground",
            workspaceMode === "research" &&
              activeResearchSection === "skills" &&
              "bg-sidebar-selected",
          )}
          onClick={onOpenExtensions}
          variant="ghost"
        >
          <BlocksIcon data-icon="inline-start" />
          扩展
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
              {([
                ["knowledge", BrainCircuitIcon, "知识资产"],
                ["library", LibraryIcon, "文献库"],
                ["experiments", FlaskConicalIcon, "实验资源"],
                ["sandbox", BeakerIcon, "研究沙盒"],
              ] as const).map(([section, Icon, label]) => (
                <Button
                  className={cn(
                    "h-9 justify-start rounded-lg px-2 text-[15px] text-sidebar-foreground hover:text-sidebar-foreground",
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
        <p
          className={cn(
            "px-3 pb-1.5 font-medium text-sidebar-foreground text-xs uppercase tracking-wide",
            workspaceMode === "research" && "mt-5",
          )}
        >
          项目
        </p>
        <nav
          aria-label="项目和任务"
          className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1 pb-2"
        >
          {visibleProjects.map(({ project, sessions }, projectIndex) => {
            const active = project.id === activeProject?.id;
            const expanded =
              Boolean(normalizedQuery) ||
              expandedProjectIds.has(project.id);
            return (
              <Collapsible
                className="motion-list-item"
                key={project.id}
                onOpenChange={(open) => {
                  setExpandedProjectIds((current) => {
                    const next = new Set(current);
                    if (open) {
                      next.add(project.id);
                    } else {
                      next.delete(project.id);
                    }
                    return next;
                  });
                }}
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
                      aria-label={`${expanded ? "收起" : "展开"}项目 ${project.name}`}
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-left text-[15px]"
                      title={project.path}
                      type="button"
                    >
                      <ChevronRightIcon
                        className={cn(
                          "motion-collapsible-chevron size-3.5 shrink-0 text-muted-foreground/70",
                          expanded && "rotate-90",
                        )}
                      />
                      <FolderOpenIcon className="size-4 shrink-0" />
                      <span className="truncate">{project.name}</span>
                    </button>
                  </CollapsibleTrigger>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label={`${project.name}的操作`}
                        className="opacity-0 group-hover/project:opacity-100 focus:opacity-100"
                        size="icon-sm"
                        variant="ghost"
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem
                        onSelect={() => onSelectProject(project)}
                      >
                        <FolderOpenIcon />
                        切换到项目
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onNewSession(project)}
                      >
                        <SquarePenIcon />
                        {workspaceMode === "research"
                          ? "在此项目新建研究任务"
                          : "在此项目新建任务"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    aria-label={`在 ${project.name} 中新建${
                      workspaceMode === "research" ? "研究任务" : "任务"
                    }`}
                    disabled={loading}
                    onClick={() => onNewSession(project)}
                    size="icon-sm"
                    title={
                      workspaceMode === "research"
                        ? "在此项目新建研究任务"
                        : "在此项目新建任务"
                    }
                    variant="ghost"
                  >
                    <SquarePenIcon />
                  </Button>
                </div>

                <CollapsibleContent className="motion-collapsible-content">
                  <div className="flex flex-col gap-0 pl-6">
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
                                onSelect={() => setPendingDelete(session)}
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
                        {normalizedQuery
                          ? "没有匹配的任务"
                          : "暂无任务"}
                      </p>
                    ) : null}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {!loading && visibleProjects.length === 0 ? (
            <p className="px-3 py-4 text-center text-sidebar-foreground text-xs">
              {normalizedQuery ? "没有匹配的项目" : "暂无项目"}
            </p>
          ) : null}
        </nav>
      </div>

      <div className="border-t px-1 pt-1.5">
        <Button
          className={cn(
            "h-9 w-full justify-start rounded-lg px-2 text-sidebar-foreground hover:text-sidebar-foreground",
            settingsActive &&
              "bg-sidebar-selected hover:bg-sidebar-selected",
          )}
          onClick={onOpenSettings}
          variant="ghost"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-violet-100 font-medium text-violet-600 text-xs">
            M
          </span>
          <span className="min-w-0 flex-1 truncate text-left">设置</span>
          <SettingsIcon className="size-4 text-muted-foreground" />
        </Button>
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(undefined);
          }
        }}
        open={Boolean(pendingDelete)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除任务？</DialogTitle>
            <DialogDescription>
              “{pendingDelete
                ? localizedSessionTitle(pendingDelete.title)
                : ""}”及其本地对话记录将被永久删除，工作区文件不会受到影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button
              onClick={() => {
                if (pendingDelete) {
                  onDeleteSession(pendingDelete);
                  setPendingDelete(undefined);
                }
              }}
              variant="destructive"
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemax={420}
        aria-valuemin={224}
        aria-valuenow={Math.round(sidebarWidth)}
        className="group absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize touch-none outline-none"
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
