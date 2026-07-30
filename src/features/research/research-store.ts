import { create } from "zustand";
import { persist } from "zustand/middleware";

import type {
  ResearchPaper,
  ResearchSearchHistoryItem,
  ResearchTrackingTopic,
} from "@/domain/research";

interface ResearchStore {
  papers: ResearchPaper[];
  searchHistory: ResearchSearchHistoryItem[];
  trackingTopics: ResearchTrackingTopic[];
  addPapers: (papers: ResearchPaper[]) => void;
  addSearchHistory: (query: string, resultCount: number) => void;
  addTrackingTopic: (title: string, query: string) => void;
  removeTrackingTopic: (id: string) => void;
  removePaper: (id: string) => void;
  setPaperSaved: (id: string, saved: boolean) => void;
  updateTrackingTopic: (
    id: string,
    patch: Partial<ResearchTrackingTopic>,
  ) => void;
}

export const useResearchStore = create<ResearchStore>()(
  persist(
    (set) => ({
      papers: [],
      searchHistory: [],
      trackingTopics: [],
      addPapers: (papers) =>
        set((state) => {
          const byId = new Map(state.papers.map((paper) => [paper.id, paper]));
          for (const paper of papers) {
            const current = byId.get(paper.id);
            byId.set(paper.id, {
              ...current,
              ...paper,
              saved: current?.saved || paper.saved,
            });
          }
          return { papers: Array.from(byId.values()) };
        }),
      addSearchHistory: (query, resultCount) =>
        set((state) => ({
          searchHistory: [
            {
              id: crypto.randomUUID(),
              query,
              createdAt: Date.now(),
              resultCount,
            },
            ...state.searchHistory,
          ].slice(0, 30),
        })),
      addTrackingTopic: (title, query) =>
        set((state) => ({
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
        })),
      removePaper: (id) =>
        set((state) => ({
          papers: state.papers.filter((paper) => paper.id !== id),
        })),
      removeTrackingTopic: (id) =>
        set((state) => ({
          trackingTopics: state.trackingTopics.filter(
            (topic) => topic.id !== id,
          ),
        })),
      setPaperSaved: (id, saved) =>
        set((state) => ({
          papers: state.papers.map((paper) =>
            paper.id === id ? { ...paper, saved } : paper,
          ),
        })),
      updateTrackingTopic: (id, patch) =>
        set((state) => ({
          trackingTopics: state.trackingTopics.map((topic) =>
            topic.id === id ? { ...topic, ...patch } : topic,
          ),
        })),
    }),
    {
      name: "melodyresearch.library.v2",
      version: 2,
      partialize: ({ papers, searchHistory, trackingTopics }) => ({
        papers,
        searchHistory,
        trackingTopics,
      }),
    },
  ),
);
