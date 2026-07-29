import {
  DownloadIcon,
  GitCompareArrowsIcon,
  PanelRightIcon,
} from "lucide-react";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEventHandler,
} from "react";

import { Button } from "@/components/ui/button";
import { Presence } from "@/components/ui/presence";
import type { AgentSubagent } from "@/domain/acp";
import { AppSidebar } from "@/features/sessions/app-sidebar";
import { WindowNavigationControls } from "@/features/sessions/window-navigation-controls";
import {
  SettingsWorkspace,
  type SettingsPage,
} from "@/features/settings/settings-workspace";
import {
  WorkspaceSidePanel,
  type WorkspaceTab,
} from "@/features/workspace/workspace-side-panel";
import type { ProjectReference } from "@/domain/message-citations";
import { useAgentBridge } from "@/hooks/use-agent-bridge";
import { useAppearanceSettings } from "@/hooks/use-appearance-settings";
import { useGitChanges } from "@/hooks/use-git-changes";
import { useSessionPersistence } from "@/hooks/use-session-persistence";
import { useWorkspace } from "@/hooks/use-workspace";
import { useAgentStore } from "@/stores/agent-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  checkAppUpdate,
  type AppUpdateStatus,
} from "@/lib/melody-bridge";
import { localizedSessionTitle } from "@/lib/localize";
import { cn } from "@/lib/utils";

import { AgentComposer } from "./agent-composer";
import { AgentTimeline } from "./agent-timeline";
import { SubagentTray } from "./subagent-tray";

const statusLabel = {
  stopped: "预览",
  starting: "正在启动",
  running: "已连接",
  missing: "未找到内置服务",
  failed: "连接错误",
} as const;

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 224;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STORAGE_KEY = "melodywork.sidebar.width";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "melodywork.sidebar.collapsed";
const DEFAULT_WORKSPACE_PANEL_WIDTH = 560;
const MIN_WORKSPACE_PANEL_WIDTH = 360;
const MAX_WORKSPACE_PANEL_WIDTH = 960;
const WORKSPACE_PANEL_WIDTH_STORAGE_KEY =
  "melodywork.workspace-panel.width";

const isMacOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

const storedSidebarWidth = () => {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  const stored = Number(
    window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY),
  );
  return Number.isFinite(stored)
    ? Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, stored),
      )
    : DEFAULT_SIDEBAR_WIDTH;
};

const storedSidebarCollapsed = () =>
  typeof window !== "undefined" &&
  window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";

const maxWorkspacePanelWidth = () =>
  typeof window === "undefined"
    ? MAX_WORKSPACE_PANEL_WIDTH
    : Math.max(
        MIN_WORKSPACE_PANEL_WIDTH,
        Math.min(MAX_WORKSPACE_PANEL_WIDTH, window.innerWidth * 0.65),
      );

const storedWorkspacePanelWidth = () => {
  if (typeof window === "undefined") {
    return DEFAULT_WORKSPACE_PANEL_WIDTH;
  }
  const stored = Number(
    window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_STORAGE_KEY),
  );
  return Number.isFinite(stored)
    ? Math.min(
        maxWorkspacePanelWidth(),
        Math.max(MIN_WORKSPACE_PANEL_WIDTH, stored),
      )
    : Math.min(DEFAULT_WORKSPACE_PANEL_WIDTH, maxWorkspacePanelWidth());
};

interface SessionNavigationHistory {
  entries: string[];
  index: number;
}

const subagentsForSession = (
  subagents: Record<string, AgentSubagent>,
  rootSessionId?: string,
) => {
  if (!rootSessionId) {
    return [];
  }
  const descendants: AgentSubagent[] = [];
  const pending = [rootSessionId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const parentSessionId = pending.shift();
    if (!parentSessionId || visited.has(parentSessionId)) {
      continue;
    }
    visited.add(parentSessionId);
    for (const subagent of Object.values(subagents)) {
      if (subagent.parentSessionId === parentSessionId) {
        descendants.push(subagent);
        pending.push(subagent.childSessionId);
      }
    }
  }
  return descendants.sort(
    (left, right) =>
      Number(left.status !== "running") -
        Number(right.status !== "running") ||
      right.updatedAt - left.updatedAt,
  );
};

const sessionStatusLabel = (
  agentPhase: keyof typeof statusLabel,
  sessionPhase: ReturnType<typeof useAgentStore.getState>["acpPhase"],
) => {
  if (agentPhase !== "running") {
    return statusLabel[agentPhase];
  }
  if (
    sessionPhase === "initializing" ||
    sessionPhase === "authenticating" ||
    sessionPhase === "creating"
  ) {
    return "正在启动会话";
  }
  if (sessionPhase === "prompting") {
    return "处理中";
  }
  return sessionPhase === "ready" ? "已连接" : statusLabel.running;
};

export function AgentWorkspace() {
  useAppearanceSettings();
  useWorkspace();

  const projects = useWorkspaceStore((state) => state.projects);
  const sessionsByProject = useWorkspaceStore(
    (state) => state.sessionsByProject,
  );
  const activeProject = useWorkspaceStore((state) => state.activeProject);
  const activeSession = useWorkspaceStore((state) => state.activeSession);
  const workspaceLoading = useWorkspaceStore((state) => state.loading);
  const workspaceError = useWorkspaceStore((state) => state.error);
  const chooseProject = useWorkspaceStore((state) => state.chooseProject);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const createSession = useWorkspaceStore((state) => state.createSession);
  const deleteSession = useWorkspaceStore((state) => state.deleteSession);
  const selectSession = useWorkspaceStore((state) => state.selectSession);

  useAgentBridge(activeSession);
  useSessionPersistence();

  const cwd = activeSession?.cwd ?? activeProject?.path ?? ".";
  const status = useAgentStore((state) => state.status);
  const acpPhase = useAgentStore((state) => state.acpPhase);
  const acpSessionId = useAgentStore((state) => state.acpSessionId);
  const timeline = useAgentStore((state) => state.timeline);
  const chatStatus = useAgentStore((state) => state.chatStatus);
  const contextUsage = useAgentStore((state) => state.contextUsage);
  const availableModels = useAgentStore((state) => state.availableModels);
  const selectedModelId = useAgentStore((state) => state.selectedModelId);
  const pendingModelId = useAgentStore((state) => state.pendingModelId);
  const selectedReasoningEffort = useAgentStore(
    (state) => state.selectedReasoningEffort,
  );
  const pendingReasoningEffort = useAgentStore(
    (state) => state.pendingReasoningEffort,
  );
  const availableSessionModes = useAgentStore(
    (state) => state.availableSessionModes,
  );
  const selectedSessionModeId = useAgentStore(
    (state) => state.selectedSessionModeId,
  );
  const pendingSessionModeId = useAgentStore(
    (state) => state.pendingSessionModeId,
  );
  const permissionMode = useAgentStore((state) => state.permissionMode);
  const runningSessions = useAgentStore((state) => state.runningSessions);
  const subagents = useAgentStore((state) => state.subagents);
  const submitPrompt = useAgentStore((state) => state.submitPrompt);
  const selectModel = useAgentStore((state) => state.selectModel);
  const selectReasoningEffort = useAgentStore(
    (state) => state.selectReasoningEffort,
  );
  const selectSessionMode = useAgentStore(
    (state) => state.selectSessionMode,
  );
  const selectPermissionMode = useAgentStore(
    (state) => state.selectPermissionMode,
  );
  const resolvePermission = useAgentStore(
    (state) => state.resolvePermission,
  );
  const resolvePlan = useAgentStore((state) => state.resolvePlan);
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([]);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] =
    useState<string>();
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(
    storedWorkspacePanelWidth,
  );
  const workspacePanelWidthRef = useRef(workspacePanelWidth);
  const workspaceTabSequence = useRef(0);
  const [workspacePanelResize, setWorkspacePanelResize] = useState<{
    startWidth: number;
    startX: number;
  }>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] =
    useState<SettingsPage>("configuration");
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus>();
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const sidebarWidthRef = useRef(sidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    storedSidebarCollapsed,
  );
  const [sidebarResize, setSidebarResize] = useState<{
    startWidth: number;
    startX: number;
  }>();
  const [sessionNavigation, setSessionNavigation] =
    useState<SessionNavigationHistory>({
      entries: [],
      index: -1,
    });
  const historyTraversalTarget = useRef<string | undefined>(undefined);
  const git = useGitChanges(cwd);
  const agentError =
    acpPhase === "error" ||
    status.phase === "missing" ||
    status.phase === "failed"
      ? status.message
      : undefined;
  const visibleError = workspaceError ?? agentError;
  const visibleSubagents = useMemo(
    () => subagentsForSession(subagents, acpSessionId),
    [subagents, acpSessionId],
  );

  useEffect(() => {
    void checkAppUpdate()
      .then(setAppUpdate)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const sessionId = activeSession?.id;
    if (!sessionId) {
      return;
    }

    if (historyTraversalTarget.current === sessionId) {
      historyTraversalTarget.current = undefined;
      return;
    }

    setSessionNavigation((current) => {
      if (current.entries[current.index] === sessionId) {
        return current;
      }
      return {
        entries: [
          ...current.entries.slice(0, current.index + 1),
          sessionId,
        ],
        index: current.index + 1,
      };
    });
  }, [activeSession?.id]);

  useEffect(() => {
    if (!sidebarResize) {
      return;
    }

    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect =
      document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";

    const handlePointerMove = (event: PointerEvent) => {
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(
          MIN_SIDEBAR_WIDTH,
          sidebarResize.startWidth +
            event.clientX -
            sidebarResize.startX,
        ),
      );
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth(nextWidth);
    };
    const handlePointerUp = () => {
      window.localStorage.setItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
        String(Math.round(sidebarWidthRef.current)),
      );
      setSidebarResize(undefined);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, {
      once: true,
    });

    return () => {
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [sidebarResize]);

  useEffect(() => {
    if (!workspacePanelResize) {
      return;
    }

    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect =
      document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";

    const handlePointerMove = (event: PointerEvent) => {
      const nextWidth = Math.min(
        maxWorkspacePanelWidth(),
        Math.max(
          MIN_WORKSPACE_PANEL_WIDTH,
          workspacePanelResize.startWidth +
            workspacePanelResize.startX -
            event.clientX,
        ),
      );
      workspacePanelWidthRef.current = nextWidth;
      setWorkspacePanelWidth(nextWidth);
    };
    const handlePointerUp = () => {
      window.localStorage.setItem(
        WORKSPACE_PANEL_WIDTH_STORAGE_KEY,
        String(Math.round(workspacePanelWidthRef.current)),
      );
      setWorkspacePanelResize(undefined);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, {
      once: true,
    });

    return () => {
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [workspacePanelResize]);

  const installAppUpdate = async () => {
    setInstallingUpdate(true);
    try {
      setAppUpdate(await checkAppUpdate(true));
    } finally {
      setInstallingUpdate(false);
    }
  };

  const openSettings = (page: SettingsPage = "configuration") => {
    setWorkspacePanelOpen(false);
    setWorkspaceTabs([]);
    setActiveWorkspaceTabId(undefined);
    setSettingsPage(page);
    setSettingsOpen(true);
  };

  const openWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    setSettingsOpen(false);
    setWorkspacePanelOpen(true);
    setWorkspaceTabs((current) =>
      current.some((item) => item.id === tab.id)
        ? current
        : [...current, tab],
    );
    setActiveWorkspaceTabId(tab.id);
  }, []);

  const openGit = () =>
    openWorkspaceTab({ id: "review", kind: "review", label: "审阅" });

  const openProjectReference = useCallback(
    (reference: ProjectReference) => {
      if (reference.kind === "folder") {
        openWorkspaceTab({ id: "files", kind: "files", label: "文件" });
        return;
      }
      const path = reference.displayPath;
      openWorkspaceTab({
        id: `file:${path}`,
        kind: "file",
        label: path.split("/").at(-1) ?? path,
        path,
      });
    },
    [openWorkspaceTab],
  );

  const openFilePreview = useCallback(
    (path: string) =>
      openWorkspaceTab({
        id: `file:${path}`,
        kind: "file",
        label: path.split("/").at(-1) ?? path,
        path,
      }),
    [openWorkspaceTab],
  );

  const openSubagent = useCallback(
    (subagent: AgentSubagent) =>
      openWorkspaceTab({
        id: `subagent:${subagent.subagentId}`,
        kind: "subagent",
        label: subagent.description,
        subagentId: subagent.subagentId,
        childSessionId: subagent.childSessionId,
      }),
    [openWorkspaceTab],
  );

  const newWorkspaceToolTab = (
    kind: "files" | "terminal" | "review",
  ) => {
    const baseLabel = {
      files: "文件",
      terminal: "终端",
      review: "审阅",
    }[kind];
    const matchingTabs = workspaceTabs.filter(
      (tab) => tab.kind === kind,
    ).length;
    workspaceTabSequence.current += 1;
    const label =
      matchingTabs === 0 ? baseLabel : `${baseLabel} ${matchingTabs + 1}`;
    const id = `${kind}:new:${workspaceTabSequence.current}`;
    const tab: WorkspaceTab =
      kind === "files"
        ? { id, kind: "files", label }
        : kind === "terminal"
          ? { id, kind: "terminal", label }
          : { id, kind: "review", label };
    openWorkspaceTab(tab);
  };

  const closeWorkspaceTab = (tabId: string) => {
    setWorkspaceTabs((current) => {
      const closingIndex = current.findIndex((tab) => tab.id === tabId);
      const nextTabs = current.filter((tab) => tab.id !== tabId);
      if (activeWorkspaceTabId === tabId) {
        const nextActive =
          nextTabs[Math.min(closingIndex, nextTabs.length - 1)]?.id;
        setActiveWorkspaceTabId(nextActive);
      }
      return nextTabs;
    });
  };

  const updateWorkspacePanelWidth = (nextWidth: number) => {
    const clampedWidth = Math.min(
      maxWorkspacePanelWidth(),
      Math.max(MIN_WORKSPACE_PANEL_WIDTH, nextWidth),
    );
    workspacePanelWidthRef.current = clampedWidth;
    setWorkspacePanelWidth(clampedWidth);
    window.localStorage.setItem(
      WORKSPACE_PANEL_WIDTH_STORAGE_KEY,
      String(Math.round(clampedWidth)),
    );
  };

  const beginWorkspacePanelResize: PointerEventHandler<HTMLDivElement> = (
    event,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    setWorkspacePanelResize({
      startWidth: workspacePanelWidthRef.current,
      startX: event.clientX,
    });
  };

  const returnToConversation = () => {
    setSettingsOpen(false);
  };

  const updateSidebarWidth = (nextWidth: number) => {
    const clampedWidth = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, nextWidth),
    );
    sidebarWidthRef.current = clampedWidth;
    setSidebarWidth(clampedWidth);
    window.localStorage.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(Math.round(clampedWidth)),
    );
  };

  const beginSidebarResize: PointerEventHandler<HTMLDivElement> = (
    event,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    setSidebarResize({
      startWidth: sidebarWidthRef.current,
      startX: event.clientX,
    });
  };

  const setSidebarVisibility = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      String(collapsed),
    );
  };

  const findSessionById = (sessionId: string) => {
    for (const sessions of Object.values(sessionsByProject)) {
      const session = sessions.find((item) => item.id === sessionId);
      if (session) {
        return session;
      }
    }
    return undefined;
  };

  const nextHistoryIndex = (direction: -1 | 1) => {
    for (
      let index = sessionNavigation.index + direction;
      index >= 0 && index < sessionNavigation.entries.length;
      index += direction
    ) {
      if (findSessionById(sessionNavigation.entries[index])) {
        return index;
      }
    }
    return undefined;
  };

  const goThroughSessionHistory = (direction: -1 | 1) => {
    const targetIndex = nextHistoryIndex(direction);
    if (targetIndex === undefined) {
      return;
    }
    const sessionId = sessionNavigation.entries[targetIndex];
    const session = findSessionById(sessionId);
    if (!session) {
      return;
    }
    historyTraversalTarget.current = sessionId;
    setSessionNavigation((current) => ({
      ...current,
      index: targetIndex,
    }));
    returnToConversation();
    setWorkspaceTabs([]);
    setActiveWorkspaceTabId(undefined);
    setWorkspacePanelOpen(false);
    selectSession(session);
  };

  const canGoBack = nextHistoryIndex(-1) !== undefined;
  const canGoForward = nextHistoryIndex(1) !== undefined;

  return (
    <main className="relative flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
      {!settingsOpen ? (
        <WindowNavigationControls
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          className="absolute top-0 left-0 z-50"
          collapsed={sidebarCollapsed}
          macSafeArea={isMacOS}
          onGoBack={() => goThroughSessionHistory(-1)}
          onGoForward={() => goThroughSessionHistory(1)}
          onToggleSidebar={() =>
            setSidebarVisibility(!sidebarCollapsed)
          }
        />
      ) : null}
      <div
        aria-hidden={sidebarCollapsed || settingsOpen}
        className="sidebar-shell"
        data-collapsed={sidebarCollapsed || settingsOpen}
        data-resizing={Boolean(sidebarResize)}
        inert={sidebarCollapsed || settingsOpen}
        style={{
          width: sidebarCollapsed || settingsOpen ? 0 : sidebarWidth,
        }}
      >
        <AppSidebar
          activeProject={activeProject}
          activeSessionId={settingsOpen ? undefined : activeSession?.id}
          loading={workspaceLoading}
          onChooseProject={() => {
            returnToConversation();
            void chooseProject();
          }}
          onDeleteSession={(session) => void deleteSession(session)}
          onNewSession={(project) => {
            returnToConversation();
            void createSession(project);
          }}
          onOpenExtensions={() => openSettings("skills")}
          onOpenGit={openGit}
          onOpenSettings={() => openSettings()}
          onResetWidth={() =>
            updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
          }
          onResizeBy={(delta) =>
            updateSidebarWidth(sidebarWidthRef.current + delta)
          }
          onResizeStart={beginSidebarResize}
          onSelectProject={(project) => {
            returnToConversation();
            void selectProject(project);
          }}
          onSelectSession={(session) => {
            returnToConversation();
            selectSession(session);
          }}
          projects={projects}
          runningSessions={runningSessions}
          settingsActive={settingsOpen}
          sessionsByProject={sessionsByProject}
          sidebarWidth={sidebarWidth}
        />
      </div>
      <section className="relative flex min-w-0 flex-1 flex-col">
        {settingsOpen ? (
          <SettingsWorkspace
            cwd={cwd}
            initialPage={settingsPage}
            macSafeArea={isMacOS}
            onClose={returnToConversation}
            projectId={activeProject?.id ?? "preview-project"}
          />
        ) : null}
        <div
          aria-hidden={settingsOpen}
          className={cn(
            "relative flex min-h-0 flex-1",
            settingsOpen && "hidden",
          )}
        >
          <div className="relative flex min-w-0 flex-1 flex-col">
            <header
              className={cn(
                "sidebar-aware-header flex h-8 shrink-0 items-center gap-3 border-b pr-6",
                sidebarCollapsed
                  ? isMacOS
                    ? "pl-52"
                    : "pl-32"
                  : "pl-6",
              )}
              data-tauri-drag-region
            >
              <div
                className="flex min-w-0 flex-1 items-center gap-2"
                data-tauri-drag-region
              >
                <h1
                  className="min-w-0 truncate font-semibold text-base"
                  data-tauri-drag-region
                >
                  {activeSession
                    ? localizedSessionTitle(activeSession.title)
                    : "正在打开工作区…"}
                </h1>
                <div
                  className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs"
                  data-tauri-drag-region
                >
                  <span
                    aria-hidden="true"
                    className="motion-status-dot size-1.5 rounded-full bg-current"
                    data-tauri-drag-region
                  />
                  {sessionStatusLabel(status.phase, acpPhase)}
                </div>
              </div>
              <Button
                aria-label={
                  git.loading
                    ? "正在检查更改"
                    : `${git.changes.length} 项更改`
                }
                className="gap-1 px-2"
                onClick={openGit}
                size="sm"
                title={
                  git.loading
                    ? "正在检查更改"
                    : `${git.changes.length} 项更改`
                }
                variant="outline"
              >
                <GitCompareArrowsIcon data-icon="inline-start" />
                <span className="min-w-2 text-center tabular-nums">
                  {git.loading ? "…" : git.changes.length}
                </span>
              </Button>
              {appUpdate?.available ? (
                <Button
                  className="motion-view-enter"
                  disabled={installingUpdate}
                  onClick={() => void installAppUpdate()}
                  variant="outline"
                >
                  <DownloadIcon />
                  {installingUpdate
                    ? "正在安装更新"
                    : `更新到 ${appUpdate.version}`}
                </Button>
              ) : null}
              <Button
                aria-label={
                  workspacePanelOpen ? "收起右侧边栏" : "展开右侧边栏"
                }
                aria-pressed={workspacePanelOpen}
                onClick={() => setWorkspacePanelOpen((open) => !open)}
                size="icon"
                title={
                  workspacePanelOpen ? "收起右侧边栏" : "展开右侧边栏"
                }
                variant={workspacePanelOpen ? "secondary" : "ghost"}
              >
                <span
                  className={cn(
                    "transition-transform duration-200 ease-out [&>svg]:size-4",
                    workspacePanelOpen && "-translate-x-0.5",
                  )}
                >
                  <PanelRightIcon />
                </span>
              </Button>
            </header>
            <Presence present={Boolean(visibleError)}>
              {(motionState) => (
                <div
                  aria-live="polite"
                  className="motion-banner border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
                  data-motion-state={motionState}
                  role="alert"
                >
                  {visibleError}
                </div>
              )}
            </Presence>

            <AgentTimeline
              cwd={cwd}
              entries={timeline}
              onPermission={resolvePermission}
              onPlanDecision={resolvePlan}
              onOpenProjectReference={openProjectReference}
              projectRoot={activeProject?.path ?? cwd}
            />
            <SubagentTray
              onOpenSubagent={openSubagent}
              subagents={visibleSubagents}
            />
            <AgentComposer
              contextUsage={contextUsage}
              modelChanging={Boolean(pendingModelId)}
              models={availableModels}
              onModelChange={(modelId) => void selectModel(modelId)}
              onPermissionModeChange={(mode) =>
                void selectPermissionMode(mode)
              }
              onReasoningEffortChange={(effort) =>
                void selectReasoningEffort(effort)
              }
              onSessionModeChange={(modeId) =>
                void selectSessionMode(modeId)
              }
              onSubmit={submitPrompt}
              permissionMode={permissionMode}
              reasoningEffortChanging={Boolean(pendingReasoningEffort)}
              sessionModeChanging={Boolean(pendingSessionModeId)}
              sessionModes={availableSessionModes}
              selectedModelId={selectedModelId}
              selectedReasoningEffort={selectedReasoningEffort}
              selectedSessionModeId={selectedSessionModeId}
              status={chatStatus}
            />
          </div>
          <div
            aria-hidden={!workspacePanelOpen}
            className="motion-workspace-layer h-full min-h-0 shrink-0"
            data-collapsed={!workspacePanelOpen}
            data-resizing={Boolean(workspacePanelResize)}
            inert={!workspacePanelOpen}
            style={
              {
                "--workspace-panel-width": `${workspacePanelWidth}px`,
                width: workspacePanelOpen ? workspacePanelWidth : 0,
              } as CSSProperties
            }
          >
            <WorkspaceSidePanel
              activeTabId={activeWorkspaceTabId}
              changes={git.changes}
              cwd={cwd}
              gitError={git.error}
              gitLoading={git.loading}
              onActivateTab={setActiveWorkspaceTabId}
              onCloseTab={closeWorkspaceTab}
              onNewTab={newWorkspaceToolTab}
              onOpenFile={openFilePreview}
              onOpenProjectReference={openProjectReference}
              onRefreshGit={() => void git.refresh()}
              onResetWidth={() =>
                updateWorkspacePanelWidth(DEFAULT_WORKSPACE_PANEL_WIDTH)
              }
              onResizeBy={(delta) =>
                updateWorkspacePanelWidth(
                  workspacePanelWidthRef.current + delta,
                )
              }
              onResizeStart={beginWorkspacePanelResize}
              root={activeProject?.path ?? cwd}
              subagents={subagents}
              tabs={workspaceTabs}
            />
          </div>
        </div>
      </section>
    </main>
  );
}
