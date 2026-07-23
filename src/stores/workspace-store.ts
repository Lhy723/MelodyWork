import { create } from "zustand";

import type { ProjectRecord, SessionRecord } from "@/domain/workspace";
import {
  createStoredSession,
  listProjects,
  listStoredSessions,
  pickWorkspaceDirectory,
  upsertProject,
} from "@/lib/melody-bridge";

interface WorkspaceStore {
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  activeProject?: ProjectRecord;
  activeSession?: SessionRecord;
  loading: boolean;
  initialized: boolean;
  error?: string;
  initialize: () => Promise<void>;
  chooseProject: () => Promise<void>;
  selectProject: (project: ProjectRecord) => Promise<void>;
  createSession: () => Promise<void>;
  selectSession: (session: SessionRecord) => void;
  replaceSession: (session: SessionRecord) => void;
}

const messageFrom = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  projects: [],
  sessions: [],
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
      set({ projects });
      await get().selectProject(projects[0]);
    } catch (reason) {
      set({ error: messageFrom(reason), loading: false });
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
      let sessions = await listStoredSessions(project.id);
      if (sessions.length === 0) {
        sessions = [await createStoredSession(project.id, project.path)];
      }
      set({
        activeProject: project,
        activeSession: sessions[0],
        sessions,
        loading: false,
      });
    } catch (reason) {
      set({ error: messageFrom(reason), loading: false });
    }
  },
  createSession: async () => {
    const project = get().activeProject;
    if (!project) {
      return;
    }
    set({ loading: true, error: undefined });
    try {
      const session = await createStoredSession(project.id, project.path);
      set((state) => ({
        activeSession: session,
        sessions: [session, ...state.sessions],
        loading: false,
      }));
    } catch (reason) {
      set({ error: messageFrom(reason), loading: false });
    }
  },
  selectSession: (session) => set({ activeSession: session }),
  replaceSession: (session) =>
    set((state) => ({
      activeSession:
        state.activeSession?.id === session.id
          ? session
          : state.activeSession,
      sessions: state.sessions.map((item) =>
        item.id === session.id ? session : item,
      ),
    })),
}));
