import {
  ArrowRightIcon,
  BookmarkIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FolderOpenIcon,
  InboxIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  RadarIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { HoldToConfirm } from "@/components/interior/hold-to-confirm";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import type { ResearchPaper } from "@/domain/research";
import { openExternalUrl } from "@/lib/melody-bridge";

import {
  buildResearchEvidenceMatrix,
  useResearchCapabilityStore,
} from "./research-capability-store";
import type { ResearchMainKind } from "./research-main-workspace";
import { useResearchStore } from "./research-store";
import { EmptyWorkflow, ProjectContext, ResultTable } from "./research-ui";

export function InboxWorkspace({
  onAskPaper,
  onOpenPaper,
  onNavigate,
  projectName,
}: {
  onAskPaper?: (paper: ResearchPaper) => void;
  onOpenPaper: (paper: ResearchPaper) => void;
  onNavigate: (kind: ResearchMainKind) => void;
  projectName: string;
}) {
  const inbox = useResearchStore((state) => state.inbox);
  const addPapers = useResearchStore((state) => state.addPapers);
  const addTrackingTopic = useResearchStore((state) => state.addTrackingTopic);
  const clearResearchInbox = useResearchStore(
    (state) => state.clearResearchInbox,
  );
  const evidenceMatrixEnabled = useResearchCapabilityStore((state) =>
    state.enabledToolIds.includes("evidence-matrix"),
  );
  const studyCardEnabled = useResearchCapabilityStore((state) =>
    state.enabledToolIds.includes("study-card"),
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [trackingOpen, setTrackingOpen] = useState(false);
  const [trackingTitle, setTrackingTitle] = useState("");
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [clearInboxOpen, setClearInboxOpen] = useState(false);
  const inboxCreatedAt = inbox?.createdAt;
  const selectedPapers =
    inbox?.papers.filter((paper) => checked.has(paper.id)) ?? [];
  const selected = selectedPapers[0];
  const successfulSources =
    inbox?.sourceRuns.filter((run) => run.status === "success") ?? [];
  const failedSources =
    inbox?.sourceRuns.filter((run) => run.status === "error") ?? [];

  useEffect(() => {
    setChecked(new Set());
    setTrackingOpen(false);
    setTrackingTitle("");
    setMatrixOpen(false);
    setClearInboxOpen(false);
  }, [inboxCreatedAt]);

  const saveSelected = (saved: boolean) => {
    if (!selectedPapers.length) {
      return;
    }
    addPapers(selectedPapers.map((paper) => ({ ...paper, saved })));
  };

  const createTrackingTopic = () => {
    const title = trackingTitle.trim();
    if (!title || !inbox) {
      return;
    }
    addTrackingTopic(title, inbox.searchQuery);
    setTrackingOpen(false);
    setTrackingTitle("");
    onNavigate("tracking");
  };

  if (!inbox) {
    return (
      <div className="flex size-full min-h-0 flex-col bg-background">
        <header className="shrink-0 border-b px-6 py-4">
          <h1 className="research-serif font-semibold text-2xl">研究收件箱</h1>
          <p className="mt-1 text-muted-foreground text-xs">
            把一次检索的结果暂存为可处理的研究候选，离开检索页后也不会丢失。
          </p>
          <ProjectContext projectName={projectName} />
        </header>
        <div className="flex min-h-0 flex-1 items-start justify-center p-6 pt-12">
          <EmptyWorkflow
            actions={
              <>
                <Button onClick={() => onNavigate("search")} size="sm">
                  <SearchIcon />
                  去自然语言检索
                  <ArrowRightIcon />
                </Button>
                <Button
                  onClick={() => onNavigate("library")}
                  size="sm"
                  variant="outline"
                >
                  <FolderOpenIcon />
                  直接导入文献
                </Button>
              </>
            }
            description="完成一次真实检索后，结果会自动进入这里。你可以先批量加入文献库，再挑选值得长期保留的论文生成知识资产。"
            steps={[
              { title: "运行一次检索", description: "用白话描述研究问题。" },
              {
                title: "选择候选论文",
                description: "查看来源、摘要与核验状态。",
              },
              { title: "批量沉淀", description: "入库、收藏或创建追踪主题。" },
            ]}
            title="研究收件箱还没有结果"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b px-6 py-4">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="research-serif font-semibold text-2xl">
              研究收件箱
            </h1>
            <p
              className="mt-1 truncate text-muted-foreground text-xs"
              title={inbox.query}
            >
              {inbox.query}
            </p>
            <ProjectContext projectName={projectName} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              onClick={() => onNavigate("search")}
              size="sm"
              variant="outline"
            >
              <SearchIcon />
              新建检索
            </Button>
            <Button
              onClick={() => setClearInboxOpen(true)}
              size="sm"
              variant="ghost"
            >
              清空收件箱
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <InboxIcon className="size-3.5" />
          <span>{inbox.papers.length} 篇候选</span>
          <span>·</span>
          <span>{successfulSources.length} 个数据源已响应</span>
          {failedSources.length ? (
            <span className="text-amber-700 dark:text-amber-300">
              · {failedSources.length} 个数据源失败
            </span>
          ) : null}
          <span>·</span>
          <span>最近检索于 {new Date(inbox.createdAt).toLocaleString()}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {successfulSources.map((run) => (
            <Badge key={run.source} variant="outline">
              {run.source} · {run.resultCount}
            </Badge>
          ))}
          {failedSources.map((run) => (
            <Badge key={run.source} variant="secondary" title={run.message}>
              {run.source} · 未响应
            </Badge>
          ))}
        </div>
      </header>
      <div className="flex h-auto min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="font-medium text-xs">
          已选择 {selectedPapers.length} / {inbox.papers.length}
        </span>
        <Button
          disabled={!selectedPapers.length}
          onClick={() => saveSelected(false)}
          size="sm"
          variant="outline"
        >
          <FolderOpenIcon />
          加入文献库
        </Button>
        <Button
          disabled={!selectedPapers.length}
          onClick={() => saveSelected(true)}
          size="sm"
          variant="outline"
        >
          <BookmarkIcon />
          生成知识资产
        </Button>
        <Button
          disabled={!inbox.papers.length}
          onClick={() => setTrackingOpen((value) => !value)}
          size="sm"
          variant="outline"
        >
          <RadarIcon />
          创建追踪主题
        </Button>
        <Button
          disabled={!evidenceMatrixEnabled || !selectedPapers.length}
          onClick={() => setMatrixOpen((value) => !value)}
          size="sm"
          title={
            evidenceMatrixEnabled ? undefined : "请先在科研能力中启用证据矩阵"
          }
          variant="outline"
        >
          <CheckCircle2Icon />
          {matrixOpen ? "收起证据矩阵" : "生成证据矩阵"}
        </Button>
        <Button
          disabled={!selected}
          onClick={() => selected && void openExternalUrl(selected.url)}
          size="sm"
          variant="ghost"
        >
          <ExternalLinkIcon />
          打开原文
        </Button>
        {onAskPaper ? (
          <Button
            disabled={!selected || !studyCardEnabled}
            onClick={() => selected && onAskPaper(selected)}
            size="sm"
            title={
              studyCardEnabled ? undefined : "请先在科研能力中启用论文研究卡片"
            }
            variant="ghost"
          >
            <MessageCircleQuestionIcon />
            进入对话
          </Button>
        ) : null}
      </div>
      {trackingOpen ? (
        <div className="flex flex-wrap items-end gap-2 border-b bg-muted/10 px-4 py-3">
          <label className="grid min-w-64 flex-1 gap-1.5">
            <span className="font-medium text-xs">主题名称</span>
            <Input
              autoFocus
              onChange={(event) => setTrackingTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  createTrackingTopic();
                }
              }}
              placeholder={`例如：${inbox.query}`}
              value={trackingTitle}
            />
          </label>
          <span className="max-w-md pb-2 text-muted-foreground text-[11px] leading-4">
            将使用本次检索词“{inbox.searchQuery}
            ”作为刷新科研追踪时发送给数据源的查询。
          </span>
          <Button
            disabled={!trackingTitle.trim()}
            onClick={createTrackingTopic}
          >
            <PlusIcon />
            创建并查看追踪
          </Button>
        </div>
      ) : null}
      {matrixOpen ? (
        <div className="border-b bg-muted/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-medium text-xs">证据矩阵草稿</span>
            <span className="text-muted-foreground text-[11px]">
              {selectedPapers.length} 篇 · 保留论文
              ID，待从摘要或全文补齐研究设计和结果
            </span>
          </div>
          <div className="mt-2 overflow-x-auto border bg-background">
            <table className="w-full min-w-[720px] text-left text-[11px]">
              <thead className="border-b bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">论文身份</th>
                  <th className="px-3 py-2 font-medium">研究设计</th>
                  <th className="px-3 py-2 font-medium">结果 / 指标</th>
                  <th className="px-3 py-2 font-medium">限制与下一步</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {buildResearchEvidenceMatrix(selectedPapers).map((row) => (
                  <tr key={row.id}>
                    <td className="max-w-[260px] px-3 py-2 align-top">
                      <p className="font-medium">{row.identity}</p>
                      <p className="mt-1 text-muted-foreground">
                        {row.authors}
                      </p>
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {row.design}
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {row.outcome}
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {row.limitations}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-auto">
          <ResultTable
            checked={checked}
            emptyText="本次检索没有可处理的结果"
            onCheck={(id) =>
              setChecked((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onSelect={onOpenPaper}
            papers={inbox.papers}
          />
        </section>
      </div>

      <Dialog onOpenChange={setClearInboxOpen} open={clearInboxOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空研究收件箱？</DialogTitle>
            <DialogDescription>
              本次检索的候选论文和数据源结果会被移除，已经加入文献库的内容不会受到影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <HoldToConfirm
              onConfirm={() => {
                clearResearchInbox();
                setClearInboxOpen(false);
              }}
              variant="destructive"
            >
              清空收件箱
            </HoldToConfirm>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
