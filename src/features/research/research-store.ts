import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type {
  ResearchInbox,
  ResearchNote,
  ResearchPaper,
  ResearchSearchHistoryItem,
  ResearchSearchResult,
  ResearchTask,
  ResearchTrackingTopic,
} from "@/domain/research";

export interface ResearchProjectState {
  papers: ResearchPaper[];
  searchHistory: ResearchSearchHistoryItem[];
  trackingTopics: ResearchTrackingTopic[];
  notes: ResearchNote[];
  tasks: ResearchTask[];
  inbox?: ResearchInbox;
}

const EMPTY_PROJECT: ResearchProjectState = {
  papers: [],
  searchHistory: [],
  trackingTopics: [],
  notes: [],
  tasks: [],
  inbox: undefined,
};

const UNSCOPED_PROJECT_ID = "__melodyresearch_unscoped__";

const researchStorage = createJSONStorage(() =>
  typeof window === "undefined"
    ? {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => undefined,
      }
    : window.localStorage,
);

interface ResearchStore extends ResearchProjectState {
  activeProjectId?: string;
  projects: Record<string, ResearchProjectState>;
  setActiveProject: (projectId?: string) => void;
  replaceActiveProject: (project: Partial<ResearchProjectState>) => void;
  addPapers: (papers: ResearchPaper[]) => void;
  recordSearchResult: (record: {
    query: string;
    searchQuery: string;
    terms: string[];
    result: ResearchSearchResult;
  }) => void;
  clearResearchInbox: () => void;
  addTrackingTopic: (title: string, query: string) => void;
  refreshTrackingTopic: (
    id: string,
    papers: ResearchPaper[],
    checkedAt?: number,
  ) => void;
  addResearchNote: (
    content: string,
    metadata?: Pick<ResearchNote, "kind" | "linkedPaperIds" | "tags">,
  ) => void;
  updateResearchNote: (id: string, content: string) => void;
  removeResearchNote: (id: string) => void;
  addResearchTask: (
    title: string,
    metadata?: Pick<ResearchTask, "linkedPaperId" | "source">,
  ) => void;
  toggleResearchTask: (id: string, completed: boolean) => void;
  removeResearchTask: (id: string) => void;
  removeTrackingTopic: (id: string) => void;
  removePaper: (id: string) => void;
  setPaperSaved: (id: string, saved: boolean) => void;
}

const cloneProjectState = (state?: Partial<ResearchProjectState>) => ({
  papers: state?.papers ?? [],
  searchHistory: state?.searchHistory ?? [],
  trackingTopics: state?.trackingTopics ?? [],
  notes: state?.notes ?? [],
  tasks: state?.tasks ?? [],
  inbox: state?.inbox,
});

const storageProjectId = (projectId?: string) =>
  projectId || UNSCOPED_PROJECT_ID;

const updateActiveProject = (
  state: ResearchStore,
  patch: Partial<ResearchProjectState>,
) => {
  const nextProject = {
    papers: patch.papers ?? state.papers,
    searchHistory: patch.searchHistory ?? state.searchHistory,
    trackingTopics: patch.trackingTopics ?? state.trackingTopics,
    notes: patch.notes ?? state.notes,
    tasks: patch.tasks ?? state.tasks,
    inbox: "inbox" in patch ? patch.inbox : state.inbox,
  };
  const projectId = storageProjectId(state.activeProjectId);
  return {
    ...nextProject,
    projects: {
      ...state.projects,
      [projectId]: nextProject,
    },
  };
};

const mergeProjectPapers = (
  state: Pick<ResearchProjectState, "papers" | "inbox">,
  papers: ResearchPaper[],
) => {
  const byId = new Map(state.papers.map((paper) => [paper.id, paper]));
  for (const paper of papers) {
    const current = byId.get(paper.id);
    byId.set(paper.id, {
      ...current,
      ...paper,
      saved: current?.saved || paper.saved,
    });
  }
  return {
    papers: Array.from(byId.values()),
    inbox: state.inbox
      ? {
          ...state.inbox,
          papers: state.inbox.papers.map(
            (paper) => byId.get(paper.id) ?? paper,
          ),
        }
      : undefined,
  };
};

type PersistedResearchState = Partial<ResearchStore> & {
  papers?: ResearchPaper[];
  searchHistory?: ResearchSearchHistoryItem[];
  trackingTopics?: ResearchTrackingTopic[];
  notes?: ResearchNote[];
  tasks?: ResearchTask[];
  inbox?: ResearchInbox;
};

export const useResearchStore = create<ResearchStore>()(
  persist(
    (set) => ({
      ...EMPTY_PROJECT,
      projects: {},
      setActiveProject: (projectId) =>
        set((state) => {
          const nextStorageId = storageProjectId(projectId);
          let projects = state.projects;
          let nextProject = projects[nextStorageId];

          // Older versions stored one global library. Keep it usable by
          // assigning it to the first real project the user opens.
          if (
            !nextProject &&
            projectId &&
            projects[UNSCOPED_PROJECT_ID] &&
            Object.keys(projects).length === 1
          ) {
            nextProject = projects[UNSCOPED_PROJECT_ID];
            projects = {
              ...projects,
              [projectId]: nextProject,
            };
            delete projects[UNSCOPED_PROJECT_ID];
          }

          nextProject = nextProject ?? EMPTY_PROJECT;
          return {
            activeProjectId: projectId,
            ...cloneProjectState(nextProject),
            projects,
          };
        }),
      replaceActiveProject: (project) =>
        set((state) =>
          updateActiveProject(state, {
            papers: project.papers ?? [],
            searchHistory: project.searchHistory ?? [],
            trackingTopics: project.trackingTopics ?? [],
            notes: project.notes ?? [],
            tasks: project.tasks ?? [],
            inbox: project.inbox,
          }),
        ),
      addPapers: (papers) =>
        set((state) =>
          updateActiveProject(state, mergeProjectPapers(state, papers)),
        ),
      recordSearchResult: ({ query, searchQuery, terms, result }) =>
        set((state) => {
          const library = new Map(
            state.papers.map((paper) => [paper.id, paper]),
          );
          return updateActiveProject(state, {
            inbox: {
              query,
              searchQuery,
              createdAt: Date.now(),
              papers: result.papers.map((paper) => ({
                ...paper,
                saved: library.get(paper.id)?.saved || paper.saved,
              })),
              sourceRuns: result.sourceRuns,
            },
            searchHistory: [
              {
                id: crypto.randomUUID(),
                query,
                searchQuery,
                terms,
                sources: result.sources,
                createdAt: Date.now(),
                resultCount: result.papers.length,
              },
              ...state.searchHistory,
            ].slice(0, 30),
          });
        }),
      clearResearchInbox: () =>
        set((state) => updateActiveProject(state, { inbox: undefined })),
      addTrackingTopic: (title, query) =>
        set((state) =>
          updateActiveProject(state, {
            trackingTopics: [
              ...state.trackingTopics,
              {
                id: crypto.randomUUID(),
                title,
                query,
                cadence: "weekly",
                latestCount: 0,
              },
            ],
          }),
        ),
      refreshTrackingTopic: (id, papers, checkedAt = Date.now()) =>
        set((state) => {
          const merged = mergeProjectPapers(state, papers);
          return updateActiveProject(state, {
            ...merged,
            trackingTopics: state.trackingTopics.map((topic) =>
              topic.id === id
                ? {
                    ...topic,
                    lastCheckedAt: checkedAt,
                    latestCount: papers.length,
                    paperIds: papers.map((paper) => paper.id),
                  }
                : topic,
            ),
          });
        }),
      addResearchNote: (content, metadata) =>
        set((state) =>
          updateActiveProject(state, {
            notes: [
              {
                id: crypto.randomUUID(),
                content: content.trim(),
                createdAt: Date.now(),
                kind: metadata?.kind ?? "note",
                linkedPaperIds: metadata?.linkedPaperIds,
                tags: metadata?.tags,
              },
              ...state.notes,
            ].slice(0, 200),
          }),
        ),
      updateResearchNote: (id, content) =>
        set((state) =>
          updateActiveProject(state, {
            notes: state.notes.map((note) =>
              note.id === id
                ? { ...note, content: content.trim(), updatedAt: Date.now() }
                : note,
            ),
          }),
        ),
      removeResearchNote: (id) =>
        set((state) =>
          updateActiveProject(state, {
            notes: state.notes.filter((note) => note.id !== id),
          }),
        ),
      addResearchTask: (title, metadata) =>
        set((state) =>
          updateActiveProject(state, {
            tasks: [
              {
                id: crypto.randomUUID(),
                title: title.trim(),
                completed: false,
                createdAt: Date.now(),
                linkedPaperId: metadata?.linkedPaperId,
                source: metadata?.source ?? "manual",
              },
              ...state.tasks,
            ].slice(0, 100),
          }),
        ),
      toggleResearchTask: (id, completed) =>
        set((state) =>
          updateActiveProject(state, {
            tasks: state.tasks.map((task) =>
              task.id === id
                ? {
                    ...task,
                    completed,
                    completedAt: completed ? Date.now() : undefined,
                  }
                : task,
            ),
          }),
        ),
      removeResearchTask: (id) =>
        set((state) =>
          updateActiveProject(state, {
            tasks: state.tasks.filter((task) => task.id !== id),
          }),
        ),
      removePaper: (id) =>
        set((state) =>
          updateActiveProject(state, {
            papers: state.papers.filter((paper) => paper.id !== id),
            inbox: state.inbox
              ? {
                  ...state.inbox,
                  papers: state.inbox.papers.map((paper) =>
                    paper.id === id ? { ...paper, saved: false } : paper,
                  ),
                }
              : undefined,
          }),
        ),
      removeTrackingTopic: (id) =>
        set((state) =>
          updateActiveProject(state, {
            trackingTopics: state.trackingTopics.filter(
              (topic) => topic.id !== id,
            ),
          }),
        ),
      setPaperSaved: (id, saved) =>
        set((state) =>
          updateActiveProject(state, {
            papers: state.papers.map((paper) =>
              paper.id === id ? { ...paper, saved } : paper,
            ),
            inbox: state.inbox
              ? {
                  ...state.inbox,
                  papers: state.inbox.papers.map((paper) =>
                    paper.id === id ? { ...paper, saved } : paper,
                  ),
                }
              : undefined,
          }),
        ),
    }),
    {
      // Keep the existing storage key so v2 libraries can be migrated instead
      // of silently disappearing after the project-scoping change.
      name: "melodyresearch.library.v2",
      storage: researchStorage,
      version: 4,
      partialize: ({
        activeProjectId,
        inbox,
        papers,
        projects,
        searchHistory,
        trackingTopics,
        notes,
        tasks,
      }) => ({
        activeProjectId,
        inbox,
        papers,
        projects,
        searchHistory,
        trackingTopics,
        notes,
        tasks,
      }),
      migrate: (persisted, version) => {
        const previous = persisted as PersistedResearchState;
        if (version < 3 || !previous.projects) {
          const legacy = cloneProjectState(previous);
          return {
            activeProjectId: undefined,
            ...legacy,
            projects: {
              [UNSCOPED_PROJECT_ID]: legacy,
            },
          };
        }
        if (version < 4) {
          const projects = Object.fromEntries(
            Object.entries(previous.projects).map(([id, project]) => [
              id,
              cloneProjectState(project),
            ]),
          );
          return {
            ...previous,
            projects,
            notes: previous.notes ?? [],
            tasks: previous.tasks ?? [],
          };
        }
        return persisted;
      },
    },
  ),
);
