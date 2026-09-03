import {
  ArrowRightIcon,
  BookOpenIcon,
  CalendarDaysIcon,
  CheckIcon,
  CheckCircle2Icon,
  CircleIcon,
  FileTextIcon,
  ListTodoIcon,
  MoreHorizontalIcon,
  PenLineIcon,
  PencilIcon,
  PlusIcon,
  RadarIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { HoldToConfirm } from "@/components/interior/hold-to-confirm";
import { ProgressBar } from "@/components/interior/progress-bar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type {
  ResearchPaper,
  ResearchTask,
  ResearchTrackingTopic,
} from "@/domain/research";

import type { ResearchMainKind } from "./research-main-workspace";
import { useResearchStore } from "./research-store";

export type ActivityType = "note" | "paper" | "search" | "task" | "tracking";
export type ActivityFilter = "all" | ActivityType;

export interface ActivityItem {
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

export const formatDate = (timestamp: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(new Date(timestamp));

export const formatTime = (timestamp: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));

export const formatRelative = (timestamp?: number) => {
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

export const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = {
  all: "全部活动",
  note: "研究记录",
  task: "研究任务",
  paper: "文献收藏",
  search: "文献检索",
  tracking: "科研追踪",
};
export function ActivityIcon({ kind }: { kind: ActivityType }) {
  if (kind === "paper") return <BookOpenIcon className="size-3.5" />;
  if (kind === "search") return <SearchIcon className="size-3.5" />;
  if (kind === "task") return <ListTodoIcon className="size-3.5" />;
  if (kind === "tracking") return <RadarIcon className="size-3.5" />;
  return <PenLineIcon className="size-3.5" />;
}

export function ActivityRow({
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

export function ProgressRail({
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
  const [pendingDeleteTask, setPendingDeleteTask] = useState<ResearchTask>();
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
          <ProgressBar
            label="本周进度"
            max={100}
            showLabel={false}
            size="compact"
            value={progress}
          />
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
                <Button
                  aria-label={`删除任务：${task.title}`}
                  className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:relative focus-visible:z-10 focus-visible:opacity-100 hover:text-destructive"
                  onClick={() => setPendingDeleteTask(task)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
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

      <Dialog
        onOpenChange={(open) => {
          if (!open) setPendingDeleteTask(undefined);
        }}
        open={Boolean(pendingDeleteTask)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除研究任务？</DialogTitle>
            <DialogDescription>
              “{pendingDeleteTask?.title ?? ""}”会从当前项目的下一步列表中移除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <HoldToConfirm
              onConfirm={() => {
                if (pendingDeleteTask) removeResearchTask(pendingDeleteTask.id);
                setPendingDeleteTask(undefined);
              }}
              variant="destructive"
            >
              删除任务
            </HoldToConfirm>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
