import { create } from "zustand";

import { rawErrorMessage, toUserMessage } from "@/domain/app-error";
import { RequestGate } from "@/domain/request-gate";
import {
  isIndependentProject,
  type ProjectDeleteResult,
  type ProjectRecord,
  type SessionRecord,
} from "@/domain/workspace";
import {
  createStoredSession,
  deleteStoredSession,
  archiveProject as archiveStoredProject,
  deleteProject as deleteStoredProject,
  listProjects,
  listStoredSessions,
  pickWorkspaceDirectory,
  restoreProject as restoreStoredProject,
  stopAgent,
  isTauriRuntime,
  upsertProject,
} from "@/lib/melody-bridge";
import { useAppSettingsStore } from "@/stores/app-settings-store";

interface WorkspaceStore {
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  sessionsByProject: Record<string, SessionRecord[]>;
  activeProject?: ProjectRecord;
  activeSession?: SessionRecord;
  loading: boolean;
  initialized: boolean;
  /** The user dismissed the initial folder picker and needs a starting scope. */
  needsWorkspace: boolean;
  error?: string;
  initialize: () => Promise<void>;
  addProject: () => Promise<ProjectRecord | undefined>;
  archiveProject: (project: ProjectRecord) => Promise<void>;
  chooseProject: () => Promise<void>;
  deleteProject: (project: ProjectRecord) => Promise<ProjectDeleteResult>;
  selectProject: (project: ProjectRecord) => Promise<void>;
  restoreProject: (project: ProjectRecord) => Promise<void>;
  createSession: (
    project?: ProjectRecord,
  ) => Promise<SessionRecord | undefined>;
  deleteSession: (session: SessionRecord) => Promise<void>;
  selectSession: (session: SessionRecord) => void;
  replaceSession: (session: SessionRecord) => void;
}

const projectSelectionGate = new RequestGate();

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => {
  const pendingWorkspaceActions = new Set<symbol>();
  let pendingProjectSelectionToken: number | undefined;
  const isWorkspaceLoading = () =>
    pendingWorkspaceActions.size > 0 ||
    pendingProjectSelectionToken !== undefined;
  const beginWorkspaceAction = () => {
    const token = Symbol("workspace-action");
    pendingWorkspaceActions.add(token);
    set({ loading: true });
    return token;
  };
  const finishWorkspaceAction = (token: symbol) => {
    pendingWorkspaceActions.delete(token);
    set({ loading: isWorkspaceLoading() });
  };
  const beginProjectSelection = () => {
    const token = projectSelectionGate.begin();
    pendingProjectSelectionToken = token;
    set({ loading: true });
    return token;
  };
  const finishProjectSelection = (token: number) => {
    if (pendingProjectSelectionToken === token) {
      pendingProjectSelectionToken = undefined;
    }
    set({ loading: isWorkspaceLoading() });
  };
  const cancelProjectSelection = () => {
    projectSelectionGate.invalidate();
    pendingProjectSelectionToken = undefined;
    return isWorkspaceLoading();
  };

  return {
    projects: [],
    sessions: [],
    sessionsByProject: {},
    loading: true,
    initialized: false,
    needsWorkspace: false,
    initialize: async () => {
      if (get().initialized) {
        return;
      }
      const selectedProjectIdAtStart =
        get().activeProject?.id ?? get().activeSession?.projectId;
      const selectedSessionAtStart = get().activeSession;
      const selectionIntentToken =
        pendingProjectSelectionToken === undefined
          ? beginProjectSelection()
          : undefined;
      const operationToken = beginWorkspaceAction();
      set({ initialized: true, error: undefined });
      try {
        let projects = await listProjects();
        const defaultIndependentChat =
          useAppSettingsStore.getState().defaultIndependentChat;
        const hasRegularProjects = projects.some(
          (project) => !isIndependentProject(project),
        );
        let regularProjects = projects.filter(
          (project) => !isIndependentProject(project) && !project.archived,
        );
        const shouldPromptForWorkspace =
          projects.length === 0 ||
          (regularProjects.length === 0 &&
            !defaultIndependentChat &&
            !hasRegularProjects);
        if (shouldPromptForWorkspace) {
          const path = await pickWorkspaceDirectory();
          if (!path) {
            const sessionEntries = await Promise.all(
              projects.map(
                async (project) =>
                  [project.id, await listStoredSessions(project.id)] as const,
              ),
            );
            if (
              selectionIntentToken === undefined ||
              !projectSelectionGate.isCurrent(selectionIntentToken)
            ) {
              return;
            }
            set({
              activeProject: undefined,
              activeSession: undefined,
              error: undefined,
              needsWorkspace: true,
              projects,
              sessions: [],
              sessionsByProject: Object.fromEntries(sessionEntries),
            });
            return;
          }
          const project = await upsertProject(path);
          projects = [
            ...projects.filter((item) => isIndependentProject(item)),
            project,
          ];
          regularProjects = [project];
        }
        const sessionEntries = await Promise.all(
          projects.map(
            async (project) =>
              [project.id, await listStoredSessions(project.id)] as const,
          ),
        );
        const sessionsByProject = Object.fromEntries(sessionEntries);
        set({
          error: undefined,
          needsWorkspace: false,
          projects,
          sessionsByProject,
        });
        const independentProject = projects.find(isIndependentProject);
        const initialProject = defaultIndependentChat
          ? (independentProject ?? regularProjects[0])
          : (regularProjects[0] ?? independentProject);
        if (!initialProject) {
          throw new Error("请选择一个工作区后再继续。");
        }
        if (
          selectionIntentToken !== undefined &&
          projectSelectionGate.isCurrent(selectionIntentToken)
        ) {
          const activeSession = get().activeSession;
          const currentProjectId =
            get().activeProject?.id ?? activeSession?.projectId;
          const selectedProject =
            selectedProjectIdAtStart !== undefined &&
            currentProjectId === selectedProjectIdAtStart
              ? projects.find(
                  (project) => project.id === selectedProjectIdAtStart,
                )
              : undefined;
          const selectedProjectSessions = selectedProject
            ? sessionsByProject[selectedProject.id]
            : undefined;
          if (
            selectedSessionAtStart !== undefined &&
            activeSession !== undefined &&
            activeSession.id === selectedSessionAtStart.id &&
            activeSession.projectId === selectedSessionAtStart.projectId &&
            selectedProject !== undefined &&
            selectedProject.id === selectedSessionAtStart.projectId &&
            selectedProjectSessions !== undefined &&
            selectedProjectSessions.some(
              (session) => session.id === selectedSessionAtStart.id,
            )
          ) {
            const previousSessionsById = new Map(
              (get().sessionsByProject[selectedProject.id] ?? []).map(
                (session) => [session.id, session],
              ),
            );
            const sessions = selectedProjectSessions.map((session) =>
              session.id === activeSession.id
                ? activeSession
                : (previousSessionsById.get(session.id) ?? session),
            );
            set({
              activeProject: selectedProject,
              sessions,
              sessionsByProject: {
                ...sessionsByProject,
                [selectedProject.id]: sessions,
              },
            });
            return;
          }
          await get().selectProject(selectedProject ?? initialProject);
        }
      } catch (reason) {
        set({ initialized: false, error: toUserMessage(reason) });
      } finally {
        if (selectionIntentToken !== undefined) {
          finishProjectSelection(selectionIntentToken);
        }
        finishWorkspaceAction(operationToken);
      }
    },
    addProject: async () => {
      const path = await pickWorkspaceDirectory();
      if (!path) {
        return undefined;
      }
      set({ error: undefined });
      try {
        const project = await upsertProject(path);
        set((state) => ({
          needsWorkspace: false,
          projects: [
            project,
            ...state.projects.filter((item) => item.id !== project.id),
          ],
        }));
        return project;
      } catch (reason) {
        set({ error: toUserMessage(reason) });
        return undefined;
      }
    },
    archiveProject: async (project) => {
      if (isIndependentProject(project)) {
        return;
      }
      const operationToken = beginWorkspaceAction();
      set({ error: undefined });
      try {
        const archivedProject = await archiveStoredProject(project.id);
        const state = get();
        const projects = state.projects.map((item) =>
          item.id === archivedProject.id ? archivedProject : item,
        );
        if (state.activeProject?.id !== project.id) {
          set({ projects });
          return;
        }
        const replacement =
          projects.find(
            (item) => !isIndependentProject(item) && !item.archived,
          ) ?? projects.find((item) => isIndependentProject(item));
        set({ projects });
        if (replacement) {
          await get().selectProject(replacement);
        }
      } catch (reason) {
        set({ error: toUserMessage(reason) });
      } finally {
        finishWorkspaceAction(operationToken);
      }
    },
    chooseProject: async () => {
      const path = await pickWorkspaceDirectory();
      if (!path) {
        return;
      }
      const operationToken = beginWorkspaceAction();
      const selectionToken = beginProjectSelection();
      set({ error: undefined });
      try {
        const project = await upsertProject(path);
        const projects = [
          project,
          ...get().projects.filter((item) => item.id !== project.id),
        ];
        set({ projects });
        if (projectSelectionGate.isCurrent(selectionToken)) {
          await get().selectProject(project);
        }
      } catch (reason) {
        set({ error: toUserMessage(reason) });
      } finally {
        finishProjectSelection(selectionToken);
        finishWorkspaceAction(operationToken);
      }
    },
    deleteProject: async (project) => {
      if (isIndependentProject(project)) {
        return { deleted: false, error: "独立任务不能删除。" };
      }
      // Browser preview owns its agent in the renderer. Desktop deletion is
      // cleaned up by the Host using session bindings and workspace-scoped Pi
      // lifecycle before it removes project/session rows.
      if (get().activeProject?.id === project.id && !isTauriRuntime()) {
        try {
          await stopAgent();
        } catch {
          // Deleting the local project record remains possible if the agent has
          // already exited or the stop notification is unavailable.
        }
      }
      const operationToken = beginWorkspaceAction();
      set({ error: undefined });
      try {
        await deleteStoredProject(project.id);
        const state = get();
        const projects = state.projects.filter(
          (item) => item.id !== project.id,
        );
        const sessionsByProject = { ...state.sessionsByProject };
        delete sessionsByProject[project.id];
        if (state.activeProject?.id !== project.id) {
          set({ projects, sessionsByProject });
          return { deleted: true };
        }
        const replacement =
          projects.find(
            (item) => !isIndependentProject(item) && !item.archived,
          ) ?? projects.find((item) => isIndependentProject(item));
        set({ projects, sessionsByProject });
        if (replacement) {
          await get().selectProject(replacement);
        } else {
          set({
            activeProject: undefined,
            activeSession: undefined,
            sessions: [],
            needsWorkspace: true,
          });
        }
        return { deleted: true };
      } catch (reason) {
        const detail = rawErrorMessage(reason);
        const error = detail
          ? `删除项目失败：${detail}`
          : "删除项目失败，请重试。";
        set({ error: toUserMessage(reason) });
        return { deleted: false, error };
      } finally {
        finishWorkspaceAction(operationToken);
      }
    },
    selectProject: async (project) => {
      const selectionToken = beginProjectSelection();
      set({
        activeProject: project,
        activeSession: undefined,
        sessions: [],
        needsWorkspace: false,
        error: undefined,
      });
      try {
        let sessions = get().sessionsByProject[project.id];
        if (!sessions) {
          sessions = await listStoredSessions(project.id);
        }
        if (!projectSelectionGate.isCurrent(selectionToken)) {
          return;
        }
        if (sessions.length === 0) {
          sessions = [await createStoredSession(project.id, project.path)];
        }
        if (!projectSelectionGate.isCurrent(selectionToken)) {
          return;
        }
        set((state) => ({
          activeProject: project,
          activeSession: sessions[0],
          sessions,
          sessionsByProject: {
            ...state.sessionsByProject,
            [project.id]: sessions,
          },
        }));
      } catch (reason) {
        if (!projectSelectionGate.isCurrent(selectionToken)) {
          return;
        }
        set({ error: toUserMessage(reason) });
      } finally {
        finishProjectSelection(selectionToken);
      }
    },
    restoreProject: async (project) => {
      if (isIndependentProject(project)) {
        return;
      }
      const operationToken = beginWorkspaceAction();
      set({ error: undefined });
      try {
        const restoredProject = await restoreStoredProject(project.id);
        set((state) => ({
          activeProject:
            state.activeProject?.id === restoredProject.id
              ? restoredProject
              : state.activeProject,
          projects: state.projects.map((item) =>
            item.id === restoredProject.id ? restoredProject : item,
          ),
        }));
      } catch (reason) {
        set({ error: toUserMessage(reason) });
      } finally {
        finishWorkspaceAction(operationToken);
      }
    },
    createSession: async (requestedProject) => {
      const project = requestedProject ?? get().activeProject;
      if (!project || (project.archived && !isIndependentProject(project))) {
        return;
      }
      const operationToken = beginWorkspaceAction();
      set({ error: undefined });
      try {
        const session = await createStoredSession(project.id, project.path);
        set((state) => {
          const projectSessions = [
            session,
            ...(state.sessionsByProject[project.id] ?? []),
          ];
          return {
            activeProject: project,
            activeSession: session,
            sessions: projectSessions,
            sessionsByProject: {
              ...state.sessionsByProject,
              [project.id]: projectSessions,
            },
          };
        });
        return session;
      } catch (reason) {
        set({ error: toUserMessage(reason) });
        return undefined;
      } finally {
        finishWorkspaceAction(operationToken);
      }
    },
    deleteSession: async (session) => {
      const project = get().projects.find(
        (item) => item.id === session.projectId,
      );
      if (!project) {
        return;
      }
      const operationToken = beginWorkspaceAction();
      set({ error: undefined });
      let deletedProjectSessions: SessionRecord[] | undefined;
      try {
        // On Desktop, delete_session owns Pi cleanup in the Host. Avoid a
        // renderer-wide stop: the target may be an ACP archive while another
        // Pi session in this project is active.
        await deleteStoredSession(session.id);
        const state = get();
        let projectSessions = (
          state.sessionsByProject[project.id] ?? []
        ).filter((item) => item.id !== session.id);
        deletedProjectSessions = projectSessions;
        const deletingActiveSession = state.activeSession?.id === session.id;
        if (deletingActiveSession) {
          if (projectSessions.length === 0) {
            projectSessions = [
              await createStoredSession(project.id, project.path),
            ];
            deletedProjectSessions = projectSessions;
          }
        }
        set((current) => ({
          sessions:
            current.activeProject?.id === project.id
              ? projectSessions
              : current.sessions,
          activeSession:
            deletingActiveSession &&
            current.activeProject?.id === project.id &&
            current.activeSession?.id === session.id
              ? projectSessions[0]
              : current.activeSession,
          sessionsByProject: {
            ...current.sessionsByProject,
            [project.id]: projectSessions,
          },
        }));
      } catch (reason) {
        const remainingSessions = deletedProjectSessions;
        if (!remainingSessions) {
          set({ error: toUserMessage(reason) });
          return;
        }
        set((current) => ({
          sessions:
            current.activeProject?.id === project.id
              ? remainingSessions
              : current.sessions,
          activeSession:
            current.activeProject?.id === project.id &&
            current.activeSession?.id === session.id
              ? remainingSessions[0]
              : current.activeSession,
          sessionsByProject: {
            ...current.sessionsByProject,
            [project.id]: remainingSessions,
          },
          error: toUserMessage(reason),
        }));
      } finally {
        finishWorkspaceAction(operationToken);
      }
    },
    selectSession: (session) => {
      // A later session selection supersedes an in-flight project activation.
      const loading = cancelProjectSelection();
      set((state) => {
        const project = state.projects.find(
          (item) => item.id === session.projectId,
        );
        return {
          activeProject: project ?? state.activeProject,
          activeSession: session,
          sessions:
            state.sessionsByProject[session.projectId] ?? state.sessions,
          loading,
        };
      });
    },
    replaceSession: (session) =>
      set((state) => ({
        activeSession:
          state.activeSession?.id === session.id
            ? session
            : state.activeSession,
        sessions: state.sessions.map((item) =>
          item.id === session.id ? session : item,
        ),
        sessionsByProject: {
          ...state.sessionsByProject,
          [session.projectId]: (
            state.sessionsByProject[session.projectId] ?? []
          ).map((item) => (item.id === session.id ? session : item)),
        },
      })),
  };
});
