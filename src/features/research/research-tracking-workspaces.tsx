import {
  ArrowLeftIcon,
  ArrowRightIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { FloatingLabelInput } from "@/components/interior/floating-label";
import { HoldToConfirm } from "@/components/interior/hold-to-confirm";
import { useGlobalLiveActivity } from "@/components/interior/live-activity";
import { LoadingButton } from "@/components/interior/loading-button";
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
import { toUserMessage } from "@/domain/app-error";
import type { ResearchPaper } from "@/domain/research";
import { RequestGate } from "@/domain/request-gate";

import { searchResearchPapers } from "./research-api";
import type { ResearchMainKind } from "./research-main-workspace";
import { useResearchStore } from "./research-store";
import { EmptyWorkflow, ProjectContext, ResultTable } from "./research-ui";

export function TrackingWorkspace({
  onOpenTopic,
  onNavigate,
  projectName,
}: {
  onOpenTopic: (topicId: string) => void;
  onNavigate: (kind: ResearchMainKind) => void;
  projectName: string;
}) {
  const topics = useResearchStore((state) => state.trackingTopics);
  const addTrackingTopic = useResearchStore((state) => state.addTrackingTopic);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const useExampleTopic = () => {
    setTitle("多模态 RAG 可复现性");
    setQuery("multimodal RAG evaluation reproducibility benchmark");
  };
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b px-6 py-4">
        <h1 className="research-serif font-semibold text-2xl">科研追踪</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground text-xs leading-5">
          把一个研究方向保存成主题，之后在独立详情页按需刷新进展；每次结果都会进入当前项目的文献库。
        </p>
        <ProjectContext projectName={projectName} />
        <div className="mt-4 max-w-4xl border bg-muted/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="research-serif font-semibold text-base">
                新建追踪主题
              </h2>
              <p className="mt-1 text-muted-foreground text-[11px]">
                主题名称给人看，检索词给学术索引用。
              </p>
            </div>
            <Button
              className="h-7 px-2 text-[11px]"
              onClick={useExampleTopic}
              size="sm"
              variant="outline"
            >
              使用示例
            </Button>
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_1.45fr_auto] lg:items-end">
            <FloatingLabelInput
              hint="侧栏和主题列表中显示的标题"
              label="主题名称"
              onChange={(value) => setTitle(value)}
              value={title}
            />
            <FloatingLabelInput
              hint="刷新时发送给已启用的数据源"
              label="检索词"
              onChange={(value) => setQuery(value)}
              value={query}
            />
            <Button
              disabled={!title.trim() || !query.trim()}
              onClick={() => {
                addTrackingTopic(title.trim(), query.trim());
                setTitle("");
                setQuery("");
              }}
            >
              <PlusIcon />
              添加追踪
            </Button>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="mx-auto w-full max-w-4xl px-6 py-6">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="research-serif font-semibold text-lg">
                已保存的研究方向
              </h2>
              <p className="mt-1 text-muted-foreground text-xs">
                每个主题都有独立详情页，避免在列表里同时阅读多组结果。
              </p>
            </div>
            <span className="text-muted-foreground text-xs tabular-nums">
              {topics.length} 个主题
            </span>
          </div>
          {topics.length ? (
            <div className="mt-4 divide-y border-y">
              {topics.map((topic) => (
                <button
                  className="group flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/30"
                  key={topic.id}
                  onClick={() => onOpenTopic(topic.id)}
                  type="button"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full border bg-background">
                    <RadarIcon className="size-4 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-sm">
                      {topic.title}
                    </span>
                    <span className="mt-1 block truncate text-muted-foreground text-xs">
                      {topic.query}
                    </span>
                    <span className="mt-2 block text-muted-foreground text-[11px]">
                      {topic.lastCheckedAt
                        ? `最近刷新 ${new Date(topic.lastCheckedAt).toLocaleString()} · ${topic.latestCount} 条结果`
                        : "尚未刷新 · 打开详情开始追踪"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs transition-colors group-hover:text-foreground">
                    打开详情
                    <ArrowRightIcon className="size-3.5" />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-4 flex justify-center border-y py-10">
              <EmptyWorkflow
                actions={
                  <>
                    <Button onClick={useExampleTopic} size="sm">
                      <RadarIcon />
                      使用示例主题
                    </Button>
                    <Button
                      onClick={() => onNavigate("search")}
                      size="sm"
                      variant="outline"
                    >
                      <SearchIcon />
                      先做一次自然语言检索
                    </Button>
                  </>
                }
                description="主题名称只是你在项目里看到的标题；检索词才会在刷新时发送给 Crossref、arXiv、PubMed 等学术索引。创建后会在独立详情页查看进展。"
                steps={[
                  {
                    title: "命名方向",
                    description: "写一个便于识别的中文标题。",
                  },
                  {
                    title: "填写检索词",
                    description: "写实际发送给数据源的关键词。",
                  },
                  { title: "按需刷新", description: "打开详情查看新论文。" },
                ]}
                title="设置第一个科研追踪主题"
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function TrackingDetailWorkspace({
  onBack,
  onOpenPaper,
  projectName,
  topicId,
}: {
  onBack: () => void;
  onOpenPaper: (paper: ResearchPaper) => void;
  projectName: string;
  topicId: string;
}) {
  const liveActivity = useGlobalLiveActivity();
  const topic = useResearchStore((state) =>
    state.trackingTopics.find((item) => item.id === topicId),
  );
  const papers = useResearchStore((state) => state.papers);
  const removeTrackingTopic = useResearchStore(
    (state) => state.removeTrackingTopic,
  );
  const refreshTrackingTopic = useResearchStore(
    (state) => state.refreshTrackingTopic,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const refreshGateRef = useRef(new RequestGate());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const topicPapers =
    topic?.paperIds?.flatMap((id) => {
      const paper = papers.find((item) => item.id === id);
      return paper ? [paper] : [];
    }) ?? [];

  const refresh = async () => {
    if (!topic) return;
    const requestToken = refreshGateRef.current.begin();
    setRefreshing(true);
    setError(undefined);
    liveActivity.start({
      detail: `正在刷新“${topic.title}”…`,
      progress: 0,
      title: "刷新科研追踪",
    });
    try {
      const result = await searchResearchPapers(
        topic.query,
        undefined,
        (progress) => {
          if (!refreshGateRef.current.isCurrent(requestToken)) return;
          const sourceDetail =
            progress.status === "running"
              ? `正在查询 ${progress.source}…`
              : progress.status === "success"
                ? `${progress.source} 返回 ${progress.resultCount ?? 0} 条`
                : `${progress.source} 查询失败`;
          liveActivity.update({
            detail: `${sourceDetail} · ${progress.completed}/${progress.total}`,
            progress: progress.completed / progress.total,
            title: "刷新科研追踪",
          });
        },
      );
      if (!refreshGateRef.current.isCurrent(requestToken)) return;
      refreshTrackingTopic(topic.id, result.papers);
      liveActivity.succeed({
        detail: `已更新 ${result.papers.length} 条结果${
          result.warnings.length
            ? `，${result.warnings.length} 个数据源异常`
            : ""
        }。`,
        title: "科研追踪已刷新",
      });
    } catch (reason) {
      if (!refreshGateRef.current.isCurrent(requestToken)) return;
      const message = toUserMessage(reason);
      setError(message);
      liveActivity.fail(
        { detail: message, title: "科研追踪刷新失败" },
        {
          label: "重试",
          onClick: () => {
            void refresh().catch(() => undefined);
          },
        },
      );
      throw reason;
    } finally {
      if (refreshGateRef.current.isCurrent(requestToken)) {
        setRefreshing(false);
      }
    }
  };

  useEffect(() => () => refreshGateRef.current.invalidate(), []);

  if (!topic) {
    return (
      <div className="flex size-full items-center justify-center bg-background p-6">
        <EmptyWorkflow
          actions={
            <Button onClick={onBack} size="sm">
              <ArrowLeftIcon />
              返回科研追踪
            </Button>
          }
          description="这个追踪主题可能已被删除，或当前项目尚未加载完成。"
          steps={[]}
          title="找不到追踪主题"
        />
      </div>
    );
  }

  return (
    <div className="flex size-full min-h-0 flex-col overflow-y-auto bg-background">
      <header className="shrink-0 border-b px-6 py-5">
        <Button
          className="-ml-2 h-7 px-2 text-xs"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
          返回科研追踪
        </Button>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="research-serif font-semibold text-3xl tracking-tight">
              {topic.title}
            </h1>
            <p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
              {topic.query}
            </p>
            <ProjectContext projectName={projectName} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LoadingButton
              disabled={refreshing}
              errorLabel="重试"
              icon={<RefreshCwIcon />}
              onAction={refresh}
              pendingLabel="正在刷新…"
              size="sm"
              successLabel="已刷新"
            >
              刷新进展
            </LoadingButton>
            <Button
              aria-label="删除追踪主题"
              onClick={() => setDeleteOpen(true)}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3 text-xs text-muted-foreground">
          <span>{topicPapers.length} 条已关联结果</span>
          <span>·</span>
          <span>
            {topic.lastCheckedAt
              ? `最近刷新 ${new Date(topic.lastCheckedAt).toLocaleString()}`
              : "尚未刷新"}
          </span>
        </div>
        {error ? (
          <p
            aria-live="assertive"
            className="mt-3 text-destructive text-xs"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </header>
      <main className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="research-serif font-semibold text-xl">
                最新研究进展
              </h2>
              <p className="mt-1 text-muted-foreground text-xs">
                打开任意论文进入独立详情页，逐篇阅读并核验。
              </p>
            </div>
            <span className="text-muted-foreground text-xs">
              按最近一次刷新排序
            </span>
          </div>
          <div className="mt-4 border-y">
            <ResultTable
              checked={new Set()}
              emptyText="还没有关联结果，点击“刷新进展”开始检索。"
              onCheck={() => {}}
              onSelect={onOpenPaper}
              papers={topicPapers}
            />
          </div>
        </div>
      </main>

      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除追踪主题？</DialogTitle>
            <DialogDescription>
              “{topic.title}
              ”及其关联的追踪关系将从当前项目中移除，已导入文献不会被删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <HoldToConfirm
              onConfirm={() => {
                removeTrackingTopic(topic.id);
                setDeleteOpen(false);
                onBack();
              }}
              variant="destructive"
            >
              删除主题
            </HoldToConfirm>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
