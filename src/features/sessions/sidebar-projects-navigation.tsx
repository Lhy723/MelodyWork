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
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useId, useMemo, type ReactNode } from "react";

import {
  ContextMenu,
  type ContextMenuItem,
} from "@/components/interior/context-menu";
import { RippleLayer, useRipple } from "@/components/interior/ripple";
import { TreeView, type TreeNode } from "@/components/interior/tree-view";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
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

type SidebarTreeNode = TreeNode & {
  kind: "project" | "session" | "empty";
  project: ProjectRecord;
  session?: SessionRecord;
  children?: SidebarTreeNode[];
};

const TREE_SECTION_EASE = [0.23, 1, 0.32, 1] as const;

function SidebarTreeSectionContent({
  children,
  id,
  open,
}: {
  children: ReactNode;
  id: string;
  open: boolean;
}) {
  const reduced = useReducedMotion();
  const transition = reduced
    ? { duration: 0 }
    : {
        height: { duration: 0.28, ease: TREE_SECTION_EASE },
        opacity: { duration: 0.18, ease: TREE_SECTION_EASE },
        y: { duration: 0.28, ease: TREE_SECTION_EASE },
      };

  return (
    <motion.div
      aria-hidden={!open}
      animate={
        open
          ? { height: "auto", opacity: 1, y: 0 }
          : { height: 0, opacity: 0, y: -6 }
      }
      className={cn(
        "motion-tree-collapsible-content",
        !open && "pointer-events-none",
      )}
      id={id}
      inert={!open}
      initial={false}
      transition={transition}
    >
      {children}
    </motion.div>
  );
}

function SidebarTaskSectionHeader({
  active,
  contentId,
  loading,
  onNewSession,
  onSelectProject,
  open,
  project,
  workspaceMode,
}: {
  active: boolean;
  contentId: string;
  loading: boolean;
  onNewSession: (project?: ProjectRecord) => void;
  onSelectProject: (project: ProjectRecord) => void;
  open: boolean;
  project: ProjectRecord;
  workspaceMode: WorkspaceMode;
}) {
  const contextMenuItems: ContextMenuItem[] = [
    {
      id: "switch",
      icon: <MessageCircleIcon />,
      label: "切换到任务",
      onSelect: () => onSelectProject(project),
    },
    {
      id: "new-session",
      disabled: project.archived,
      icon: <SquarePenIcon />,
      label:
        workspaceMode === "research"
          ? "在任务中新建研究任务"
          : "在任务中新建任务",
      onSelect: () => onNewSession(project),
    },
  ];

  return (
    <ContextMenu
      className="min-w-0 flex-1 rounded-lg"
      items={contextMenuItems}
      label="任务的操作"
    >
      <div
        className={cn(
          "group/section flex h-8 w-full items-center rounded-lg px-1 text-sidebar-foreground",
          active && "bg-sidebar-selected font-medium",
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            aria-controls={contentId}
            aria-expanded={open}
            aria-label={`${open ? "收起" : "展开"}任务`}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left font-medium text-base outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            onClick={() => onSelectProject(project)}
            type="button"
          >
            <ChevronRightIcon
              className={cn(
                "motion-collapsible-chevron size-3.5 shrink-0 text-muted-foreground/70",
                open && "rotate-90",
              )}
            />
            <MessageCircleIcon className="size-4 shrink-0" />
            <span className="truncate">任务</span>
          </button>
        </CollapsibleTrigger>
        <Button
          aria-label={
            workspaceMode === "research"
              ? "在任务中新建研究任务"
              : "在任务中新建任务"
          }
          disabled={loading || project.archived}
          onClick={(event) => {
            event.stopPropagation();
            onNewSession(project);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          size="icon-sm"
          title={
            workspaceMode === "research"
              ? "在任务中新建研究任务"
              : "在任务中新建任务"
          }
          variant="ghost"
        >
          <SquarePenIcon />
        </Button>
      </div>
    </ContextMenu>
  );
}

const projectNodeId = (projectId: string) => `project:${projectId}`;
const sessionNodeId = (sessionId: string) => `session:${sessionId}`;
const emptyNodeId = (projectId: string) => `empty:${projectId}`;

function buildProjectTreeNodes(
  entries: SidebarProjectEntry[],
  loading: boolean,
  normalizedQuery: string,
): SidebarTreeNode[] {
  return entries.map(({ project, sessions }) => {
    const independent = isIndependentProject(project);
    const children: SidebarTreeNode[] = sessions.map((session) => ({
      id: sessionNodeId(session.id),
      kind: "session",
      label: localizedSessionTitle(session.title),
      project,
      session,
      selectable: true,
    }));

    if (children.length === 0) {
      children.push({
        id: emptyNodeId(project.id),
        kind: "empty",
        label: loading
          ? "加载中…"
          : normalizedQuery
            ? "没有匹配的任务"
            : "暂无任务",
        project,
        selectable: false,
        disabled: true,
      });
    }

    return {
      id: projectNodeId(project.id),
      kind: "project",
      label: independent ? "任务" : project.name,
      icon: independent ? (
        <MessageCircleIcon className="size-4 shrink-0" />
      ) : (
        <FolderOpenIcon className="size-4 shrink-0" />
      ),
      project,
      selectable: true,
      children,
    };
  });
}

function collectNodes(
  nodes: SidebarTreeNode[],
  target: Map<string, SidebarTreeNode>,
) {
  nodes.forEach((node) => {
    target.set(node.id, node);
    collectNodes(node.children ?? [], target);
  });
}

function SidebarTreeNodeContent({
  activeProject,
  loading,
  node,
  onArchiveProject,
  onNewSession,
  onRequestDelete,
  onRequestDeleteProject,
  onRestoreProject,
  onSelectProject,
  runningSessions,
  selected,
  workspaceMode,
}: {
  activeProject?: ProjectRecord;
  loading: boolean;
  node: SidebarTreeNode;
  onArchiveProject: (project: ProjectRecord) => void;
  onNewSession: (project?: ProjectRecord) => void;
  onRequestDelete: (session: SessionRecord) => void;
  onRequestDeleteProject: (project: ProjectRecord) => void;
  onRestoreProject: (project: ProjectRecord) => void;
  onSelectProject: (project: ProjectRecord) => void;
  runningSessions: Record<string, boolean>;
  selected: boolean;
  workspaceMode: WorkspaceMode;
}) {
  const { bindings, fadeDuration, ripples } = useRipple({ max: 2 });
  const project = node.project;

  if (node.kind === "empty") {
    return (
      <span className="min-w-0 flex-1 truncate py-1 text-sidebar-foreground/60 text-xs">
        {node.label}
      </span>
    );
  }

  if (node.kind === "session" && node.session) {
    const session = node.session;
    const title = localizedSessionTitle(session.title);
    const running = runningSessions[session.id] === true;

    return (
      <div className="group/session flex min-w-0 flex-1 items-center rounded-md text-sm">
        <span
          className={cn(
            "relative isolate min-w-0 flex-1 truncate overflow-hidden rounded-md px-1.5 py-1 text-left",
            selected && "font-medium",
          )}
          style={{
            WebkitTapHighlightColor: "transparent",
            touchAction: "manipulation",
          }}
          title={title}
          {...bindings}
        >
          <RippleLayer fadeDuration={fadeDuration} ripples={ripples} />
          <span className="relative z-10 block truncate">{title}</span>
        </span>
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
                "shrink-0 opacity-0 transition-opacity group-hover/session:opacity-100 focus:opacity-100",
                selected && "group-hover/session:opacity-100",
              )}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
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

  const independent = isIndependentProject(project);
  const active = project.id === activeProject?.id;
  const label = independent ? "任务" : project.name;
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
    <ContextMenu
      className="min-w-0 flex-1 rounded-md"
      items={contextMenuItems}
      label={`${label}的操作`}
    >
      <div
        className={cn(
          "group/project flex min-w-0 flex-1 items-center rounded-md transition-colors",
          active
            ? "bg-sidebar-selected font-medium text-sidebar-foreground"
            : "text-sidebar-foreground",
        )}
      >
        <span
          className="relative isolate flex min-w-0 flex-1 items-center overflow-hidden rounded-md px-1 text-left text-base"
          style={{
            WebkitTapHighlightColor: "transparent",
            touchAction: "manipulation",
          }}
          title={independent ? "MelodyWork 的隔离任务目录" : project.path}
          {...bindings}
        >
          <RippleLayer fadeDuration={fadeDuration} ripples={ripples} />
          <span className="relative z-10 flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center"
            >
              {node.icon}
            </span>
            <span className="truncate">{label}</span>
          </span>
        </span>
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
            onClick={(event) => {
              event.stopPropagation();
              onNewSession(project);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
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
  );
}

function expandedProjectNodeIds(
  entries: SidebarProjectEntry[],
  expandedProjectIds: Set<string>,
  normalizedQuery: string,
) {
  return entries
    .filter(
      ({ project }) =>
        Boolean(normalizedQuery) || expandedProjectIds.has(project.id),
    )
    .map(({ project }) => projectNodeId(project.id));
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
  const projectNodes = useMemo(
    () => buildProjectTreeNodes(visibleProjects, loading, normalizedQuery),
    [loading, normalizedQuery, visibleProjects],
  );
  const archivedNodes = useMemo(
    () => buildProjectTreeNodes(archivedProjects, loading, normalizedQuery),
    [archivedProjects, loading, normalizedQuery],
  );
  const taskNodes = useMemo(
    () =>
      visibleTask
        ? buildProjectTreeNodes([visibleTask], loading, normalizedQuery)
        : [],
    [loading, normalizedQuery, visibleTask],
  );
  const taskSessionNodes = taskNodes[0]?.children ?? [];
  const nodeLookup = useMemo(() => {
    const lookup = new Map<string, SidebarTreeNode>();
    collectNodes(projectNodes, lookup);
    collectNodes(archivedNodes, lookup);
    collectNodes(taskNodes, lookup);
    return lookup;
  }, [archivedNodes, projectNodes, taskNodes]);
  const selectedNodeId = activeSessionId
    ? sessionNodeId(activeSessionId)
    : activeProject
      ? projectNodeId(activeProject.id)
      : null;

  const handleTreeSelection = useCallback(
    (nodeId: string) => {
      const node = nodeLookup.get(nodeId);
      if (!node) return;
      if (node.kind === "project") {
        onSelectProject(node.project);
      } else if (node.kind === "session" && node.session) {
        onSelectSession(node.session);
      }
    },
    [nodeLookup, onSelectProject, onSelectSession],
  );

  const handleProjectExpansion = useCallback(
    (next: string[], entries: SidebarProjectEntry[]) => {
      const nextSet = new Set(next);
      entries.forEach(({ project }) => {
        const open = nextSet.has(projectNodeId(project.id));
        if (open !== expandedProjectIds.has(project.id)) {
          onSetExpandedProject(project.id, open);
        }
      });
    },
    [expandedProjectIds, onSetExpandedProject],
  );

  const renderNode = useCallback(
    (node: TreeNode) => (
      <SidebarTreeNodeContent
        activeProject={activeProject}
        loading={loading}
        node={node as SidebarTreeNode}
        onArchiveProject={onArchiveProject}
        onNewSession={onNewSession}
        onRequestDelete={onRequestDelete}
        onRequestDeleteProject={onRequestDeleteProject}
        onRestoreProject={onRestoreProject}
        onSelectProject={onSelectProject}
        runningSessions={runningSessions}
        selected={selectedNodeId === node.id}
        workspaceMode={workspaceMode}
      />
    ),
    [
      activeProject,
      loading,
      onArchiveProject,
      onNewSession,
      onRequestDelete,
      onRequestDeleteProject,
      onRestoreProject,
      onSelectProject,
      runningSessions,
      selectedNodeId,
      workspaceMode,
    ],
  );

  const treeClassName = "rounded-none border-0 bg-transparent p-0 shadow-none";
  const treeSelectedClassName = "bg-sidebar-selected text-sidebar-foreground";
  const projectsContentId = useId();
  const archivedContentId = useId();
  const tasksContentId = useId();

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
              aria-controls={projectsContentId}
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
        <SidebarTreeSectionContent
          id={projectsContentId}
          open={projectsExpanded || Boolean(normalizedQuery)}
        >
          <nav aria-label="项目" className="px-1 pb-2">
            <TreeView
              className={treeClassName}
              expanded={expandedProjectNodeIds(
                visibleProjects,
                expandedProjectIds,
                normalizedQuery,
              )}
              label="项目与会话"
              nodes={projectNodes}
              onExpandedChange={(next) =>
                handleProjectExpansion(next, visibleProjects)
              }
              onSelectedChange={handleTreeSelection}
              renderNode={renderNode}
              selected={selectedNodeId}
              selectedClassName={treeSelectedClassName}
            />
            {!loading && visibleProjects.length === 0 ? (
              <p className="px-2 py-2 text-sidebar-foreground text-xs">
                {normalizedQuery ? "没有匹配的项目" : "暂无项目"}
              </p>
            ) : null}
          </nav>
        </SidebarTreeSectionContent>
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
                aria-controls={archivedContentId}
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
          <SidebarTreeSectionContent
            id={archivedContentId}
            open={archivedExpanded || Boolean(normalizedQuery)}
          >
            <nav aria-label="已归档项目" className="px-1 pb-2">
              <TreeView
                className={treeClassName}
                expanded={expandedProjectNodeIds(
                  archivedProjects,
                  expandedProjectIds,
                  normalizedQuery,
                )}
                label="已归档项目与会话"
                nodes={archivedNodes}
                onExpandedChange={(next) =>
                  handleProjectExpansion(next, archivedProjects)
                }
                onSelectedChange={handleTreeSelection}
                renderNode={renderNode}
                selected={selectedNodeId}
                selectedClassName={treeSelectedClassName}
              />
            </nav>
          </SidebarTreeSectionContent>
        </Collapsible>
      ) : null}

      {visibleTask ? (
        <Collapsible
          className="mt-3 shrink-0"
          onOpenChange={onSetTasksExpanded}
          open={tasksExpanded || Boolean(normalizedQuery)}
        >
          <SidebarTaskSectionHeader
            active={activeProject?.id === visibleTask.project.id}
            contentId={tasksContentId}
            loading={loading}
            onNewSession={onNewSession}
            onSelectProject={onSelectProject}
            open={tasksExpanded || Boolean(normalizedQuery)}
            project={visibleTask.project}
            workspaceMode={workspaceMode}
          />
          <SidebarTreeSectionContent
            id={tasksContentId}
            open={tasksExpanded || Boolean(normalizedQuery)}
          >
            <nav aria-label="任务" className="px-1 pb-2">
              <TreeView
                className={cn(
                  treeClassName,
                  "ml-[15px] border-l border-border/70 pl-1.5",
                )}
                label="任务会话"
                nodes={taskSessionNodes}
                onSelectedChange={handleTreeSelection}
                renderNode={renderNode}
                selected={selectedNodeId}
                selectedClassName={treeSelectedClassName}
              />
            </nav>
          </SidebarTreeSectionContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
