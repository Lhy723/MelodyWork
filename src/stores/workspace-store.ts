import { create } from "zustand";

import type { ProjectRecord, SessionRecord } from "@/domain/workspace";
import {
  createStoredSession,
  deleteStoredSession,
  listProjects,
  listStoredSessions,
  pickWorkspaceDirectory,
  upsertProject,
} from "@/lib/melody-bridge";

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
  chooseProject: () => Promise<void>;
  selectProject: (project: ProjectRecord) => Promise<void>;
  createSession: (project?: ProjectRecord) => Promise<void>;
  deleteSession: (session: SessionRecord) => Promise<void>;
  selectSession: (session: SessionRecord) => void;
  replaceSession: (session: SessionRecord) => void;
}

const messageFrom = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

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
      if (projects.length === 0) {
        projects = [await upsertProject(".")];
      }
      const sessionEntries = await Promise.all(
        projects.map(async (project) => [
          project.id,
          await listStoredSessions(project.id),
        ] as const),
      );
      set({
        projects,
        sessionsByProject: Object.fromEntries(sessionEntries),
      });
      await get().selectProject(projects[0]);
    } catch (reason) {
      set({ error: messageFrom(reason), loading: false });
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
      set({ error: messageFrom(reason) });
      return undefined;
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
      set({ error: messageFrom(reason), loading: false });
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
      set({ error: messageFrom(reason), loading: false });
    }
  },
  createSession: async (requestedProject) => {
    const project = requestedProject ?? get().activeProject;
    if (!project) {
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
    } catch (reason) {
      set({ error: messageFrom(reason), loading: false });
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
      let projectSessions = (
        state.sessionsByProject[project.id] ?? []
      ).filter((item) => item.id !== session.id);
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
      set({ error: messageFrom(reason), loading: false });
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
        sessions:
          state.sessionsByProject[session.projectId] ?? state.sessions,
      };
    }),
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
}));
