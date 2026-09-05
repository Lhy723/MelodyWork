import { useCallback, useEffect, type Dispatch, type KeyboardEvent, type PointerEventHandler, type SetStateAction } from "react";

import type { AgentPromptAttachment, AgentSubagent } from "@/domain/acp";
import type { ProjectReference } from "@/domain/message-citations";
import type { ResearchPaper } from "@/domain/research";
import { TaskLauncher } from "@/domain/task-launch";
import type { ProjectRecord, SessionRecord } from "@/domain/workspace";
import type { ResearchSection } from "@/features/sessions/app-sidebar";
import type { WorkspaceMode } from "@/features/sessions/sidebar-types";
import type { ResearchMainDetail } from "@/features/research/research-main-workspace";
import type { SettingsPage } from "@/features/settings/settings-workspace";
import { buildResearchSkillContext } from "@/features/research/research-capability-store";
import { openFileWithPreferredApp } from "@/lib/melody-bridge";
import type { FileOpener } from "@/stores/app-settings-store";
import { isIndependentProject } from "@/domain/workspace";
import {
  SIDEBAR_WIDTH_STORAGE_KEY,
  WORKSPACE_MODE_STORAGE_KEY,
  WORKSPACE_PANEL_WIDTH_STORAGE_KEY,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_WORKSPACE_PANEL_WIDTH,
  maxWorkspacePanelWidth,
  resolveWorkspacePath,
  type SessionNavigationHistory,
} from "./agent-workspace-utils";
import type { WorkspaceTab } from "@/features/workspace/workspace-side-panel";

type WorkspaceActionsOptions = {
  activeProject?: ProjectRecord;
  activeSession?: SessionRecord;
  activeWorkspaceTabId?: string;
  activeSessionId?: string;
  agentLocalSessionId?: string;
  defaultFileOpener: FileOpener;
  defaultIndependentChat: boolean;
  independentProject?: ProjectRecord;
  activeSessionReady: boolean;
  cwd: string;
  projects: ProjectRecord[];
  sessionsByProject: Record<string, SessionRecord[]>;
  workspaceTabs: WorkspaceTab[];
  workspaceTabSequence: { current: number };
  taskLauncherRef: { current: TaskLauncher };
  sessionNavigation: SessionNavigationHistory;
  historyTraversalTarget: { current: string | undefined };
  conversationView: "chat" | "trajectory";
  newTaskProjectId?: string;
  setWorkspaceTabs: Dispatch<SetStateAction<WorkspaceTab[]>>;
  setWorkspacePanelOpen: Dispatch<SetStateAction<boolean>>;
  setActiveWorkspaceTabId: Dispatch<SetStateAction<string | undefined>>;
  setWorkspacePanelWidth: Dispatch<SetStateAction<number>>;
  workspacePanelWidthRef: { current: number };
  setWorkspacePanelResize: Dispatch<SetStateAction<{ startWidth: number; startX: number } | undefined>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsPage: Dispatch<SetStateAction<SettingsPage>>;
  setResearchDetail: Dispatch<SetStateAction<ResearchMainDetail | undefined>>;
  setResearchSection: Dispatch<SetStateAction<ResearchSection>>;
  setResearchMainOpen: Dispatch<SetStateAction<boolean>>;
  setNewTaskOpen: Dispatch<SetStateAction<boolean>>;
  setWorkspaceMode: Dispatch<SetStateAction<WorkspaceMode>>;
  setSidebarWidth: Dispatch<SetStateAction<number>>;
  sidebarWidthRef: { current: number };
  setSidebarResize: Dispatch<SetStateAction<{ startWidth: number; startX: number } | undefined>>;
  setConversationView: Dispatch<SetStateAction<"chat" | "trajectory">>;
  setSidebarVisibility: (collapsed: boolean) => void;
  setSessionNavigation: Dispatch<SetStateAction<SessionNavigationHistory>>;
  selectSession: (session: SessionRecord) => void | Promise<void>;
  createSession: (project?: ProjectRecord) => Promise<SessionRecord | undefined>;
  submitPrompt: (content: string, attachments?: AgentPromptAttachment[]) => Promise<void>;
};

export function useAgentWorkspaceActions(options: WorkspaceActionsOptions) {
  const {
    activeProject,
    activeSession,
    activeWorkspaceTabId,
    activeSessionId,
    agentLocalSessionId,
    defaultFileOpener,
    defaultIndependentChat,
    independentProject,
    activeSessionReady,
    cwd,
    projects,
    sessionsByProject,
    workspaceTabs,
    workspaceTabSequence,
    taskLauncherRef,
    sessionNavigation,
    historyTraversalTarget,
    conversationView,
    newTaskProjectId,
    setWorkspaceTabs,
    setWorkspacePanelOpen,
    setActiveWorkspaceTabId,
    setWorkspacePanelWidth,
    workspacePanelWidthRef,
    setWorkspacePanelResize,
    setSettingsOpen,
    setSettingsPage,
    setResearchDetail,
    setResearchSection,
    setResearchMainOpen,
    setNewTaskOpen,
    setWorkspaceMode,
    setSidebarWidth,
    sidebarWidthRef,
    setSidebarResize,
    setConversationView,
    setSidebarVisibility,
    setSessionNavigation,
    selectSession,
    createSession,
    submitPrompt,
  } = options;

  const openSettings = useCallback(
    (page: SettingsPage = "configuration") => {
      setWorkspacePanelOpen(false);
      setWorkspaceTabs([]);
      setActiveWorkspaceTabId(undefined);
      setSettingsPage(page);
      setSettingsOpen(true);
    },
    [setActiveWorkspaceTabId, setSettingsOpen, setSettingsPage, setWorkspacePanelOpen, setWorkspaceTabs],
  );

  const openWorkspaceTab = useCallback(
    (tab: WorkspaceTab) => {
      setSettingsOpen(false);
      setWorkspacePanelOpen(true);
      setWorkspaceTabs((current) =>
        current.some((item) => item.id === tab.id) ? current : [...current, tab],
      );
      setActiveWorkspaceTabId(tab.id);
    },
    [setActiveWorkspaceTabId, setSettingsOpen, setWorkspacePanelOpen, setWorkspaceTabs],
  );

  const openGit = useCallback(
    () => openWorkspaceTab({ id: "review", kind: "review", label: "审阅" }),
    [openWorkspaceTab],
  );

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

  const newWorkspaceToolTab = useCallback(
    (kind: "files" | "terminal" | "review") => {
      const baseLabel = { files: "文件", terminal: "终端", review: "审阅" }[kind];
      const matchingTabs = workspaceTabs.filter((tab) => tab.kind === kind).length;
      workspaceTabSequence.current += 1;
      const label = matchingTabs === 0 ? baseLabel : `${baseLabel} ${matchingTabs + 1}`;
      const id = `${kind}:new:${workspaceTabSequence.current}`;
      const tab: WorkspaceTab =
        kind === "files"
          ? { id, kind: "files", label }
          : kind === "terminal"
            ? { id, kind: "terminal", label }
            : { id, kind: "review", label };
      openWorkspaceTab(tab);
    },
    [openWorkspaceTab, workspaceTabSequence, workspaceTabs],
  );

  const openResearchSection = useCallback(
    (section: ResearchSection) => {
      setResearchDetail(undefined);
      setResearchSection(section);
      if (section !== "skills" && window.matchMedia("(max-width: 720px)").matches) {
        setSidebarVisibility(true);
      }
      if (section !== "skills") {
        setResearchMainOpen(true);
        setSettingsOpen(false);
        setWorkspacePanelOpen(false);
        return;
      }
      setResearchMainOpen(false);
      openSettings("skills");
    },
    [openSettings, setResearchDetail, setResearchMainOpen, setSettingsOpen, setSidebarVisibility, setWorkspacePanelOpen, setResearchSection],
  );

  const openResearchPaper = useCallback(
    (paper: ResearchPaper) => {
      setResearchDetail((current) => ({
        paper,
        returnTo: current?.type === "tracking" ? current : undefined,
        type: "paper",
      }));
      setResearchMainOpen(true);
      setSettingsOpen(false);
      setWorkspacePanelOpen(false);
    },
    [setResearchDetail, setResearchMainOpen, setSettingsOpen, setWorkspacePanelOpen],
  );

  const openResearchTrackingTopic = useCallback(
    (topicId: string) => {
      setResearchDetail({ topicId, type: "tracking" });
      setResearchSection("tracking");
      setResearchMainOpen(true);
      setSettingsOpen(false);
      setWorkspacePanelOpen(false);
    },
    [setResearchDetail, setResearchMainOpen, setResearchSection, setSettingsOpen, setWorkspacePanelOpen],
  );

  const askResearchPaper = useCallback(
    (paper: { abstract?: string; authors: string[]; doi?: string; title: string; url: string }) => {
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
      ].filter(Boolean).join("\n");

      setWorkspaceMode("work");
      window.localStorage.setItem(WORKSPACE_MODE_STORAGE_KEY, "work");
      setResearchMainOpen(false);
      setSettingsOpen(false);
      setNewTaskOpen(false);
      setWorkspacePanelOpen(false);
      if (activeSession) {
        taskLauncherRef.current.queue(activeSession.id, { content });
        void taskLauncherRef.current.deliverIfReady(
          { activeSessionId: activeSession.id, agentSessionId: agentLocalSessionId, ready: activeSessionReady },
          submitPrompt,
        );
      }
    },
    [activeSession, activeSessionReady, agentLocalSessionId, setNewTaskOpen, setResearchMainOpen, setSettingsOpen, setWorkspaceMode, setWorkspacePanelOpen, submitPrompt, taskLauncherRef],
  );

  const closeWorkspaceTab = useCallback(
    (tabId: string) => {
      setWorkspaceTabs((current) => {
        const closingIndex = current.findIndex((tab) => tab.id === tabId);
        const nextTabs = current.filter((tab) => tab.id !== tabId);
        if (activeWorkspaceTabId === tabId) {
          const nextActive = nextTabs[Math.min(closingIndex, nextTabs.length - 1)]?.id;
          setActiveWorkspaceTabId(nextActive);
        }
        return nextTabs;
      });
    },
    [activeWorkspaceTabId, setActiveWorkspaceTabId, setWorkspaceTabs],
  );

  const updateWorkspacePanelWidth = useCallback(
    (nextWidth: number) => {
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
    },
    [setWorkspacePanelWidth, workspacePanelWidthRef],
  );

  const beginWorkspacePanelResize: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      setWorkspacePanelResize({
        startWidth: workspacePanelWidthRef.current,
        startX: event.clientX,
      });
    },
    [setWorkspacePanelResize, workspacePanelWidthRef],
  );

  const returnToConversation = useCallback(() => {
    setSettingsOpen(false);
  }, [setSettingsOpen]);

  const changeWorkspaceMode = useCallback(
    (mode: WorkspaceMode) => {
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
    },
    [openResearchSection, setNewTaskOpen, setResearchDetail, setResearchMainOpen, setSettingsOpen, setSidebarVisibility, setWorkspaceMode, setWorkspacePanelOpen],
  );

  const updateSidebarWidth = useCallback((nextWidth: number) => {
    const clampedWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, nextWidth));
    sidebarWidthRef.current = clampedWidth;
    setSidebarWidth(clampedWidth);
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clampedWidth)));
  }, [setSidebarWidth, sidebarWidthRef]);

  const beginSidebarResize: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      setSidebarResize({
        startWidth: sidebarWidthRef.current,
        startX: event.clientX,
      });
    },
    [setSidebarResize, sidebarWidthRef],
  );

  const handleSessionTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
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
    },
    [conversationView, setConversationView],
  );

  const findSessionById = useCallback(
    (sessionId: string) =>
      Object.values(sessionsByProject)
        .flat()
        .find((session) => session.id === sessionId),
    [sessionsByProject],
  );

  const nextHistoryIndex = useCallback(
    (direction: -1 | 1) => {
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
    },
    [findSessionById, sessionNavigation.entries, sessionNavigation.index],
  );

  const goThroughSessionHistory = useCallback(
    (direction: -1 | 1) => {
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
      setSessionNavigation((current) => ({ ...current, index: targetIndex }));
      returnToConversation();
      setWorkspaceTabs([]);
      setActiveWorkspaceTabId(undefined);
      setWorkspacePanelOpen(false);
      void selectSession(session);
    },
    [findSessionById, historyTraversalTarget, nextHistoryIndex, returnToConversation, selectSession, sessionNavigation.entries, setActiveWorkspaceTabId, setSessionNavigation, setWorkspacePanelOpen, setWorkspaceTabs],
  );

  const usableActiveProject =
    activeProject && (isIndependentProject(activeProject) || !activeProject.archived)
      ? activeProject
      : undefined;
  const newTaskProject =
    projects.find(
      (project) =>
        project.id === newTaskProjectId &&
        (isIndependentProject(project) || !project.archived),
    ) ??
    (defaultIndependentChat
      ? (independentProject ?? usableActiveProject)
      : usableActiveProject);

  const createTaskFromPrompt = useCallback(
    async (content: string, attachments: AgentPromptAttachment[]) => {
      if (!newTaskProject) {
        return;
      }
      const session = await taskLauncherRef.current.createAndQueue(
        newTaskProject,
        { attachments, content },
        createSession,
      );
      if (session) {
        setNewTaskOpen(false);
      }
    },
    [createSession, newTaskProject, setNewTaskOpen, taskLauncherRef],
  );

  useEffect(() => {
    void taskLauncherRef.current.deliverIfReady(
      {
        activeSessionId,
        agentSessionId: agentLocalSessionId,
        ready: activeSessionReady,
      },
      submitPrompt,
    );
  }, [activeSessionId, activeSessionReady, agentLocalSessionId, submitPrompt, taskLauncherRef]);

  return {
    askResearchPaper,
    beginSidebarResize,
    beginWorkspacePanelResize,
    canGoBack: nextHistoryIndex(-1) !== undefined,
    canGoForward: nextHistoryIndex(1) !== undefined,
    changeWorkspaceMode,
    closeWorkspaceTab,
    createTaskFromPrompt,
    goThroughSessionHistory,
    handleSessionTabKeyDown,
    newTaskProject,
    newWorkspaceToolTab,
    openFilePreview,
    openGit,
    openProjectReference,
    openResearchPaper,
    openResearchSection,
    openResearchTrackingTopic,
    openSettings,
    openSubagent,
    openWorkspaceTab,
    returnToConversation,
    updateSidebarWidth,
    updateWorkspacePanelWidth,
  };
}
