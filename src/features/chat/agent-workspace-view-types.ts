import type { BackgroundTaskRow } from "@/domain/agent/background-task-list";
import type { PendingInteractionKind } from "@/domain/agent/pending-interaction";
import type { AgentMonitorNotification } from "@/domain/agent/event-to-session-update";
import type { PiSessionFork } from "@/domain/agent/pi-session-fork";
import type { AgentMonitorSnapshot } from "@/lib/melody-bridge-monitors";
import type {
  Dispatch,
  KeyboardEvent,
  PointerEventHandler,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react";
import type {
  AgentSessionPhase,
  AgentContextUsage,
  AgentModelOption,
  AgentPlanDecision,
  AgentQuestionResponse,
  AgentPromptAttachment,
  AgentStatus,
  AgentSubagent,
  TimelineEntry,
} from "@/domain/acp";
import type { GitChange } from "@/domain/git";
import type { ProjectReference } from "@/domain/message-citations";
import type { ResearchPaper } from "@/domain/research";
import type { ProjectRecord, SessionRecord } from "@/domain/workspace";
import type { ResearchMainDetail } from "@/features/research/research-main-workspace";
import type {
  ResearchSection,
  WorkspaceMode,
} from "@/features/sessions/app-sidebar";
import type { SettingsPage } from "@/features/settings/settings-workspace";
import type { WorkspaceTab } from "@/features/workspace/workspace-side-panel";
import type { AppUpdateProgress, AppUpdateStatus } from "@/lib/melody-bridge";

export interface AgentWorkspaceViewProps {
  activeProject?: ProjectRecord;
  activePiFork?: PiSessionFork;
  relatedPiForks?: PiSessionFork[];
  activeSession?: SessionRecord;
  activeWorkspaceTabId?: string;
  chatDockRef: RefObject<HTMLDivElement | null>;
  runtimePhase: AgentSessionPhase;
  appUpdate?: AppUpdateStatus;
  appUpdateProgress?: AppUpdateProgress;
  availableModels: AgentModelOption[];
  canGoBack: boolean;
  canGoForward: boolean;
  chatDockSpace: number;
  chatStatus: "ready" | "submitted" | "streaming" | "error";
  contextUsage?: AgentContextUsage;
  conversationView: "chat" | "trajectory";
  cwd: string;
  git: {
    changes: GitChange[];
    error?: string;
    loading: boolean;
    refresh: () => void | Promise<void>;
  };
  goThroughSessionHistory: (direction: -1 | 1) => void;
  handleSessionTabKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  installingUpdate: boolean;
  installAppUpdate: () => Promise<void>;
  isMacOS: boolean;
  newTaskOpen: boolean;
  newTaskProject?: ProjectRecord;
  onAddProject: () => Promise<ProjectRecord | undefined>;
  onChooseWorkspace: () => void;
  onCloseResearchDetail: () => void;
  onCloseSettings: () => void;
  onCloseWorkspaceTab: (tabId: string) => void;
  onNewTaskCancel: () => void;
  onOpenFilePreview: (path: string) => void;
  onOpenGit: () => void;
  onOpenProjectReference: (reference: ProjectReference) => void;
  onExplore: (
    entry: Extract<TimelineEntry, { kind: "message" }>,
  ) => void | Promise<void>;
  onBringBack?: (
    entry: Extract<TimelineEntry, { kind: "message" }>,
  ) => void | Promise<void>;
  onResumePiFork?: () => void | Promise<void>;
  piForkRecoveryBusy?: boolean;
  onOpenResearchPaper: (paper: ResearchPaper) => void;
  onOpenResearchSection: (section: ResearchSection) => void;
  onOpenResearchTrackingTopic: (topicId: string) => void;
  onOpenSubagent: (subagent: AgentSubagent) => void;
  onToggleSidebar: () => void;
  onToggleSessionInfo: () => void;
  onToggleWorkspacePanel: () => void;
  onUseIndependentTask: () => void;
  openResearchAskPaper: (paper: {
    abstract?: string;
    authors: string[];
    doi?: string;
    title: string;
    url: string;
  }) => void;
  beginSidebarResize: PointerEventHandler<HTMLDivElement>;
  beginWorkspacePanelResize: PointerEventHandler<HTMLDivElement>;
  defaultIndependentChat: boolean;
  independentProject?: ProjectRecord;
  nativeVibrancyEnabled: boolean;
  needsWorkspace: boolean;
  primaryViewKey: string;
  onArchiveProject: (project: ProjectRecord) => void;
  onCreateTaskFromPrompt: (
    content: string,
    attachments: AgentPromptAttachment[],
  ) => void | Promise<void>;
  onDeleteProject: (
    project: ProjectRecord,
  ) => Promise<{ deleted: boolean; error?: string }>;
  onDeleteSession: (session: SessionRecord) => void;
  onModeChange: (mode: WorkspaceMode) => void;
  onNewWorkspaceToolTab: (
    kind: "files" | "terminal" | "git" | "review" | "browser",
  ) => void;
  onOpenSettings: (page?: SettingsPage) => void;
  onRestoreProject: (project: ProjectRecord) => void;
  onSelectProject: (project: ProjectRecord) => void;
  onSelectSession: (session: SessionRecord) => void;
  onSubmitPrompt: (
    content: string,
    attachments?: AgentPromptAttachment[],
  ) => void | Promise<void>;
  runningSessions: Record<string, boolean>;
  sessionsByProject: Record<string, SessionRecord[]>;
  /** Product session id → the decision that session is blocked on. */
  waitingSessions: Record<string, PendingInteractionKind>;
  settingsOpen: boolean;
  settingsPage: SettingsPage;
  sidebarResize?: { startWidth: number; startX: number };
  sidebarWidth: number;
  sidebarWidthRef: { current: number };
  workspaceError?: string;
  workspacePanelWidthRef: { current: number };
  projects: ProjectRecord[];
  renderComposer: (
    onSubmit: (
      content: string,
      attachments: AgentPromptAttachment[],
    ) => void | Promise<void>,
  ) => ReactNode;
  researchDetail?: ResearchMainDetail;
  researchMainOpen: boolean;
  researchSection: ResearchSection;
  resolvePermission: (entryId: string, optionId: string) => void;
  resolvePlan: (
    entryId: string,
    outcome: AgentPlanDecision,
    feedback?: string,
  ) => void | Promise<void>;
  resolveQuestion: (
    entryId: string,
    response: AgentQuestionResponse,
  ) => void | Promise<void>;
  selectedModelId?: string;
  sessionInfoLayoutOpen: boolean;
  sessionInfoOpen: boolean;
  sessionInfoSurfaceOpen: boolean;
  sessionIsActive: boolean;
  setActiveWorkspaceTabId: (tabId: string) => void;
  setConversationView: (view: "chat" | "trajectory") => void;
  setNewTaskOpen: (open: boolean) => void;
  setNewTaskProjectId: Dispatch<SetStateAction<string | undefined>>;
  setResearchMainOpen: Dispatch<SetStateAction<boolean>>;
  setWorkspacePanelOpen: Dispatch<SetStateAction<boolean>>;
  sidebarCollapsed: boolean;
  status: AgentStatus;
  subagents: Record<string, AgentSubagent>;
  /** Bounded Host-owned monitor feed for the active session. */
  monitorNotifications: AgentMonitorNotification[];
  /** Running/finished monitors owned by this workspace, newest state first. */
  monitors: AgentMonitorSnapshot[];
  /** Background terminal tasks owned by the active session, running first. */
  backgroundTerminalTasks: BackgroundTaskRow[];
  /** Product task id → the row-level stop failure for that task. */
  backgroundTerminalTaskErrors: Readonly<Record<string, string>>;
  stoppingBackgroundTerminalTaskIds: ReadonlySet<string>;
  onCancelBackgroundTerminalTask: (taskId: string) => void;
  onCancelMonitor: (taskId: string) => void;
  timeline: TimelineEntry[];
  updateSidebarWidth: (nextWidth: number) => void;
  updateWorkspacePanelWidth: (nextWidth: number) => void;
  visibleError?: string;
  visibleSubagents: AgentSubagent[];
  workspaceLoading: boolean;
  workspaceMode: WorkspaceMode;
  workspacePanelOpen: boolean;
  workspacePanelResize?: { startWidth: number; startX: number };
  workspacePanelWidth: number;
  workspaceTabs: WorkspaceTab[];
}
