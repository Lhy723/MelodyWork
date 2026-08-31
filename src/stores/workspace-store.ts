import { create } from "zustand";

import { rawErrorMessage, toUserMessage } from "@/domain/app-error";
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

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  projects: [],
  sessions: [],
  sessionsByProject: {},
  loading: true,
  initialized: false,
  initialize: async () => {
    if (get().initialized) {
      return;
    }
    set({ initialized: true, loading: true, error: undefined });
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
      if (
        regularProjects.length === 0 &&
        !defaultIndependentChat &&
        !hasRegularProjects
      ) {
        const path = await pickWorkspaceDirectory();
        if (!path) {
          throw new Error("请选择一个工作区后再继续。");
        }
        const project = await upsertProject(path);
        projects = [
          ...projects.filter((item) => isIndependentProject(item)),
          project,
        ];
        regularProjects = [project];
      } else if (projects.length === 0) {
        const path = await pickWorkspaceDirectory();
        if (!path) {
          throw new Error("请选择一个工作区后再继续。");
        }
        const project = await upsertProject(path);
        projects = [project];
        regularProjects = [project];
      }
      const sessionEntries = await Promise.all(
        projects.map(
          async (project) =>
            [project.id, await listStoredSessions(project.id)] as const,
        ),
      );
      set({
        projects,
        sessionsByProject: Object.fromEntries(sessionEntries),
      });
      const independentProject = projects.find(isIndependentProject);
      const initialProject = defaultIndependentChat
        ? (independentProject ?? regularProjects[0])
        : (regularProjects[0] ?? independentProject);
      if (!initialProject) {
        throw new Error("请选择一个工作区后再继续。");
      }
      await get().selectProject(initialProject);
    } catch (reason) {
      set({ error: toUserMessage(reason), loading: false });
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
    set({ loading: true, error: undefined });
    try {
      const archivedProject = await archiveStoredProject(project.id);
      const state = get();
      const projects = state.projects.map((item) =>
        item.id === archivedProject.id ? archivedProject : item,
      );
      if (state.activeProject?.id !== project.id) {
        set({ projects, loading: false });
        return;
      }
      const replacement =
        projects.find(
          (item) => !isIndependentProject(item) && !item.archived,
        ) ?? projects.find((item) => isIndependentProject(item));
      set({ projects });
      if (replacement) {
        await get().selectProject(replacement);
      } else {
        set({ loading: false });
      }
    } catch (reason) {
      set({ error: toUserMessage(reason), loading: false });
    }
  },
  chooseProject: async () => {
    const path = await pickWorkspaceDirectory();
    if (!path) {
      return;
    }
    set({ loading: true, error: undefined });
    try {
      const project = await upsertProject(path);
      const projects = [
        project,
        ...get().projects.filter((item) => item.id !== project.id),
      ];
      set({ projects });
      await get().selectProject(project);
    } catch (reason) {
      set({ error: toUserMessage(reason), loading: false });
    }
  },
  deleteProject: async (project) => {
    if (isIndependentProject(project)) {
      return { deleted: false, error: "独立任务不能删除。" };
    }
    // Stop the active ACP session before removing its database rows. This
    // prevents a final persistence flush from racing the project deletion.
    if (get().activeProject?.id === project.id) {
      try {
        await stopAgent();
      } catch {
        // Deleting the local project record remains possible if the agent has
        // already exited or the stop notification is unavailable.
      }
    }
    set({ loading: true, error: undefined });
    try {
      await deleteStoredProject(project.id);
      const state = get();
      const projects = state.projects.filter((item) => item.id !== project.id);
      const sessionsByProject = { ...state.sessionsByProject };
      delete sessionsByProject[project.id];
      if (state.activeProject?.id !== project.id) {
        set({ projects, sessionsByProject, loading: false });
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
          loading: false,
        });
      }
      return { deleted: true };
    } catch (reason) {
      const detail = rawErrorMessage(reason);
      const error = detail
        ? `删除项目失败：${detail}`
        : "删除项目失败，请重试。";
      set({ error: toUserMessage(reason), loading: false });
      return { deleted: false, error };
    }
  },
  selectProject: async (project) => {
    set({
      activeProject: project,
      activeSession: undefined,
      sessions: [],
      loading: true,
      error: undefined,
    });
    try {
      let sessions = get().sessionsByProject[project.id];
      if (!sessions) {
        sessions = await listStoredSessions(project.id);
      }
      if (sessions.length === 0) {
        sessions = [await createStoredSession(project.id, project.path)];
      }
      set((state) => ({
        activeProject: project,
        activeSession: sessions[0],
        sessions,
        sessionsByProject: {
          ...state.sessionsByProject,
          [project.id]: sessions,
        },
        loading: false,
      }));
    } catch (reason) {
      set({ error: toUserMessage(reason), loading: false });
    }
  },
  restoreProject: async (project) => {
    if (isIndependentProject(project)) {
      return;
    }
    set({ loading: true, error: undefined });
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
        loading: false,
      }));
    } catch (reason) {
      set({ error: toUserMessage(reason), loading: false });
    }
  },
  createSession: async (requestedProject) => {
    const project = requestedProject ?? get().activeProject;
    if (!project || (project.archived && !isIndependentProject(project))) {
      return;
    }
    set({ loading: true, error: undefined });
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
          loading: false,
        };
      });
      return session;
    } catch (reason) {
      set({ error: toUserMessage(reason), loading: false });
      return undefined;
    }
  },
  deleteSession: async (session) => {
    const project = get().projects.find(
      (item) => item.id === session.projectId,
    );
    if (!project) {
      return;
    }
    set({ loading: true, error: undefined });
    try {
      await deleteStoredSession(session.id);
      const state = get();
      let projectSessions = (state.sessionsByProject[project.id] ?? []).filter(
        (item) => item.id !== session.id,
      );
      let activeSession = state.activeSession;
      if (activeSession?.id === session.id) {
        if (projectSessions.length === 0) {
          projectSessions = [
            await createStoredSession(project.id, project.path),
          ];
        }
        activeSession = projectSessions[0];
      }
      set((current) => ({
        sessions:
          current.activeProject?.id === project.id
            ? projectSessions
            : current.sessions,
        activeSession,
        sessionsByProject: {
          ...current.sessionsByProject,
          [project.id]: projectSessions,
        },
        loading: false,
      }));
    } catch (reason) {
      set({ error: toUserMessage(reason), loading: false });
    }
  },
  selectSession: (session) =>
    set((state) => {
      const project = state.projects.find(
        (item) => item.id === session.projectId,
      );
      return {
        activeProject: project ?? state.activeProject,
        activeSession: session,
        sessions: state.sessionsByProject[session.projectId] ?? state.sessions,
      };
    }),
  replaceSession: (session) =>
    set((state) => ({
      activeSession:
        state.activeSession?.id === session.id ? session : state.activeSession,
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
}));
