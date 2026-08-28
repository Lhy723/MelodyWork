import {
  DownloadIcon,
  GitCompareArrowsIcon,
  ListFilterIcon,
  PanelRightIcon,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEventHandler,
} from "react";

import { MotionPage } from "@/components/motion/page-transition";
import { Button } from "@/components/ui/button";
import { Presence } from "@/components/ui/presence";
import type { AgentPromptAttachment, AgentSubagent } from "@/domain/acp";
import type { ResearchPaper } from "@/domain/research";
import { TaskLauncher } from "@/domain/task-launch";
import {
  AppSidebar,
  type ResearchSection,
  type WorkspaceMode,
} from "@/features/sessions/app-sidebar";
import { WindowNavigationControls } from "@/features/sessions/window-navigation-controls";
import {
  ResearchMainWorkspace,
  type ResearchMainDetail,
} from "@/features/research/research-main-workspace";
import {
  SettingsWorkspace,
  type SettingsPage,
} from "@/features/settings/settings-workspace";
import {
  WorkspaceSidePanel,
  type WorkspaceTab,
} from "@/features/workspace/workspace-side-panel";
import type { ProjectReference } from "@/domain/message-citations";
import { isIndependentProject } from "@/domain/workspace";
import { useAgentBridge } from "@/hooks/use-agent-bridge";
import { useAgentNotifications } from "@/hooks/use-agent-notifications";
import { useAppearanceSettings } from "@/hooks/use-appearance-settings";
import { useGitChanges } from "@/hooks/use-git-changes";
import { useSessionPersistence } from "@/hooks/use-session-persistence";
import { useWorkspace } from "@/hooks/use-workspace";
import { useAgentStore } from "@/stores/agent-store";
import { useResearchStore } from "@/features/research/research-store";
import { buildResearchSkillContext } from "@/features/research/research-capability-store";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  checkAppUpdate,
  isTauriRuntime,
  openFileWithPreferredApp,
  type AppUpdateStatus,
} from "@/lib/melody-bridge";
import { localizedSessionTitle } from "@/lib/localize";
import { cn } from "@/lib/utils";

import { AgentComposer } from "./agent-composer";
import { AgentTimeline } from "./agent-timeline";
import { NewTaskWorkspace } from "./new-task-workspace";
import { SubagentTray } from "./subagent-tray";
import { SessionStatsLine } from "./session-stats-line";
import { TrajectoryView } from "./trajectory-view";

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
const WORKSPACE_PANEL_WIDTH_STORAGE_KEY = "melodywork.workspace-panel.width";
const WORKSPACE_MODE_STORAGE_KEY = "melodywork.workspace-mode";
const DEFAULT_CHAT_DOCK_SPACE = 168;
const SESSION_INFO_MOTION_MS = 220;

const isMacOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

const isAbsoluteWorkspacePath = (path: string) =>
  path.startsWith("/") || /^\\\\/u.test(path) || /^[A-Za-z]:[\\/]/u.test(path);

const resolveWorkspacePath = (root: string, path: string) => {
  if (isAbsoluteWorkspacePath(path) || root === ".") {
    return path;
  }
  const separator = root.includes("\\") ? "\\" : "/";
  const normalizedRoot = root.replace(/[\\/]+$/u, "");
  const normalizedPath = path
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replaceAll("/", separator);
  return `${normalizedRoot}${separator}${normalizedPath}`;
};

const storedSidebarWidth = () => {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, stored))
    : DEFAULT_SIDEBAR_WIDTH;
};

const storedSidebarCollapsed = () =>
  typeof window !== "undefined" &&
  window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";

const storedWorkspaceMode = (): WorkspaceMode =>
  typeof window !== "undefined" &&
  window.localStorage.getItem(WORKSPACE_MODE_STORAGE_KEY) === "research"
    ? "research"
    : "work";

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
      Number(left.status !== "running") - Number(right.status !== "running") ||
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
  useAgentNotifications();
  useWorkspace();

  const projects = useWorkspaceStore((state) => state.projects);
  const sessionsByProject = useWorkspaceStore(
    (state) => state.sessionsByProject,
  );
  const activeProject = useWorkspaceStore((state) => state.activeProject);
  const activeSession = useWorkspaceStore((state) => state.activeSession);
  const workspaceLoading = useWorkspaceStore((state) => state.loading);
  const workspaceError = useWorkspaceStore((state) => state.error);
  const addProject = useWorkspaceStore((state) => state.addProject);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const createSession = useWorkspaceStore((state) => state.createSession);
  const deleteSession = useWorkspaceStore((state) => state.deleteSession);
  const selectSession = useWorkspaceStore((state) => state.selectSession);
  const setResearchActiveProject = useResearchStore(
    (state) => state.setActiveProject,
  );

  useAgentBridge(activeSession);
  useSessionPersistence();

  const cwd = activeSession?.cwd ?? activeProject?.path ?? ".";
  const status = useAgentStore((state) => state.status);
  const acpPhase = useAgentStore((state) => state.acpPhase);
  const acpSessionId = useAgentStore((state) => state.acpSessionId);
  const timeline = useAgentStore((state) => state.timeline);
  const chatStatus = useAgentStore((state) => state.chatStatus);
  const agentLocalSessionId = useAgentStore((state) => state.localSessionId);
  const contextUsage = useAgentStore((state) => state.contextUsage);
  const availableModels = useAgentStore((state) => state.availableModels);
  const autoCheckForUpdates = useAppSettingsStore(
    (state) => state.autoCheckForUpdates,
  );
  const updateChannel = useAppSettingsStore((state) => state.updateChannel);
  const defaultFileOpener = useAppSettingsStore(
    (state) => state.defaultFileOpener,
  );
  const defaultIndependentChat = useAppSettingsStore(
    (state) => state.defaultIndependentChat,
  );
  const translucentSidebar = useAppSettingsStore(
    (state) => state.translucentSidebar,
  );
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
  const cancelPrompt = useAgentStore((state) => state.cancelPrompt);
  const submitPrompt = useAgentStore((state) => state.submitPrompt);
  const selectModel = useAgentStore((state) => state.selectModel);
  const selectReasoningEffort = useAgentStore(
    (state) => state.selectReasoningEffort,
  );
  const selectSessionMode = useAgentStore((state) => state.selectSessionMode);
  const selectPermissionMode = useAgentStore(
    (state) => state.selectPermissionMode,
  );
  const resolvePermission = useAgentStore((state) => state.resolvePermission);
  const resolveQuestion = useAgentStore((state) => state.resolveQuestion);
  const resolvePlan = useAgentStore((state) => state.resolvePlan);
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([]);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(true);
  const [sessionInfoLayoutOpen, setSessionInfoLayoutOpen] = useState(true);
  const [sessionInfoSurfaceOpen, setSessionInfoSurfaceOpen] = useState(true);
  const sessionInfoCloseTimerRef = useRef<number | undefined>(undefined);
  const sessionInfoOpenFrameRef = useRef<number | undefined>(undefined);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState<string>();
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(
    storedWorkspacePanelWidth,
  );
  const workspacePanelWidthRef = useRef(workspacePanelWidth);
  const workspaceTabSequence = useRef(0);
  const [workspacePanelResize, setWorkspacePanelResize] = useState<{
    startWidth: number;
    startX: number;
  }>();
  const [chatDockSpace, setChatDockSpace] = useState(DEFAULT_CHAT_DOCK_SPACE);
  const chatDockRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] =
    useState<WorkspaceMode>(storedWorkspaceMode);
  const [researchSection, setResearchSection] =
    useState<ResearchSection>("overview");
  const [researchDetail, setResearchDetail] = useState<ResearchMainDetail>();
  const [researchMainOpen, setResearchMainOpen] = useState(
    () => storedWorkspaceMode() === "research",
  );
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [conversationView, setConversationView] = useState<
    "chat" | "trajectory"
  >("chat");
  const [newTaskProjectId, setNewTaskProjectId] = useState<string>();
  const taskLauncherRef = useRef(new TaskLauncher());
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
  const sessionIsActive =
    status.phase === "starting" ||
    status.phase === "running" ||
    acpPhase === "initializing" ||
    acpPhase === "authenticating" ||
    acpPhase === "creating" ||
    acpPhase === "prompting";

  const toggleSessionInfo = useCallback(() => {
    if (sessionInfoCloseTimerRef.current !== undefined) {
      window.clearTimeout(sessionInfoCloseTimerRef.current);
      sessionInfoCloseTimerRef.current = undefined;
    }
    if (sessionInfoOpenFrameRef.current !== undefined) {
      window.cancelAnimationFrame(sessionInfoOpenFrameRef.current);
      sessionInfoOpenFrameRef.current = undefined;
    }

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (sessionInfoOpen) {
      setSessionInfoOpen(false);
      setSessionInfoSurfaceOpen(false);
      if (reduceMotion) {
        setSessionInfoLayoutOpen(false);
      } else {
        sessionInfoCloseTimerRef.current = window.setTimeout(() => {
          setSessionInfoLayoutOpen(false);
          sessionInfoCloseTimerRef.current = undefined;
        }, SESSION_INFO_MOTION_MS);
      }
      return;
    }

    setSessionInfoLayoutOpen(true);
    setSessionInfoOpen(true);
    setSessionInfoSurfaceOpen(false);
    if (reduceMotion) {
      setSessionInfoSurfaceOpen(true);
      return;
    }

    sessionInfoOpenFrameRef.current = window.requestAnimationFrame(() => {
      sessionInfoOpenFrameRef.current = window.requestAnimationFrame(() => {
        setSessionInfoSurfaceOpen(true);
        sessionInfoOpenFrameRef.current = undefined;
      });
    });
  }, [sessionInfoOpen]);

  useEffect(() => {
    return () => {
      if (sessionInfoCloseTimerRef.current !== undefined) {
        window.clearTimeout(sessionInfoCloseTimerRef.current);
      }
      if (sessionInfoOpenFrameRef.current !== undefined) {
        window.cancelAnimationFrame(sessionInfoOpenFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!autoCheckForUpdates) {
      setAppUpdate(undefined);
      return;
    }
    setAppUpdate(undefined);
    let active = true;
    void checkAppUpdate(updateChannel)
      .then((update) => {
        if (active) {
          setAppUpdate(update);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [autoCheckForUpdates, updateChannel]);

  useEffect(() => {
    setResearchActiveProject(activeProject?.id);
  }, [activeProject?.id, setResearchActiveProject]);

  useEffect(() => {
    const dock = chatDockRef.current;
    if (!dock || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateDockSpace = () => {
      setChatDockSpace(Math.ceil(dock.getBoundingClientRect().height) + 16);
    };
    const observer = new ResizeObserver(updateDockSpace);
    observer.observe(dock);
    updateDockSpace();
    return () => observer.disconnect();
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
        entries: [...current.entries.slice(0, current.index + 1), sessionId],
        index: current.index + 1,
      };
    });
  }, [activeSession?.id]);

  useEffect(() => {
    if (!sidebarResize) {
      return;
    }

    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";

    const handlePointerMove = (event: PointerEvent) => {
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(
          MIN_SIDEBAR_WIDTH,
          sidebarResize.startWidth + event.clientX - sidebarResize.startX,
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
    const previousUserSelect = document.documentElement.style.userSelect;
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
    const channel = appUpdate?.channel;
    if (!channel) {
      return;
    }
    setInstallingUpdate(true);
    try {
      setAppUpdate(await checkAppUpdate(channel, true));
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
      current.some((item) => item.id === tab.id) ? current : [...current, tab],
    );
    setActiveWorkspaceTabId(tab.id);
  }, []);

  const openGit = () =>
    openWorkspaceTab({ id: "review", kind: "review", label: "审阅" });

  const openFileTarget = useCallback(
    (absolutePath: string, displayPath: string) => {
      void openFileWithPreferredApp(absolutePath, defaultFileOpener).then(
        (opened) => {
          if (opened) {
            return;
          }
          openWorkspaceTab({
            id: `file:${displayPath}`,
            kind: "file",
            label: displayPath.split("/").at(-1) ?? displayPath,
            path: displayPath,
          });
        },
      );
    },
    [defaultFileOpener, openWorkspaceTab],
  );

  const openProjectReference = useCallback(
    (reference: ProjectReference) => {
      if (reference.kind === "folder") {
        openWorkspaceTab({ id: "files", kind: "files", label: "文件" });
        return;
      }
      openFileTarget(reference.absolutePath, reference.displayPath);
    },
    [openFileTarget, openWorkspaceTab],
  );

  const openFilePreview = useCallback(
    (path: string) => {
      const root = activeProject?.path ?? cwd;
      openFileTarget(resolveWorkspacePath(root, path), path);
    },
    [activeProject?.path, cwd, openFileTarget],
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

  const newWorkspaceToolTab = (kind: "files" | "terminal" | "review") => {
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

  const openResearchSection = (section: ResearchSection) => {
    setResearchDetail(undefined);
    setResearchSection(section);
    if (
      section !== "skills" &&
      window.matchMedia("(max-width: 720px)").matches
    ) {
      setSidebarVisibility(true);
    }
    if (section !== "skills") {
      setResearchMainOpen(true);
      setSettingsOpen(false);
      setWorkspacePanelOpen(false);
      return;
    }
    if (section === "skills") {
      setResearchMainOpen(false);
      openSettings("skills");
      return;
    }
  };

  const openResearchPaper = (paper: ResearchPaper) => {
    setResearchDetail((current) => ({
      paper,
      returnTo: current?.type === "tracking" ? current : undefined,
      type: "paper",
    }));
    setResearchMainOpen(true);
    setSettingsOpen(false);
    setWorkspacePanelOpen(false);
  };

  const openResearchTrackingTopic = (topicId: string) => {
    setResearchDetail({ topicId, type: "tracking" });
    setResearchSection("tracking");
    setResearchMainOpen(true);
    setSettingsOpen(false);
    setWorkspacePanelOpen(false);
  };

  const askResearchPaper = useCallback(
    (paper: {
      abstract?: string;
      authors: string[];
      doi?: string;
      title: string;
      url: string;
    }) => {
      const skillContext = buildResearchSkillContext();
      const content = [
        "请帮我分析这篇论文，并把结论和证据边界说清楚：",
        "请遵循以下已启用的 Research 技能约束：",
        skillContext,
        `标题：${paper.title}`,
        `作者：${paper.authors.join("、") || "未知"}`,
        paper.doi ? `DOI：${paper.doi}` : undefined,
        `来源：${paper.url}`,
        paper.abstract ? `摘要：${paper.abstract}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");

      setWorkspaceMode("work");
      window.localStorage.setItem(WORKSPACE_MODE_STORAGE_KEY, "work");
      setResearchMainOpen(false);
      setSettingsOpen(false);
      setNewTaskOpen(false);
      setWorkspacePanelOpen(false);
      if (activeSession) {
        taskLauncherRef.current.queue(activeSession.id, { content });
        void taskLauncherRef.current.deliverIfReady(
          {
            activeSessionId: activeSession.id,
            agentSessionId: agentLocalSessionId,
            ready: chatStatus === "ready",
          },
          submitPrompt,
        );
      }
    },
    [activeSession, agentLocalSessionId, chatStatus, submitPrompt],
  );

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

  const changeWorkspaceMode = (mode: WorkspaceMode) => {
    setWorkspaceMode(mode);
    window.localStorage.setItem(WORKSPACE_MODE_STORAGE_KEY, mode);
    setSettingsOpen(false);
    setNewTaskOpen(false);
    if (window.matchMedia("(max-width: 720px)").matches) {
      setSidebarVisibility(true);
    }
    if (mode === "research") {
      openResearchSection("overview");
    } else {
      setResearchDetail(undefined);
      setResearchMainOpen(false);
      setWorkspacePanelOpen(false);
    }
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

  const beginSidebarResize: PointerEventHandler<HTMLDivElement> = (event) => {
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

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 720px)");
    const collapseForSmallViewport = () => {
      if (mediaQuery.matches) {
        setSidebarVisibility(true);
        setSessionInfoOpen(false);
        setSessionInfoLayoutOpen(false);
        setSessionInfoSurfaceOpen(false);
        setWorkspacePanelOpen(false);
      }
    };
    collapseForSmallViewport();
    mediaQuery.addEventListener("change", collapseForSmallViewport);
    return () =>
      mediaQuery.removeEventListener("change", collapseForSmallViewport);
  }, []);

  const handleSessionTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabs = ["chat", "trajectory"] as const;
    const currentIndex = tabs.indexOf(conversationView);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setConversationView(nextTab);
    document.getElementById(`session-view-tab-${nextTab}`)?.focus();
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
  const independentProject = projects.find(isIndependentProject);
  const newTaskProject =
    projects.find((project) => project.id === newTaskProjectId) ??
    (defaultIndependentChat
      ? (independentProject ?? activeProject)
      : activeProject);

  const createTaskFromPrompt = async (
    content: string,
    attachments: AgentPromptAttachment[],
  ) => {
    if (!newTaskProject) {
      return;
    }
    const session = await taskLauncherRef.current.createAndQueue(
      newTaskProject,
      { attachments, content },
      createSession,
    );
    if (!session) {
      return;
    }
    setNewTaskOpen(false);
  };

  useEffect(() => {
    void taskLauncherRef.current.deliverIfReady(
      {
        activeSessionId: activeSession?.id,
        agentSessionId: agentLocalSessionId,
        ready: chatStatus === "ready",
      },
      submitPrompt,
    );
  }, [activeSession?.id, agentLocalSessionId, chatStatus, submitPrompt]);

  const renderComposer = (
    onSubmit: (
      content: string,
      attachments: AgentPromptAttachment[],
    ) => void | Promise<void>,
  ) => (
    <AgentComposer
      contextUsage={contextUsage}
      modelChanging={Boolean(pendingModelId)}
      models={availableModels}
      onModelChange={(modelId) => void selectModel(modelId)}
      onPermissionModeChange={(mode) => void selectPermissionMode(mode)}
      onReasoningEffortChange={(effort) => void selectReasoningEffort(effort)}
      onSessionModeChange={(modeId) => void selectSessionMode(modeId)}
      onStop={() => void cancelPrompt()}
      onSubmit={onSubmit}
      permissionMode={permissionMode}
      reasoningEffortChanging={Boolean(pendingReasoningEffort)}
      sessionModeChanging={Boolean(pendingSessionModeId)}
      sessionModes={availableSessionModes}
      selectedModelId={selectedModelId}
      selectedReasoningEffort={selectedReasoningEffort}
      selectedSessionModeId={selectedSessionModeId}
      status={chatStatus}
    />
  );

  const primaryViewKey = newTaskOpen
    ? "new-task"
    : workspaceMode === "research" &&
        researchMainOpen &&
        researchSection !== "skills"
      ? "research"
      : "conversation";
  const nativeVibrancyEnabled =
    isMacOS && isTauriRuntime() && translucentSidebar;

  return (
    <main
      className={cn(
        "relative flex h-svh min-h-0 overflow-hidden text-foreground",
        nativeVibrancyEnabled ? "bg-transparent" : "bg-background",
      )}
    >
      {!settingsOpen ? (
        <WindowNavigationControls
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          className="absolute top-0 left-0 z-50"
          collapsed={sidebarCollapsed}
          macSafeArea={isMacOS}
          onGoBack={() => goThroughSessionHistory(-1)}
          onGoForward={() => goThroughSessionHistory(1)}
          onToggleSidebar={() => setSidebarVisibility(!sidebarCollapsed)}
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
          activeResearchSection={researchSection}
          activeSessionId={settingsOpen ? undefined : activeSession?.id}
          loading={workspaceLoading}
          onDeleteSession={(session) => void deleteSession(session)}
          onModeChange={changeWorkspaceMode}
          onNewSession={(project) => {
            returnToConversation();
            setResearchMainOpen(false);
            setWorkspacePanelOpen(false);
            const initialProject =
              project ??
              (defaultIndependentChat
                ? (independentProject ?? activeProject)
                : activeProject);
            setNewTaskProjectId(initialProject?.id);
            setNewTaskOpen(true);
          }}
          onOpenExtensions={() => openSettings("skills")}
          onOpenGit={openGit}
          onOpenSettings={() => openSettings()}
          onResetWidth={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onResizeBy={(delta) =>
            updateSidebarWidth(sidebarWidthRef.current + delta)
          }
          onResizeStart={beginSidebarResize}
          onSelectProject={(project) => {
            returnToConversation();
            setNewTaskOpen(false);
            void selectProject(project);
          }}
          onSelectSession={(session) => {
            returnToConversation();
            setNewTaskOpen(false);
            selectSession(session);
          }}
          onSelectResearchSection={openResearchSection}
          projects={projects}
          runningSessions={runningSessions}
          settingsActive={settingsOpen}
          sessionsByProject={sessionsByProject}
          sidebarWidth={sidebarWidth}
          workspaceMode={workspaceMode}
        />
      </div>
      <section
        className="workspace-stage relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
        data-settings-open={settingsOpen ? "true" : "false"}
      >
        <AnimatePresence initial={false} mode="wait">
          {settingsOpen ? (
            <MotionPage
              className="absolute inset-0 flex min-h-0 flex-col"
              key="settings"
            >
              <SettingsWorkspace
                cwd={cwd}
                initialPage={settingsPage}
                macSafeArea={isMacOS}
                onClose={returnToConversation}
                projectId={activeProject?.id ?? "preview-project"}
                projectName={activeProject?.name}
              />
            </MotionPage>
          ) : (
            <MotionPage
              className="absolute inset-0 flex min-h-0"
              key={`workspace:${primaryViewKey}`}
            >
              <div className="relative flex min-h-0 flex-1 overflow-hidden">
                {newTaskOpen ? (
                  <NewTaskWorkspace
                    mode={workspaceMode}
                    onAddProject={() => {
                      void addProject().then((project) => {
                        if (project) {
                          setNewTaskProjectId(project.id);
                        }
                      });
                    }}
                    onCancel={() => setNewTaskOpen(false)}
                    onSelectProject={(project) =>
                      setNewTaskProjectId(project.id)
                    }
                    projects={projects}
                    selectedProject={newTaskProject}
                  >
                    {renderComposer(createTaskFromPrompt)}
                  </NewTaskWorkspace>
                ) : workspaceMode === "research" &&
                  researchMainOpen &&
                  researchSection !== "skills" ? (
                  <ResearchMainWorkspace
                    cwd={cwd}
                    detail={researchDetail}
                    kind={researchSection}
                    onAskPaper={askResearchPaper}
                    onCloseDetail={() =>
                      setResearchDetail((current) =>
                        current?.type === "paper" && current.returnTo
                          ? current.returnTo
                          : undefined,
                      )
                    }
                    onNavigate={openResearchSection}
                    onOpenPaper={openResearchPaper}
                    onOpenTrackingTopic={openResearchTrackingTopic}
                    projectId={activeProject?.id}
                    projectName={activeProject?.name ?? "未选择项目"}
                    root={activeProject?.path ?? cwd}
                  />
                ) : (
                  <>
                    <div className="relative flex min-w-0 flex-1 flex-col">
                      <header
                        className={cn(
                          "harness-session-header sidebar-aware-header flex shrink-0 flex-col items-stretch pr-6",
                          sidebarCollapsed
                            ? isMacOS
                              ? "pl-52"
                              : "pl-32"
                            : "pl-6",
                        )}
                        data-tauri-drag-region
                      >
                        <div
                          className="harness-session-title-row"
                          data-tauri-drag-region
                        >
                          <div
                            className="flex min-w-0 items-center gap-2"
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
                              className="harness-session-status"
                              data-tauri-drag-region
                            >
                              <span
                                aria-hidden="true"
                                className="motion-status-dot size-1.5 rounded-full bg-current"
                                data-active={
                                  sessionIsActive ? "true" : undefined
                                }
                                data-tauri-drag-region
                              />
                              {sessionStatusLabel(status.phase, acpPhase)}
                            </div>
                          </div>
                          <div className="harness-session-actions">
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
                                sessionInfoOpen
                                  ? "收起会话信息"
                                  : "展开会话信息"
                              }
                              aria-pressed={sessionInfoOpen}
                              onClick={toggleSessionInfo}
                              size="icon"
                              title={
                                sessionInfoOpen
                                  ? "收起会话信息"
                                  : "展开会话信息"
                              }
                              variant={sessionInfoOpen ? "secondary" : "ghost"}
                            >
                              <ListFilterIcon />
                            </Button>
                            <Button
                              aria-label={
                                workspacePanelOpen
                                  ? "收起右侧边栏"
                                  : "展开右侧边栏"
                              }
                              aria-pressed={workspacePanelOpen}
                              onClick={() =>
                                setWorkspacePanelOpen((open) => !open)
                              }
                              size="icon"
                              title={
                                workspacePanelOpen
                                  ? "收起右侧边栏"
                                  : "展开右侧边栏"
                              }
                              variant={
                                workspacePanelOpen ? "secondary" : "ghost"
                              }
                            >
                              <PanelRightIcon />
                            </Button>
                          </div>
                        </div>
                      </header>
                      <div className="harness-session-surface">
                        <nav
                          aria-label="会话视图"
                          aria-orientation="horizontal"
                          className={cn(
                            "harness-session-tabs sidebar-aware-tabs",
                            sidebarCollapsed
                              ? isMacOS
                                ? "pl-[216px]"
                                : "pl-[136px]"
                              : "pl-8",
                          )}
                          role="tablist"
                        >
                          <button
                            aria-controls="session-view-panel"
                            aria-selected={conversationView === "chat"}
                            className={cn(
                              "harness-session-tab",
                              conversationView === "chat" && "is-active",
                            )}
                            id="session-view-tab-chat"
                            onClick={() => setConversationView("chat")}
                            onKeyDown={handleSessionTabKeyDown}
                            role="tab"
                            tabIndex={conversationView === "chat" ? 0 : -1}
                            type="button"
                          >
                            对话
                          </button>
                          <button
                            aria-controls="session-view-panel"
                            aria-selected={conversationView === "trajectory"}
                            className={cn(
                              "harness-session-tab",
                              conversationView === "trajectory" && "is-active",
                            )}
                            id="session-view-tab-trajectory"
                            onClick={() => setConversationView("trajectory")}
                            onKeyDown={handleSessionTabKeyDown}
                            role="tab"
                            tabIndex={
                              conversationView === "trajectory" ? 0 : -1
                            }
                            type="button"
                          >
                            轨迹
                          </button>
                        </nav>
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

                        <div
                          className="harness-chat-layout"
                          data-session-info-layout-open={sessionInfoLayoutOpen}
                          style={
                            {
                              "--harness-chat-dock-space": `${chatDockSpace}px`,
                            } as CSSProperties
                          }
                        >
                          <div
                            aria-labelledby={`session-view-tab-${conversationView}`}
                            className="relative flex min-w-0 flex-1 flex-col"
                            id="session-view-panel"
                            role="tabpanel"
                          >
                            {conversationView === "chat" ? (
                              <AgentTimeline
                                cwd={cwd}
                                entries={timeline}
                                onPermission={resolvePermission}
                                onQuestion={resolveQuestion}
                                onPlanDecision={resolvePlan}
                                onOpenFile={openFilePreview}
                                onOpenProjectReference={openProjectReference}
                                projectRoot={activeProject?.path ?? cwd}
                                turnRunning={
                                  chatStatus === "submitted" ||
                                  chatStatus === "streaming"
                                }
                              />
                            ) : (
                              <TrajectoryView
                                entries={timeline}
                                running={
                                  chatStatus === "submitted" ||
                                  chatStatus === "streaming"
                                }
                              />
                            )}
                          </div>
                          <aside
                            aria-hidden={!sessionInfoOpen}
                            aria-label="会话信息"
                            className="harness-session-info-panel"
                            data-layout-open={sessionInfoLayoutOpen}
                            inert={!sessionInfoOpen}
                          >
                            <div
                              className="harness-session-info-surface"
                              data-open={sessionInfoSurfaceOpen}
                            >
                              <div className="harness-session-info-header">
                                <span>会话信息</span>
                              </div>
                              <div className="harness-session-info-body harness-session-info-body--ledger">
                                <section className="harness-session-info-section">
                                  <SubagentTray
                                    className="!mx-0 !max-w-none !justify-start !px-0 !pb-0"
                                    onOpenSubagent={openSubagent}
                                    subagents={visibleSubagents}
                                  />
                                </section>
                                <section className="harness-session-info-section">
                                  <SessionStatsLine
                                    contextUsage={contextUsage}
                                    entries={timeline}
                                    modelName={
                                      availableModels.find(
                                        (model) => model.id === selectedModelId,
                                      )?.name
                                    }
                                  />
                                </section>
                              </div>
                            </div>
                          </aside>
                          <div
                            className="harness-chat-bottom-dock"
                            ref={chatDockRef}
                          >
                            {renderComposer(submitPrompt)}
                          </div>
                        </div>
                      </div>
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
                          updateWorkspacePanelWidth(
                            DEFAULT_WORKSPACE_PANEL_WIDTH,
                          )
                        }
                        onResizeBy={(delta) =>
                          updateWorkspacePanelWidth(
                            workspacePanelWidthRef.current + delta,
                          )
                        }
                        onResizeStart={beginWorkspacePanelResize}
                        panelWidth={workspacePanelWidth}
                        maxPanelWidth={MAX_WORKSPACE_PANEL_WIDTH}
                        minPanelWidth={MIN_WORKSPACE_PANEL_WIDTH}
                        root={activeProject?.path ?? cwd}
                        subagents={subagents}
                        tabs={workspaceTabs}
                      />
                    </div>
                  </>
                )}
              </div>
            </MotionPage>
          )}
        </AnimatePresence>
      </section>
    </main>
  );
}
