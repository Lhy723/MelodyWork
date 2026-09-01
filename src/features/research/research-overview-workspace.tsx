import {
  ArrowRightIcon,
  DownloadIcon,
  InboxIcon,
  SearchIcon,
  MoreHorizontalIcon,
  PenLineIcon,
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
import { toUserMessage } from "@/domain/app-error";
import type { ResearchPaper } from "@/domain/research";

import type { ResearchMainKind } from "./research-main-workspace";
import type { ResearchProjectState } from "./research-store";
import {
  ACTIVITY_FILTER_LABELS,
  ActivityRow,
  ProgressRail,
  type ActivityFilter,
} from "./research-activity";
import { buildActivities, parseProjectBackup } from "./research-overview-data";
import { ProjectContext } from "./research-ui";
import { useResearchStore } from "./research-store";
import {
  ResearchCaptureComposer,
  type CaptureMode,
} from "./research-capture-composer";

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
          <ResearchCaptureComposer
            captureMode={captureMode}
            draft={draft}
            onSubmit={submitCapture}
            setCaptureMode={setCaptureMode}
            setDraft={setDraft}
          />

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
