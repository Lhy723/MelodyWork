import type {
  ResearchNote,
  ResearchPaper,
  ResearchSearchHistoryItem,
  ResearchTask,
  ResearchTrackingTopic,
} from "@/domain/research";

import type { ResearchProjectState } from "./research-store";
import type { ActivityItem } from "./research-activity";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const parseProjectBackup = (
  value: unknown,
): Partial<ResearchProjectState> => {
  const source = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(source)) {
    throw new Error("备份文件格式不正确。");
  }

  const arrayFields = [
    "papers",
    "searchHistory",
    "trackingTopics",
    "notes",
    "tasks",
  ] as const;
  for (const field of arrayFields) {
    if (source[field] !== undefined && !Array.isArray(source[field])) {
      throw new Error(`备份文件中的“${field}”不是有效列表。`);
    }
  }

  return {
    papers: (source.papers as ResearchProjectState["papers"] | undefined) ?? [],
    searchHistory:
      (source.searchHistory as
        ResearchProjectState["searchHistory"] | undefined) ?? [],
    trackingTopics:
      (source.trackingTopics as
        ResearchProjectState["trackingTopics"] | undefined) ?? [],
    notes: (source.notes as ResearchProjectState["notes"] | undefined) ?? [],
    tasks: (source.tasks as ResearchProjectState["tasks"] | undefined) ?? [],
    inbox: isRecord(source.inbox)
      ? (source.inbox as unknown as ResearchProjectState["inbox"])
      : undefined,
  };
};

export function buildActivities({
  history,
  notes,
  papers,
  tasks,
  trackingTopics,
}: {
  history: ResearchSearchHistoryItem[];
  notes: ResearchNote[];
  papers: ResearchPaper[];
  tasks: ResearchTask[];
  trackingTopics: ResearchTrackingTopic[];
}): ActivityItem[] {
  const savedPapers = papers.filter((paper) => paper.saved);
  return [
    ...notes.map<ActivityItem>((note) => ({
      id: `note:${note.id}`,
      sourceId: note.id,
      title: note.kind === "idea" ? "记录研究想法" : "新增研究记录",
      body: note.content,
      kind: "note",
      label: note.kind === "experiment" ? "实验记录" : "研究笔记",
      timestamp: note.createdAt,
    })),
    ...savedPapers.map<ActivityItem>((paper) => ({
      id: `paper:${paper.id}`,
      title: "收藏一篇文献",
      body: paper.title,
      kind: "paper",
      label: paper.verified ? "已通过元信息核验" : "待打开原文核对",
      timestamp: paper.addedAt,
      linkedPaper: paper,
    })),
    ...history.map<ActivityItem>((item) => ({
      id: `search:${item.id}`,
      title: "完成一次文献检索",
      body: item.query,
      kind: "search",
      label: `${item.resultCount} 条结果${item.sources?.length ? ` · ${item.sources.join("、")}` : ""}`,
      timestamp: item.createdAt,
    })),
    ...tasks.map<ActivityItem>((task) => ({
      id: `task:${task.id}`,
      title: task.completed ? "完成研究任务" : "新增研究任务",
      body: task.title,
      kind: "task",
      label: task.completed ? "已完成" : "待处理",
      timestamp: task.completedAt ?? task.createdAt,
      completed: task.completed,
    })),
    ...trackingTopics
      .filter((topic) => topic.lastCheckedAt)
      .map<ActivityItem>((topic) => ({
        id: `tracking:${topic.id}`,
        title: "更新科研追踪",
        body: topic.title,
        kind: "tracking",
        label: `${topic.latestCount} 条新结果`,
        timestamp: topic.lastCheckedAt ?? Date.now(),
      })),
  ]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 30);
}
