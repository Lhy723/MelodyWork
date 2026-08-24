import {
  ArrowRightIcon,
  BookOpenIcon,
  CalendarDaysIcon,
  CheckIcon,
  CheckCircle2Icon,
  CircleIcon,
  DownloadIcon,
  FileTextIcon,
  FolderOpenIcon,
  InboxIcon,
  ListTodoIcon,
  MoreHorizontalIcon,
  PenLineIcon,
  PencilIcon,
  PlusIcon,
  RadarIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toUserMessage } from "@/domain/app-error";
import type {
  ResearchNote,
  ResearchPaper,
  ResearchSearchHistoryItem,
  ResearchTask,
  ResearchTrackingTopic,
} from "@/domain/research";

import type { ResearchMainKind } from "./research-main-workspace";
import type { ResearchProjectState } from "./research-store";
import { useResearchStore } from "./research-store";

type CaptureMode = "note" | "task";
type ActivityType = "note" | "paper" | "search" | "task" | "tracking";
type ActivityFilter = "all" | ActivityType;

interface ActivityItem {
  body: string;
  id: string;
  kind: ActivityType;
  label: string;
  linkedPaper?: ResearchPaper;
  sourceId?: string;
  completed?: boolean;
  timestamp: number;
  title: string;
}

const formatDate = (timestamp: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(new Date(timestamp));

const formatTime = (timestamp: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));

const formatRelative = (timestamp?: number) => {
  if (!timestamp) return "尚未更新";
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
};

const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = {
  all: "全部活动",
  note: "研究记录",
  task: "研究任务",
  paper: "文献收藏",
  search: "文献检索",
  tracking: "科研追踪",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseProjectBackup = (value: unknown): Partial<ResearchProjectState> => {
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

function ProjectContext({ projectName }: { projectName: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-muted-foreground text-[11px]">
      <FolderOpenIcon className="size-3.5" />
      <span>当前项目</span>
      <span className="font-medium text-foreground">{projectName}</span>
    </div>
  );
}

function ActivityIcon({ kind }: { kind: ActivityType }) {
  if (kind === "paper") return <BookOpenIcon className="size-3.5" />;
  if (kind === "search") return <SearchIcon className="size-3.5" />;
  if (kind === "task") return <ListTodoIcon className="size-3.5" />;
  if (kind === "tracking") return <RadarIcon className="size-3.5" />;
  return <PenLineIcon className="size-3.5" />;
}

function ActivityRow({
  item,
  onNavigate,
  onOpenPaper,
  onEditNote,
  onRequestDelete,
}: {
  item: ActivityItem;
  onNavigate: (kind: ResearchMainKind) => void;
  onOpenPaper?: (paper: ResearchPaper) => void;
  onEditNote: (id: string, content: string) => void;
  onRequestDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.body);
  const saveNote = () => {
    const content = draft.trim();
    if (!content || !item.sourceId) return;
    onEditNote(item.sourceId, content);
    setEditing(false);
  };

  return (
    <article className="group relative grid grid-cols-[72px_18px_minmax(0,1fr)_26px] gap-3 border-b py-5 last:border-b-0">
      <div className="pt-0.5 text-right text-[11px] text-muted-foreground">
        <span className="block text-[10px]">{formatDate(item.timestamp)}</span>
        <time dateTime={new Date(item.timestamp).toISOString()}>
          {formatTime(item.timestamp)}
        </time>
      </div>
      <div className="relative flex justify-center">
        <span className="relative z-10 grid size-7 place-items-center rounded-full border bg-background text-muted-foreground">
          <ActivityIcon kind={item.kind} />
        </span>
        <span className="absolute top-7 bottom-[-24px] w-px bg-border group-last:hidden" />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{item.title}</span>
          <span className="text-muted-foreground text-[10px]">
            {item.label}
          </span>
        </div>
        {editing && item.kind === "note" ? (
          <div className="mt-2 space-y-2">
            <Textarea
              aria-label="编辑研究记录"
              autoFocus
              className="min-h-20 text-sm leading-6"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  saveNote();
                }
                if (event.key === "Escape") {
                  setEditing(false);
                  setDraft(item.body);
                }
              }}
              value={draft}
            />
            <div className="flex justify-end gap-1.5">
              <Button
                onClick={() => {
                  setEditing(false);
                  setDraft(item.body);
                }}
                size="xs"
                variant="ghost"
              >
                <XIcon />
                取消
              </Button>
              <Button disabled={!draft.trim()} onClick={saveNote} size="xs">
                <CheckIcon />
                保存
              </Button>
            </div>
          </div>
        ) : (
          <p
            className={
              item.completed
                ? "research-serif mt-1 whitespace-pre-wrap text-sm text-muted-foreground leading-6 line-through"
                : "research-serif mt-1 whitespace-pre-wrap text-sm text-muted-foreground leading-6"
            }
          >
            {item.body}
          </p>
        )}
        {item.linkedPaper ? (
          <button
            className="mt-2 flex max-w-full items-center gap-1.5 text-left text-primary text-xs hover:underline"
            onClick={() => {
              if (item.linkedPaper && onOpenPaper)
                onOpenPaper(item.linkedPaper);
              else onNavigate("library");
            }}
            type="button"
          >
            <FileTextIcon className="size-3.5 shrink-0" />
            <span className="truncate">{item.linkedPaper.title}</span>
            <ArrowRightIcon className="size-3 shrink-0" />
          </button>
        ) : null}
      </div>
      {item.kind === "note" && item.sourceId ? (
        <div className="mt-0.5 flex items-start gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            aria-label="编辑研究记录"
            onClick={() => {
              setDraft(item.body);
              setEditing(true);
            }}
            size="icon-xs"
            variant="ghost"
          >
            <PencilIcon />
          </Button>
          <Button
            aria-label="删除研究记录"
            onClick={() => onRequestDelete(item.sourceId as string)}
            size="icon-xs"
            variant="ghost"
          >
            <Trash2Icon />
          </Button>
        </div>
      ) : item.kind !== "task" ? (
        <Button
          aria-label="打开活动来源"
          className="mt-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          onClick={() => {
            if (item.kind === "paper" && item.linkedPaper && onOpenPaper)
              onOpenPaper(item.linkedPaper);
            else if (item.kind === "paper") onNavigate("library");
            if (item.kind === "search") onNavigate("search");
            if (item.kind === "tracking") onNavigate("tracking");
          }}
          size="icon-xs"
          variant="ghost"
        >
          <MoreHorizontalIcon />
        </Button>
      ) : (
        <span aria-hidden="true" />
      )}
    </article>
  );
}

function ProgressRail({
  onNavigate,
  onOpenPaper,
  papers,
  tasks,
  trackingTopics,
}: {
  onNavigate: (kind: ResearchMainKind) => void;
  onOpenPaper?: (paper: ResearchPaper) => void;
  papers: ResearchPaper[];
  tasks: ResearchTask[];
  trackingTopics: ResearchTrackingTopic[];
}) {
  const toggleResearchTask = useResearchStore(
    (state) => state.toggleResearchTask,
  );
  const addResearchTask = useResearchStore((state) => state.addResearchTask);
  const removeResearchTask = useResearchStore(
    (state) => state.removeResearchTask,
  );
  const [taskDraft, setTaskDraft] = useState("");
  const completed = tasks.filter((task) => task.completed).length;
  const progress = tasks.length
    ? Math.round((completed / tasks.length) * 100)
    : 0;
  const pendingTasks = tasks.filter((task) => !task.completed).slice(0, 6);
  const recentPapers = papers
    .filter((paper) => paper.saved)
    .sort((left, right) => right.addedAt - left.addedAt)
    .slice(0, 4);

  const submitTask = () => {
    const title = taskDraft.trim();
    if (!title) return;
    addResearchTask(title);
    setTaskDraft("");
  };

  return (
    <aside className="space-y-5">
      <section className="border bg-background p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="research-serif font-semibold text-lg">本周进度</h2>
            <p className="mt-1 text-muted-foreground text-[11px]">
              由当前项目的研究任务自动汇总
            </p>
          </div>
          <CalendarDaysIcon className="size-4 text-muted-foreground" />
        </div>
        <div className="mt-5 grid grid-cols-2 divide-x border-y py-3">
          <div className="pr-3">
            <p className="text-muted-foreground text-[11px]">已完成</p>
            <p className="research-serif mt-1 text-2xl">{completed}</p>
          </div>
          <div className="pl-3">
            <p className="text-muted-foreground text-[11px]">进行中</p>
            <p className="research-serif mt-1 text-2xl">
              {tasks.length - completed}
            </p>
          </div>
        </div>
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full origin-left rounded-full bg-primary transition-transform"
              style={{ transform: `scaleX(${progress / 100})` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
            <span>{tasks.length ? `${progress}% 完成` : "还没有任务"}</span>
            <span>{tasks.length} 项</span>
          </div>
        </div>
      </section>

      <section className="border bg-background p-4">
        <div className="flex items-center justify-between">
          <h2 className="research-serif font-semibold text-lg">下一步</h2>
          <ListTodoIcon className="size-4 text-muted-foreground" />
        </div>
        <div className="mt-3 space-y-1">
          {pendingTasks.length ? (
            pendingTasks.map((task) => (
              <div
                className="group flex items-start gap-2 py-1.5"
                key={task.id}
              >
                <button
                  aria-label={`完成任务：${task.title}`}
                  className="mt-0.5 text-muted-foreground hover:text-primary"
                  onClick={() => toggleResearchTask(task.id, true)}
                  type="button"
                >
                  <CircleIcon className="size-4" />
                </button>
                <span className="min-w-0 flex-1 text-xs leading-5">
                  {task.title}
                </span>
                <button
                  aria-label={`删除任务：${task.title}`}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:relative focus-visible:z-10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring hover:text-destructive"
                  onClick={() => removeResearchTask(task.id)}
                  type="button"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
            ))
          ) : (
            <p className="py-3 text-muted-foreground text-xs">
              把下一步写下来，进度会自动出现在这里。
            </p>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-md border-t px-1 pt-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
          <input
            aria-label="添加研究任务"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            onChange={(event) => setTaskDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitTask();
            }}
            placeholder="添加一个下一步…"
            value={taskDraft}
          />
          <Button
            aria-label="添加任务"
            disabled={!taskDraft.trim()}
            onClick={submitTask}
            size="icon-xs"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
        </div>
        {tasks.some((task) => task.completed) ? (
          <div className="mt-3 border-t pt-3">
            <p className="mb-1 text-muted-foreground text-[10px]">已完成</p>
            {tasks
              .filter((task) => task.completed)
              .slice(0, 3)
              .map((task) => (
                <button
                  className="flex w-full items-start gap-2 rounded-md py-1 text-left text-muted-foreground text-xs line-through focus-visible:ring-2 focus-visible:ring-ring"
                  key={task.id}
                  onClick={() => toggleResearchTask(task.id, false)}
                  type="button"
                >
                  <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                  <span>{task.title}</span>
                </button>
              ))}
          </div>
        ) : null}
      </section>

      <section className="border bg-background p-4">
        <div className="flex items-center justify-between">
          <h2 className="research-serif font-semibold text-lg">最近文献动态</h2>
          <button
            className="text-primary text-xs hover:underline"
            onClick={() => onNavigate("library")}
            type="button"
          >
            更多
          </button>
        </div>
        {recentPapers.length ? (
          <div className="mt-3 divide-y">
            {recentPapers.map((paper) => (
              <button
                className="block w-full py-3 text-left first:pt-0 last:pb-0"
                key={paper.id}
                onClick={() => {
                  if (onOpenPaper) onOpenPaper(paper);
                  else onNavigate("library");
                }}
                type="button"
              >
                <p className="line-clamp-2 text-xs leading-5 hover:text-primary">
                  {paper.title}
                </p>
                <p className="mt-1 text-muted-foreground text-[10px]">
                  {paper.venue || paper.sources[0] || "来源未收录"} ·{" "}
                  {formatRelative(paper.addedAt)}
                </p>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-3 border-t pt-3">
            <p className="text-muted-foreground text-xs leading-5">
              收藏论文后，最近文献会在这里持续更新。
            </p>
            <Button
              className="mt-3"
              onClick={() => onNavigate("search")}
              size="sm"
              variant="outline"
            >
              <SearchIcon />
              继续检索
            </Button>
          </div>
        )}
      </section>

      <section className="border bg-muted/20 p-4">
        <div className="flex items-center gap-2">
          <RadarIcon className="size-4 text-muted-foreground" />
          <h2 className="research-serif font-semibold text-lg">科研追踪</h2>
        </div>
        <p className="mt-2 text-muted-foreground text-xs leading-5">
          {trackingTopics.length
            ? `当前跟踪 ${trackingTopics.length} 个方向，回到追踪页查看最新检索。`
            : "还没有追踪主题，把一个研究方向设为持续关注。"}
        </p>
        <Button
          className="mt-3"
          onClick={() => onNavigate("tracking")}
          size="sm"
          variant="ghost"
        >
          {trackingTopics.length ? "查看科研追踪" : "创建追踪主题"}
          <ArrowRightIcon />
        </Button>
      </section>
    </aside>
  );
}

function buildActivities({
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
}) {
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

export function ResearchOverviewWorkspace({
  onNavigate,
  onOpenPaper,
  projectName,
}: {
  onNavigate: (kind: ResearchMainKind) => void;
  onOpenPaper?: (paper: ResearchPaper) => void;
  projectName: string;
}) {
  const notes = useResearchStore((state) => state.notes);
  const tasks = useResearchStore((state) => state.tasks);
  const papers = useResearchStore((state) => state.papers);
  const history = useResearchStore((state) => state.searchHistory);
  const trackingTopics = useResearchStore((state) => state.trackingTopics);
  const inbox = useResearchStore((state) => state.inbox);
  const addResearchNote = useResearchStore((state) => state.addResearchNote);
  const addResearchTask = useResearchStore((state) => state.addResearchTask);
  const updateResearchNote = useResearchStore(
    (state) => state.updateResearchNote,
  );
  const removeResearchNote = useResearchStore(
    (state) => state.removeResearchNote,
  );
  const replaceActiveProject = useResearchStore(
    (state) => state.replaceActiveProject,
  );
  const [captureMode, setCaptureMode] = useState<CaptureMode>("note");
  const [draft, setDraft] = useState("");
  const [activityQuery, setActivityQuery] = useState("");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [pendingDeleteNote, setPendingDeleteNote] = useState<string>();
  const [pendingImport, setPendingImport] =
    useState<Partial<ResearchProjectState>>();
  const [pendingImportName, setPendingImportName] = useState("");
  const [syncNotice, setSyncNotice] = useState<string>();
  const [syncError, setSyncError] = useState<string>();
  const importInputRef = useRef<HTMLInputElement>(null);
  const activities = useMemo(
    () => buildActivities({ history, notes, papers, tasks, trackingTopics }),
    [history, notes, papers, tasks, trackingTopics],
  );
  const filteredActivities = useMemo(() => {
    const normalizedQuery = activityQuery.trim().toLocaleLowerCase();
    return activities.filter((item) => {
      if (activityFilter !== "all" && item.kind !== activityFilter)
        return false;
      if (!normalizedQuery) return true;
      return [item.title, item.body, item.label, item.linkedPaper?.title]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [activities, activityFilter, activityQuery]);

  const submitCapture = () => {
    const content = draft.trim();
    if (!content) return;
    if (captureMode === "task") {
      addResearchTask(content);
    } else {
      addResearchNote(content, { kind: "note" });
    }
    setDraft("");
  };

  const exportProject = () => {
    const state = useResearchStore.getState();
    const payload = {
      type: "melody-research-project",
      version: 1,
      projectName,
      exportedAt: new Date().toISOString(),
      data: {
        papers: state.papers,
        searchHistory: state.searchHistory,
        trackingTopics: state.trackingTopics,
        notes: state.notes,
        tasks: state.tasks,
        inbox: state.inbox,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const safeProjectName = projectName.replace(/[\\/:*?"<>|]+/g, "-");
    anchor.href = url;
    anchor.download = `${safeProjectName || "melody-research"}-research.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setSyncError(undefined);
    setSyncNotice("已导出当前项目的研究记录和文献数据。");
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = parseProjectBackup(JSON.parse(await file.text()));
      setPendingImport(parsed);
      setPendingImportName(file.name);
      setSyncError(undefined);
      setSyncNotice(undefined);
    } catch (reason) {
      setSyncNotice(undefined);
      setSyncError(toUserMessage(reason, "无法读取备份文件。"));
    }
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    replaceActiveProject(pendingImport);
    setPendingImport(undefined);
    setPendingImportName("");
    setSyncError(undefined);
    setSyncNotice("已导入备份，当前项目的研究数据已更新。");
  };

  return (
    <div className="flex size-full min-h-0 flex-col overflow-y-auto bg-background">
      <header className="flex shrink-0 flex-wrap items-start gap-4 border-b px-6 py-5">
        <div className="min-w-0 flex-1">
          <h1 className="research-serif font-semibold text-3xl tracking-tight">
            研究总览
          </h1>
          <ProjectContext projectName={projectName} />
        </div>
        <div className="flex w-full shrink-0 flex-wrap justify-start gap-2 sm:w-auto sm:justify-end">
          <Button
            onClick={() => onNavigate("inbox")}
            size="sm"
            variant="outline"
          >
            <InboxIcon />
            查看收件箱
          </Button>
          <Button
            onClick={() => onNavigate("search")}
            size="sm"
            variant="outline"
          >
            <SearchIcon />
            继续检索
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label="项目数据" size="icon-sm" variant="ghost">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>项目数据</DropdownMenuLabel>
              <DropdownMenuItem onSelect={exportProject}>
                <DownloadIcon />
                导出当前项目
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => importInputRef.current?.click()}
              >
                <UploadIcon />
                导入项目备份
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => void handleImportFile(event)}
            ref={importInputRef}
            type="file"
          />
        </div>
      </header>

      {syncError ? (
        <div
          aria-live="assertive"
          className="border-b bg-destructive/8 px-6 py-2 text-destructive text-xs"
          role="alert"
        >
          {syncError}
        </div>
      ) : syncNotice ? (
        <div
          aria-live="polite"
          className="border-b bg-emerald-500/8 px-6 py-2 text-emerald-700 text-xs dark:text-emerald-300"
          role="status"
        >
          {syncNotice}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <main className="min-w-0">
          <section className="border bg-background">
            <div className="flex items-center gap-2 border-b px-4 py-2.5 text-xs">
              <PenLineIcon className="size-3.5 text-muted-foreground" />
              <button
                aria-pressed={captureMode === "note"}
                className={cnCapture(captureMode === "note")}
                onClick={() => setCaptureMode("note")}
                type="button"
              >
                记录
              </button>
              <button
                aria-pressed={captureMode === "task"}
                className={cnCapture(captureMode === "task")}
                onClick={() => setCaptureMode("task")}
                type="button"
              >
                研究任务
              </button>
              <span className="ml-auto text-muted-foreground text-[10px]">
                ⌘ ↵ 快速保存
              </span>
            </div>
            <Textarea
              aria-label={
                captureMode === "note" ? "记录研究内容" : "记录研究任务"
              }
              className="min-h-28 resize-none rounded-none border-0 bg-transparent px-4 py-3 text-sm leading-6 shadow-none focus-visible:ring-0"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  submitCapture();
                }
              }}
              placeholder={
                captureMode === "note"
                  ? "记录一个研究想法、发现或下一步…"
                  : "把下一步拆成一个可执行任务…"
              }
              value={draft}
            />
            <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5">
              <span className="text-muted-foreground text-[11px]">
                支持 Markdown · 内容保存在当前项目
              </span>
              <Button
                disabled={!draft.trim()}
                onClick={submitCapture}
                size="sm"
              >
                <PlusIcon />
                {captureMode === "note" ? "保存记录" : "添加任务"}
              </Button>
            </div>
          </section>

          <div className="mt-7 flex items-center justify-between border-b pb-2">
            <div>
              <h2 className="research-serif font-semibold text-xl">研究活动</h2>
              <p className="mt-1 text-muted-foreground text-[11px]">
                记录、任务、检索、文献和追踪会按时间汇总到这里。
              </p>
            </div>
            <span className="text-muted-foreground text-[11px]">
              {filteredActivities.length === activities.length
                ? `${activities.length} 条活动`
                : `${filteredActivities.length}/${activities.length} 条活动`}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b py-3">
            <div className="flex h-8 min-w-48 flex-1 items-center border bg-background px-2">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                aria-label="搜索研究活动"
                className="h-7 border-0 px-2 text-xs shadow-none focus-visible:ring-0"
                onChange={(event) => setActivityQuery(event.target.value)}
                placeholder="搜索研究活动…"
                value={activityQuery}
              />
              {activityQuery ? (
                <Button
                  aria-label="清除活动搜索"
                  onClick={() => setActivityQuery("")}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              ) : null}
            </div>
            <select
              aria-label="筛选研究活动"
              className="h-8 border bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              onChange={(event) =>
                setActivityFilter(event.target.value as ActivityFilter)
              }
              value={activityFilter}
            >
              {Object.entries(ACTIVITY_FILTER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {activities.length ? (
            filteredActivities.length ? (
              <div className="pb-8">
                {filteredActivities.map((item) => (
                  <ActivityRow
                    item={item}
                    key={item.id}
                    onEditNote={updateResearchNote}
                    onNavigate={onNavigate}
                    onOpenPaper={onOpenPaper}
                    onRequestDelete={setPendingDeleteNote}
                  />
                ))}
              </div>
            ) : (
              <div className="border-b py-14 text-center">
                <SearchIcon className="mx-auto size-6 text-muted-foreground" />
                <h3 className="research-serif mt-3 font-semibold text-lg">
                  没有匹配的研究活动
                </h3>
                <p className="mx-auto mt-1 max-w-md text-muted-foreground text-xs leading-5">
                  换一个关键词或清除筛选，查看当前项目的全部记录。
                </p>
                <Button
                  className="mt-4"
                  onClick={() => {
                    setActivityQuery("");
                    setActivityFilter("all");
                  }}
                  size="sm"
                  variant="outline"
                >
                  清除筛选
                </Button>
              </div>
            )
          ) : (
            <div className="border-b py-14 text-center">
              <PenLineIcon className="mx-auto size-6 text-muted-foreground" />
              <h3 className="research-serif mt-3 font-semibold text-lg">
                从一条研究记录开始
              </h3>
              <p className="mx-auto mt-1 max-w-md text-muted-foreground text-xs leading-5">
                先写下当前的想法、读论文后的判断或下一步实验；之后所有研究活动都会在这里形成连续脉络。
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button onClick={() => setCaptureMode("note")} size="sm">
                  <PenLineIcon />
                  开始记录
                </Button>
                <Button
                  onClick={() => onNavigate("search")}
                  size="sm"
                  variant="outline"
                >
                  <SearchIcon />
                  从检索开始
                </Button>
              </div>
            </div>
          )}
        </main>

        <ProgressRail
          onNavigate={onNavigate}
          onOpenPaper={onOpenPaper}
          papers={papers}
          tasks={tasks}
          trackingTopics={trackingTopics}
        />
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setPendingDeleteNote(undefined);
        }}
        open={Boolean(pendingDeleteNote)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这条研究记录？</DialogTitle>
            <DialogDescription>
              删除后会从当前项目的时间线和本地记录中移除，无法自动恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setPendingDeleteNote(undefined)}
              variant="outline"
            >
              取消
            </Button>
            <Button
              onClick={() => {
                if (pendingDeleteNote) removeResearchNote(pendingDeleteNote);
                setPendingDeleteNote(undefined);
              }}
              variant="destructive"
            >
              删除记录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingImport(undefined);
            setPendingImportName("");
          }
        }}
        open={Boolean(pendingImport)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导入研究数据？</DialogTitle>
            <DialogDescription>
              将使用“{pendingImportName}
              ”覆盖当前项目的研究记录、任务、文献和收件箱内容。建议先导出当前项目备份。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => {
                setPendingImport(undefined);
                setPendingImportName("");
              }}
              variant="outline"
            >
              取消
            </Button>
            <Button onClick={confirmImport}>导入并覆盖</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {inbox ? (
        <button
          className="fixed right-6 bottom-5 flex items-center gap-2 border bg-foreground px-3 py-2 text-background text-xs transition-colors hover:bg-foreground/90"
          onClick={() => onNavigate("inbox")}
          type="button"
        >
          <InboxIcon className="size-3.5" />
          收件箱有 {inbox.papers.length} 篇待处理论文
          <ArrowRightIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

const cnCapture = (active: boolean) =>
  active
    ? "font-medium text-foreground"
    : "text-muted-foreground hover:text-foreground";
