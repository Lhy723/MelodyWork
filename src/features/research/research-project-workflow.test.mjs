import assert from "node:assert/strict";
import test from "node:test";

import { useResearchStore } from "./research-store.ts";

const paper = (id, saved = false) => ({
  id,
  title: `Paper ${id}`,
  authors: ["Researcher"],
  url: `https://example.com/${id}`,
  sources: ["Crossref"],
  verified: false,
  saved,
  addedAt: 1,
});

const projectState = (patch = {}) => ({
  papers: [],
  searchHistory: [],
  trackingTopics: [],
  notes: [],
  tasks: [],
  inbox: undefined,
  ...patch,
});

const resetProject = (project) => {
  useResearchStore.setState({
    activeProjectId: "project-1",
    ...project,
    projects: { "project-1": project },
  });
};

test("records inbox and search history as one Research Project workflow", () => {
  resetProject(projectState({ papers: [paper("p1", true)] }));

  useResearchStore.getState().recordSearchResult({
    query: "agent evaluation",
    searchQuery: "agent evaluation benchmark",
    terms: ["agent", "evaluation", "benchmark"],
    result: {
      papers: [paper("p1"), paper("p2")],
      sources: ["Crossref"],
      warnings: [],
      sourceRuns: [
        {
          source: "Crossref",
          status: "success",
          resultCount: 2,
          query: "agent evaluation benchmark",
          checkedAt: 10,
        },
      ],
    },
  });

  const state = useResearchStore.getState();
  assert.equal(state.inbox.query, "agent evaluation");
  assert.equal(state.inbox.papers[0].saved, true);
  assert.equal(state.searchHistory.length, 1);
  assert.equal(state.searchHistory[0].resultCount, 2);
  assert.deepEqual(state.searchHistory[0].terms, [
    "agent",
    "evaluation",
    "benchmark",
  ]);
  assert.deepEqual(state.projects["project-1"], {
    papers: state.papers,
    searchHistory: state.searchHistory,
    trackingTopics: state.trackingTopics,
    notes: state.notes,
    tasks: state.tasks,
    inbox: state.inbox,
  });
});

test("refreshes a Tracking Topic without dropping paper identity", () => {
  resetProject(
    projectState({
      papers: [paper("p1", true)],
      trackingTopics: [
        {
          id: "topic-1",
          title: "Agent evaluation",
          query: "agent evaluation benchmark",
          cadence: "weekly",
          latestCount: 0,
        },
      ],
    }),
  );

  useResearchStore
    .getState()
    .refreshTrackingTopic("topic-1", [paper("p1"), paper("p2")], 123);

  const state = useResearchStore.getState();
  assert.equal(state.papers.length, 2);
  assert.equal(state.papers.find((item) => item.id === "p1").saved, true);
  assert.deepEqual(state.trackingTopics[0], {
    id: "topic-1",
    title: "Agent evaluation",
    query: "agent evaluation benchmark",
    cadence: "weekly",
    latestCount: 2,
    lastCheckedAt: 123,
    paperIds: ["p1", "p2"],
  });
  assert.deepEqual(
    state.projects["project-1"].trackingTopics,
    state.trackingTopics,
  );
});
