import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentPromptAttachment, TimelineEntry } from "@/domain/acp";
import { appendExplorerSessionReferenceToDraft } from "@/domain/agent/explorer-branch";
import { isComposerReadOnly } from "@/domain/agent/session-archive";
import { toUserMessage } from "@/domain/app-error";
import { TaskLauncher } from "@/domain/task-launch";
import type { ResearchSection } from "@/features/sessions/app-sidebar";
import type { WorkspaceMode } from "@/features/sessions/sidebar-types";
import type { ResearchMainDetail } from "@/features/research/research-main-workspace";
import type { SettingsPage } from "@/features/settings/settings-workspace";
import type { WorkspaceTab } from "@/features/workspace/workspace-side-panel";
import type { PiSessionFork } from "@/domain/agent/pi-session-fork";
import { isIndependentProject } from "@/domain/workspace";
import { useAgentBridge } from "@/hooks/use-agent-bridge";
import { useAgentMonitors } from "@/hooks/use-agent-monitors";
import { useAgentSchedules } from "@/hooks/use-agent-schedules";
import { useAgentNotifications } from "@/hooks/use-agent-notifications";
import { useAppearanceSettings } from "@/hooks/use-appearance-settings";
import { useGitChanges } from "@/hooks/use-git-changes";
import { useSessionPersistence } from "@/hooks/use-session-persistence";
import { useWorkspace } from "@/hooks/use-workspace";
import { useAgentStore } from "@/stores/agent-store";
import { useResearchStore } from "@/features/research/research-store";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  checkAppUpdate,
  createStoredSession,
  forkPiSession,
  getPiSessionFork,
  isTauriRuntime,
  listPiSessionForks,
  listStoredSessions,
  updateStoredSession,
  type AppUpdateProgress,
  type AppUpdateStatus,
} from "@/lib/melody-bridge";
import {
  readSessionComposerDraft,
  writeSessionComposerDraft,
} from "@/lib/session-composer-draft";
import { useGlobalLiveActivity } from "@/components/interior/live-activity";
import { AgentComposer } from "./agent-composer";
import { useAgentWorkspaceActions } from "./agent-workspace-actions";
import { useAgentWorkspaceLayout } from "./agent-workspace-layout";
import { AgentWorkspaceView } from "./agent-workspace-view";
import {
  DEFAULT_CHAT_DOCK_SPACE,
  isMacOS,
  storedSidebarCollapsed,
  storedSidebarWidth,
  storedWorkspaceMode,
  storedWorkspacePanelWidth,
  subagentsForSession,
  type SessionNavigationHistory,
} from "./agent-workspace-utils";

export function AgentWorkspace() {
  useAppearanceSettings();
  useAgentNotifications();
  useWorkspace();
  const liveActivity = useGlobalLiveActivity();

  const projects = useWorkspaceStore((state) => state.projects);
  const sessionsByProject = useWorkspaceStore(
    (state) => state.sessionsByProject,
  );
  const activeProject = useWorkspaceStore((state) => state.activeProject);
  const activeSession = useWorkspaceStore((state) => state.activeSession);
  const workspaceLoading = useWorkspaceStore((state) => state.loading);
  const needsWorkspace = useWorkspaceStore((state) => state.needsWorkspace);
  const workspaceError = useWorkspaceStore((state) => state.error);
  const addProject = useWorkspaceStore((state) => state.addProject);
  const archiveProject = useWorkspaceStore((state) => state.archiveProject);
  const chooseProject = useWorkspaceStore((state) => state.chooseProject);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const createSession = useWorkspaceStore((state) => state.createSession);
  const deleteSession = useWorkspaceStore((state) => state.deleteSession);
  const deleteProject = useWorkspaceStore((state) => state.deleteProject);
  const restoreProject = useWorkspaceStore((state) => state.restoreProject);
  const selectSession = useWorkspaceStore((state) => state.selectSession);
  const setResearchActiveProject = useResearchStore(
    (state) => state.setActiveProject,
  );

  useAgentBridge(activeSession, needsWorkspace);
  useSessionPersistence();

  const cwd = activeSession?.cwd ?? activeProject?.path ?? ".";
  const status = useAgentStore((state) => state.status);
  const acpPhase = useAgentStore((state) => state.acpPhase);
  const acpSessionId = useAgentStore((state) => state.acpSessionId);
  const timeline = useAgentStore((state) => state.timeline);
  const chatStatus = useAgentStore((state) => state.chatStatus);
  const archivedReadOnly = useAgentStore((state) => state.archivedReadOnly);
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
  const agentEngine = useAppSettingsStore((state) => state.agentEngine);
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
  const [appUpdateProgress, setAppUpdateProgress] =
    useState<AppUpdateProgress>();
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [activePiFork, setActivePiFork] = useState<PiSessionFork>();
  const [relatedPiForks, setRelatedPiForks] = useState<PiSessionFork[]>([]);
  const [piForkRecoveryBusy, setPiForkRecoveryBusy] = useState(false);
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

  const activeSessionIdForFork = activeSession?.id;
  useEffect(() => {
    let current = true;
    if (!activeSessionIdForFork || agentEngine !== "pi" || !isTauriRuntime()) {
      setActivePiFork(undefined);
      setRelatedPiForks([]);
      return () => {
        current = false;
      };
    }
    void Promise.all([
      getPiSessionFork(activeSessionIdForFork),
      listPiSessionForks(activeSessionIdForFork),
    ])
      .then(([fork, forks]) => {
        if (current) {
          setActivePiFork(fork);
          setRelatedPiForks(forks);
        }
      })
      .catch(() => {
        if (current) {
          setActivePiFork(undefined);
          setRelatedPiForks([]);
        }
      });
    return () => {
      current = false;
    };
  }, [activeSessionIdForFork, agentEngine]);
  const activeSessionPiFork =
    activePiFork?.branchSessionId === activeSession?.id
      ? activePiFork
      : undefined;
  const { setSidebarVisibility, toggleSessionInfo } = useAgentWorkspaceLayout({
    autoCheckForUpdates,
    updateChannel,
    setAppUpdate,
    chatDockRef,
    setChatDockSpace,
    sessionInfoOpen,
    setSessionInfoOpen,
    setSessionInfoLayoutOpen,
    setSessionInfoSurfaceOpen,
    sessionInfoCloseTimerRef,
    sessionInfoOpenFrameRef,
    sidebarResize,
    setSidebarResize,
    setSidebarWidth,
    sidebarWidthRef,
    workspacePanelResize,
    setWorkspacePanelResize,
    setWorkspacePanelWidth,
    workspacePanelWidthRef,
    setWorkspacePanelOpen,
    setSidebarCollapsed,
  });
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
  const monitorNotifications = useAgentStore(
    (state) => state.monitorNotifications,
  );
  const { monitors, cancelMonitor } = useAgentMonitors(cwd);
  const scheduleRevision = useAgentStore((state) => state.scheduleRevision);
  const schedules = useAgentSchedules(
    activeSession?.id,
    activeSession?.projectId,
    scheduleRevision,
  );
  const sessionIsActive =
    status.phase === "starting" ||
    status.phase === "running" ||
    acpPhase === "initializing" ||
    acpPhase === "authenticating" ||
    acpPhase === "creating" ||
    acpPhase === "prompting";

  useEffect(() => {
    setResearchActiveProject(activeProject?.id);
  }, [activeProject?.id, setResearchActiveProject]);

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

  const installAppUpdate = async () => {
    const channel = appUpdate?.channel;
    const version = appUpdate?.version;
    if (!channel || !version) {
      return;
    }
    liveActivity.start({
      detail: "正在获取更新包…",
      progress: 0,
      title: `下载 MelodyWork v${version}`,
    });
    setInstallingUpdate(true);
    setAppUpdateProgress({
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: null,
    });
    try {
      const result = await checkAppUpdate(channel, true, (progress) => {
        setAppUpdateProgress(progress);
        const measuredProgress =
          progress.phase === "downloading" &&
          progress.totalBytes !== null &&
          progress.totalBytes > 0
            ? Math.min(1, progress.downloadedBytes / progress.totalBytes)
            : null;
        liveActivity.update({
          detail:
            progress.phase === "installing"
              ? "安装完成后会重启应用。"
              : "正在下载更新包…",
          progress: measuredProgress,
          title:
            progress.phase === "installing"
              ? "安装 MelodyWork 更新"
              : `下载 MelodyWork v${version}`,
        });
      });
      if (!result.installed) {
        throw new Error("更新已不可用，请重新检查更新。");
      }
      setAppUpdate(result);
      liveActivity.succeed({
        detail: `v${result.version ?? version} 已安装，应用即将重启。`,
        title: "MelodyWork 更新完成",
      });
    } catch (reason) {
      const message = toUserMessage(reason, "安装更新失败，请稍后重试。");
      liveActivity.fail(
        {
          detail: message,
          title: "MelodyWork 更新失败",
        },
        {
          label: "重试",
          onClick: () => {
            void installAppUpdate().catch(() => undefined);
          },
        },
      );
      throw reason;
    } finally {
      setInstallingUpdate(false);
      setAppUpdateProgress(undefined);
    }
  };

  const independentProject = projects.find(isIndependentProject);
  const workspaceActions = useAgentWorkspaceActions({
    activeProject,
    activeSession,
    activeWorkspaceTabId,
    activeSessionId: activeSession?.id,
    agentLocalSessionId,
    defaultFileOpener,
    defaultIndependentChat,
    independentProject,
    activeSessionReady: chatStatus === "ready",
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
  });
  const {
    askResearchPaper,
    beginSidebarResize,
    beginWorkspacePanelResize,
    canGoBack,
    canGoForward,
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
    returnToConversation,
    updateSidebarWidth,
    updateWorkspacePanelWidth,
  } = workspaceActions;

  const renderComposer = (
    onSubmit: (
      content: string,
      attachments: AgentPromptAttachment[],
    ) => void | Promise<void>,
  ) => {
    const draftSessionId =
      onSubmit === submitPrompt ? activeSession?.id : undefined;
    const composerReadOnly = isComposerReadOnly({
      archivedReadOnly,
      creatingNewTask: newTaskOpen,
    });
    return (
      <AgentComposer
        key={
          draftSessionId ??
          (onSubmit === submitPrompt ? "no-session" : "task-launcher")
        }
        archived={composerReadOnly}
        contextUsage={contextUsage}
        draftSessionId={draftSessionId}
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
  };

  const exploreFromMessage = async (
    entry: Extract<TimelineEntry, { kind: "message" }>,
  ) => {
    const source = activeSession;
    if (
      !source ||
      agentEngine !== "pi" ||
      entry.role !== "assistant" ||
      !entry.nativeEntryId
    ) {
      return;
    }
    const anchorIndex = timeline.findIndex(
      (candidate) => candidate.kind === "message" && candidate.id === entry.id,
    );
    if (anchorIndex < 0) return;

    let recoveryRecord:
      Awaited<ReturnType<typeof createStoredSession>> | undefined;
    try {
      const branch = await createStoredSession(source.projectId, source.cwd);
      recoveryRecord = branch;
      const titleSeed = entry.content.replace(/\s+/gu, " ").trim();
      const title = `探索：${(titleSeed || source.title).slice(0, 32)}`;
      const branchTimeline = timeline.slice(0, anchorIndex + 1);
      const preparedBranch = await updateStoredSession({
        id: branch.id,
        title,
        timelineJson: JSON.stringify(branchTimeline),
        timelineVersion: source.timelineVersion ?? 0,
      });
      recoveryRecord = preparedBranch;
      await forkPiSession(source, preparedBranch, entry.nativeEntryId);

      const workspace = useWorkspaceStore.getState();
      const projectSessions = [
        preparedBranch,
        ...(workspace.sessionsByProject[source.projectId] ?? []).filter(
          (session) => session.id !== preparedBranch.id,
        ),
      ];
      const shouldActivate = workspace.activeSession?.id === source.id;
      useWorkspaceStore.setState((state) => ({
        sessionsByProject: {
          ...state.sessionsByProject,
          [source.projectId]: projectSessions,
        },
        ...(state.activeProject?.id === source.projectId
          ? { sessions: projectSessions }
          : {}),
        ...(shouldActivate
          ? {
              activeProject: state.activeProject,
              activeSession: preparedBranch,
            }
          : {}),
        error: undefined,
      }));
    } catch (reason) {
      const failedBranch = recoveryRecord;
      if (failedBranch) {
        useWorkspaceStore.setState((state) => {
          const projectSessions = [
            failedBranch,
            ...(state.sessionsByProject[source.projectId] ?? []).filter(
              (session) => session.id !== failedBranch.id,
            ),
          ];
          return {
            sessionsByProject: {
              ...state.sessionsByProject,
              [source.projectId]: projectSessions,
            },
            ...(state.activeProject?.id === source.projectId
              ? { sessions: projectSessions }
              : {}),
            error: toUserMessage(reason, "创建 Pi 探索分支失败。"),
          };
        });
        return;
      }
      useWorkspaceStore.setState({
        error: toUserMessage(reason, "创建 Pi 探索分支失败。"),
      });
    }
  };

  const resumePiFork = async () => {
    const fork = activeSessionPiFork;
    const branch = activeSession;
    if (!fork || fork.status === "ready" || !branch || piForkRecoveryBusy) {
      return;
    }
    setPiForkRecoveryBusy(true);
    try {
      let sessions = sessionsByProject[branch.projectId] ?? [];
      if (!sessions.some((session) => session.id === fork.sourceSessionId)) {
        sessions = await listStoredSessions(branch.projectId);
      }
      const source = sessions.find(
        (session) => session.id === fork.sourceSessionId,
      );
      if (!source) throw new Error("找不到 Explorer 分支对应的源会话。");
      await forkPiSession(source, branch, fork.anchorNativeEntryId);
      const recovered = await getPiSessionFork(branch.id);
      if (recovered) setActivePiFork(recovered);
      setRelatedPiForks(await listPiSessionForks(branch.id));
      useWorkspaceStore.setState({ error: undefined });
    } catch (reason) {
      const latest = await getPiSessionFork(branch.id).catch(() => undefined);
      if (latest) setActivePiFork(latest);
      useWorkspaceStore.setState({
        error: toUserMessage(reason, "恢复 Pi 探索分支失败。"),
      });
    } finally {
      setPiForkRecoveryBusy(false);
    }
  };

  const bringBackExplorerConclusion = async (
    entry: Extract<TimelineEntry, { kind: "message" }>,
  ) => {
    const fork = activeSessionPiFork;
    const branch = activeSession;
    if (
      !fork ||
      fork.status !== "ready" ||
      !branch ||
      entry.role !== "assistant" ||
      entry.streaming ||
      !entry.content.trim()
    ) {
      return;
    }
    const anchorIndex = timeline.findIndex(
      (candidate) =>
        candidate.kind === "message" &&
        candidate.nativeEntryId === fork.anchorNativeEntryId,
    );
    const conclusionIndex = timeline.findIndex(
      (candidate) => candidate.kind === "message" && candidate.id === entry.id,
    );
    if (anchorIndex < 0 || conclusionIndex <= anchorIndex) return;

    let sessions = sessionsByProject[branch.projectId] ?? [];
    try {
      if (!sessions.some((session) => session.id === fork.sourceSessionId)) {
        sessions = await listStoredSessions(branch.projectId);
      }
    } catch (reason) {
      useWorkspaceStore.setState({
        error: toUserMessage(reason, "读取 Explorer 源会话失败。"),
      });
      return;
    }
    const source = sessions.find(
      (session) => session.id === fork.sourceSessionId,
    );
    if (!source) {
      useWorkspaceStore.setState({
        error: "找不到 Explorer 分支对应的源会话。",
      });
      return;
    }

    const nextDraft = appendExplorerSessionReferenceToDraft(
      readSessionComposerDraft(source.id),
      {
        sourceSessionId: source.id,
        branchSessionId: branch.id,
        anchorNativeEntryId: fork.anchorNativeEntryId,
      },
    );
    if (!nextDraft) return;
    const saved = writeSessionComposerDraft(source.id, nextDraft);
    if (!saved) {
      useWorkspaceStore.setState({
        error: "无法保存源会话草稿，请检查本机存储空间。",
      });
      return;
    }
    selectSession(source);
  };

  const primaryViewKey = newTaskOpen
    ? "new-task"
    : !activeSession
      ? "workspace-start"
      : workspaceMode === "research" &&
          researchMainOpen &&
          researchSection !== "skills"
        ? "research"
        : "conversation";
  const nativeVibrancyEnabled =
    isMacOS && isTauriRuntime() && translucentSidebar;

  return (
    <AgentWorkspaceView
      activeProject={activeProject}
      activePiFork={activeSessionPiFork}
      relatedPiForks={relatedPiForks}
      activeSession={activeSession}
      activeWorkspaceTabId={activeWorkspaceTabId}
      acpPhase={acpPhase}
      appUpdate={appUpdate}
      appUpdateProgress={appUpdateProgress}
      availableModels={availableModels}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      chatDockSpace={chatDockSpace}
      chatDockRef={chatDockRef}
      chatStatus={chatStatus}
      contextUsage={contextUsage}
      conversationView={conversationView}
      cwd={cwd}
      git={git}
      goThroughSessionHistory={goThroughSessionHistory}
      handleSessionTabKeyDown={handleSessionTabKeyDown}
      installingUpdate={installingUpdate}
      installAppUpdate={installAppUpdate}
      isMacOS={isMacOS}
      nativeVibrancyEnabled={nativeVibrancyEnabled}
      newTaskOpen={newTaskOpen}
      newTaskProject={newTaskProject}
      onAddProject={async () => {
        const project = await addProject();
        if (project) {
          setNewTaskProjectId(project.id);
        }
        return project;
      }}
      onChooseWorkspace={() => {
        setResearchMainOpen(false);
        setWorkspacePanelOpen(false);
        void chooseProject();
      }}
      onCloseResearchDetail={() =>
        setResearchDetail((current) =>
          current?.type === "paper" && current.returnTo
            ? current.returnTo
            : undefined,
        )
      }
      onCloseSettings={returnToConversation}
      onCloseWorkspaceTab={closeWorkspaceTab}
      onNewTaskCancel={() => setNewTaskOpen(false)}
      onOpenFilePreview={openFilePreview}
      onOpenGit={openGit}
      onOpenProjectReference={openProjectReference}
      onBringBack={bringBackExplorerConclusion}
      onExplore={exploreFromMessage}
      onResumePiFork={resumePiFork}
      piForkRecoveryBusy={piForkRecoveryBusy}
      onOpenResearchPaper={openResearchPaper}
      onOpenResearchSection={openResearchSection}
      onOpenResearchTrackingTopic={openResearchTrackingTopic}
      onOpenSubagent={openSubagent}
      onToggleSidebar={() => setSidebarVisibility(!sidebarCollapsed)}
      onToggleSessionInfo={toggleSessionInfo}
      onToggleWorkspacePanel={() => setWorkspacePanelOpen((open) => !open)}
      onUseIndependentTask={() => {
        if (!independentProject) {
          return;
        }
        setNewTaskProjectId(independentProject.id);
        setNewTaskOpen(true);
      }}
      openResearchAskPaper={askResearchPaper}
      beginSidebarResize={beginSidebarResize}
      beginWorkspacePanelResize={beginWorkspacePanelResize}
      defaultIndependentChat={defaultIndependentChat}
      independentProject={independentProject}
      needsWorkspace={needsWorkspace}
      primaryViewKey={primaryViewKey}
      onArchiveProject={(project) => void archiveProject(project)}
      onCreateTaskFromPrompt={createTaskFromPrompt}
      onDeleteProject={deleteProject}
      onDeleteSession={(session) => void deleteSession(session)}
      onModeChange={changeWorkspaceMode}
      onNewWorkspaceToolTab={newWorkspaceToolTab}
      onOpenSettings={openSettings}
      onRestoreProject={(project) => void restoreProject(project)}
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
      onSubmitPrompt={submitPrompt}
      runningSessions={runningSessions}
      sessionsByProject={sessionsByProject}
      settingsOpen={settingsOpen}
      settingsPage={settingsPage}
      sidebarResize={sidebarResize}
      sidebarWidth={sidebarWidth}
      sidebarWidthRef={sidebarWidthRef}
      projects={projects}
      renderComposer={renderComposer}
      researchDetail={researchDetail}
      researchMainOpen={researchMainOpen}
      researchSection={researchSection}
      resolvePermission={resolvePermission}
      resolvePlan={resolvePlan}
      resolveQuestion={resolveQuestion}
      selectedModelId={selectedModelId}
      sessionInfoLayoutOpen={sessionInfoLayoutOpen}
      sessionInfoOpen={sessionInfoOpen}
      sessionInfoSurfaceOpen={sessionInfoSurfaceOpen}
      sessionIsActive={sessionIsActive}
      setActiveWorkspaceTabId={setActiveWorkspaceTabId}
      setConversationView={setConversationView}
      setNewTaskOpen={setNewTaskOpen}
      setNewTaskProjectId={setNewTaskProjectId}
      setResearchMainOpen={setResearchMainOpen}
      setWorkspacePanelOpen={setWorkspacePanelOpen}
      sidebarCollapsed={sidebarCollapsed}
      status={status}
      subagents={subagents}
      timeline={timeline}
      updateSidebarWidth={updateSidebarWidth}
      updateWorkspacePanelWidth={updateWorkspacePanelWidth}
      visibleError={visibleError}
      visibleSubagents={visibleSubagents}
      monitorNotifications={monitorNotifications}
      monitors={monitors}
      onCancelMonitor={cancelMonitor}
      schedules={schedules}
      workspaceLoading={workspaceLoading}
      workspaceMode={workspaceMode}
      workspaceError={workspaceError}
      workspacePanelOpen={workspacePanelOpen}
      workspacePanelResize={workspacePanelResize}
      workspacePanelWidthRef={workspacePanelWidthRef}
      workspacePanelWidth={workspacePanelWidth}
      workspaceTabs={workspaceTabs}
    />
  );
}
