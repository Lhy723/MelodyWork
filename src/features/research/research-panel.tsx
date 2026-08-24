import {
  BookmarkIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileTextIcon,
  ImportIcon,
  LibraryIcon,
  LoaderCircleIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { MOTION_EASE } from "@/components/motion/page-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toUserMessage } from "@/domain/app-error";
import type { ResearchPaper } from "@/domain/research";
import { RequestGate } from "@/domain/request-gate";
import { openExternalUrl } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

import { importResearchPaper, searchResearchPapers } from "./research-api";
import { useResearchStore } from "./research-store";

export type ResearchPanelKind = "knowledge" | "library" | "search" | "tracking";

interface ResearchPanelProps {
  kind: ResearchPanelKind;
}

function PaperMetadata({ paper }: { paper: ResearchPaper }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
      {paper.year ? <span>{paper.year}</span> : null}
      {paper.venue ? <span>· {paper.venue}</span> : null}
      {paper.doi ? <span className="truncate">· {paper.doi}</span> : null}
      {typeof paper.citationCount === "number" ? (
        <span>· {paper.citationCount.toLocaleString()} 次引用</span>
      ) : null}
    </div>
  );
}

function PaperList({
  empty,
  onSelect,
  papers,
  selectedId,
}: {
  empty: string;
  onSelect: (paper: ResearchPaper) => void;
  papers: ResearchPaper[];
  selectedId?: string;
}) {
  if (papers.length === 0) {
    return (
      <div className="grid min-h-48 place-items-center p-6 text-center">
        <div>
          <FileTextIcon className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-muted-foreground text-xs">{empty}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="divide-y">
      {papers.map((paper) => (
        <button
          className={cn(
            "w-full px-3 py-3 text-left transition-colors hover:bg-muted/40",
            paper.id === selectedId && "bg-muted/60",
          )}
          key={paper.id}
          onClick={() => onSelect(paper)}
          type="button"
        >
          <div className="flex items-start gap-2">
            <p className="line-clamp-2 min-w-0 flex-1 font-medium text-sm leading-5">
              {paper.title}
            </p>
            {paper.verified ? (
              <CheckCircle2Icon
                aria-label="已通过多源核验"
                className="mt-0.5 size-3.5 shrink-0 text-emerald-600"
              />
            ) : null}
          </div>
          <p className="mt-1 truncate text-muted-foreground text-xs">
            {paper.authors.join(" · ") || "作者信息未收录"}
          </p>
          <div className="mt-1">
            <PaperMetadata paper={paper} />
          </div>
        </button>
      ))}
    </div>
  );
}

function PaperDetail({
  canDelete,
  onClose,
  onDelete,
  onToggleSaved,
  paper,
  saved,
}: {
  canDelete: boolean;
  onClose: () => void;
  onDelete: () => void;
  onToggleSaved: () => void;
  paper: ResearchPaper;
  saved: boolean;
}) {
  const [pdfOpen, setPdfOpen] = useState(false);
  return (
    <section className="flex min-h-0 flex-1 flex-col border-l">
      <header className="flex shrink-0 items-start gap-2 border-b p-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm leading-5">{paper.title}</h3>
          <p className="mt-1 text-muted-foreground text-xs">
            {paper.authors.join(" · ") || "作者信息未收录"}
          </p>
          <div className="mt-1">
            <PaperMetadata paper={paper} />
          </div>
        </div>
        <Button
          aria-label="关闭详情"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <span aria-hidden="true">×</span>
        </Button>
      </header>
      <div className="flex shrink-0 items-center gap-1 border-b p-2">
        <Button
          onClick={() => void openExternalUrl(paper.url)}
          size="sm"
          variant="outline"
        >
          <ExternalLinkIcon />
          原文
        </Button>
        {paper.pdfUrl ? (
          <Button
            aria-pressed={pdfOpen}
            onClick={() => setPdfOpen((current) => !current)}
            size="sm"
            variant={pdfOpen ? "secondary" : "outline"}
          >
            <FileTextIcon />
            PDF
          </Button>
        ) : null}
        <Button
          onClick={onToggleSaved}
          size="sm"
          variant={saved ? "secondary" : "outline"}
        >
          <BookmarkIcon className={cn(saved && "fill-current")} />
          {saved ? "已收藏" : "收藏"}
        </Button>
        {canDelete ? (
          <Button
            aria-label="从文献库删除"
            className="ml-auto"
            onClick={onDelete}
            size="icon-sm"
            variant="ghost"
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {pdfOpen && paper.pdfUrl ? (
          <iframe
            className="size-full border-0 bg-background"
            src={paper.pdfUrl}
            title={`${paper.title} PDF`}
          />
        ) : (
          <div className="p-4">
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-xs">摘要</h4>
              {paper.verified ? (
                <Badge variant="outline">
                  {paper.sources.join(" / ")} 已通过元信息核验
                </Badge>
              ) : (
                <Badge variant="secondary">{paper.sources.join(" / ")}</Badge>
              )}
            </div>
            <p className="mt-3 whitespace-pre-wrap text-muted-foreground text-xs leading-5">
              {paper.abstract || "该数据源未提供摘要，请打开原文查看。"}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function ImportPaperDialog({
  onImported,
  open,
  setOpen,
}: {
  onImported: (paper: ResearchPaper) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [candidate, setCandidate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const runImport = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const paper = await importResearchPaper(candidate);
      onImported(paper);
      setCandidate("");
      setOpen(false);
    } catch (reason) {
      setError(toUserMessage(reason));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导入论文</DialogTitle>
          <DialogDescription>
            支持 arXiv 链接、doi.org 链接或
            DOI。元信息来自真实学术索引，不会生成缺失字段。
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label="论文地址或 DOI"
          onChange={(event) => setCandidate(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && candidate.trim() && !loading) {
              event.preventDefault();
              void runImport();
            }
          }}
          placeholder="https://arxiv.org/abs/... 或 10.xxxx/..."
          value={candidate}
        />
        {error ? (
          <p
            aria-live="assertive"
            className="rounded-lg bg-destructive/8 px-3 py-2 text-destructive text-xs"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter showCloseButton>
          <Button
            disabled={!candidate.trim() || loading}
            onClick={() => void runImport()}
          >
            {loading ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <ImportIcon />
            )}
            {loading ? "正在查询学术索引…" : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LibraryPanel({ searchMode }: { searchMode: boolean }) {
  const papers = useResearchStore((state) => state.papers);
  const addPapers = useResearchStore((state) => state.addPapers);
  const removePaper = useResearchStore((state) => state.removePaper);
  const setPaperSaved = useResearchStore((state) => state.setPaperSaved);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ResearchPaper[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const searchGateRef = useRef(new RequestGate());
  const visiblePapers = searchMode ? results : papers;
  const selected = visiblePapers.find((paper) => paper.id === selectedId);
  const selectedInLibrary = papers.find((paper) => paper.id === selectedId);

  const runSearch = async () => {
    const requestToken = searchGateRef.current.begin();
    setLoading(true);
    setError(undefined);
    setWarnings([]);
    try {
      const response = await searchResearchPapers(query);
      if (!searchGateRef.current.isCurrent(requestToken)) return;
      setResults(response.papers);
      setWarnings(response.warnings);
      setSelectedId(response.papers[0]?.id);
    } catch (reason) {
      if (!searchGateRef.current.isCurrent(requestToken)) return;
      setError(toUserMessage(reason));
      setResults([]);
    } finally {
      if (searchGateRef.current.isCurrent(requestToken)) {
        setLoading(false);
      }
    }
  };

  useEffect(() => () => searchGateRef.current.invalidate(), []);

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1">
        {searchMode ? (
          <>
            <div className="flex h-8 min-w-0 flex-1 basis-48 items-center rounded-lg border bg-background px-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="size-3.5 text-muted-foreground" />
              <input
                aria-label="搜索文献"
                className="min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && query.trim() && !loading) {
                    event.preventDefault();
                    void runSearch();
                  }
                }}
                placeholder="搜索 Crossref、OpenAlex、arXiv、Semantic Scholar 与 PubMed"
                value={query}
              />
            </div>
            <Button
              disabled={!query.trim() || loading}
              onClick={() => void runSearch()}
              size="sm"
            >
              {loading ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <SearchIcon />
              )}
              检索
            </Button>
          </>
        ) : (
          <>
            <LibraryIcon className="size-4 text-muted-foreground" />
            <span className="font-medium text-xs">本地文献库</span>
            <span className="text-muted-foreground text-xs">
              {papers.length} 篇
            </span>
            <Button
              className="ml-auto"
              onClick={() => setImportOpen(true)}
              size="sm"
              variant="outline"
            >
              <ImportIcon />
              导入
            </Button>
          </>
        )}
      </div>
      {error ? (
        <p
          aria-live="assertive"
          className="border-b bg-destructive/8 px-3 py-2 text-destructive text-xs"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <div
          aria-live="polite"
          className="flex gap-2 border-b bg-amber-500/8 px-3 py-2 text-amber-800 text-xs dark:text-amber-200"
          role="status"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{warnings.join("；")}</span>
        </div>
      ) : null}
      <div
        className={cn(
          "grid min-h-0 flex-1",
          selected
            ? "grid-cols-1 grid-rows-[minmax(12rem,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,46%)_minmax(0,1fr)] md:grid-rows-1"
            : "grid-cols-1",
        )}
      >
        <div className="min-h-0 min-w-0 overflow-y-auto">
          <PaperList
            empty={
              searchMode
                ? "输入主题后检索真实学术索引。"
                : "文献库为空。通过 DOI 或 arXiv 链接导入第一篇论文。"
            }
            onSelect={(paper) => setSelectedId(paper.id)}
            papers={visiblePapers}
            selectedId={selectedId}
          />
        </div>
        <AnimatePresence initial={false} mode="wait">
          {selected ? (
            <motion.div
              animate={{ opacity: 1, x: 0 }}
              className="min-h-0 min-w-0"
              exit={{ opacity: 0, x: 12 }}
              initial={{ opacity: 0, x: 12 }}
              key={selected.id}
              transition={{ duration: 0.24, ease: MOTION_EASE }}
            >
              <PaperDetail
                canDelete={!searchMode}
                onClose={() => setSelectedId(undefined)}
                onDelete={() => {
                  removePaper(selected.id);
                  setSelectedId(undefined);
                }}
                onToggleSaved={() => {
                  if (selectedInLibrary) {
                    setPaperSaved(selected.id, !selectedInLibrary.saved);
                  } else {
                    addPapers([{ ...selected, saved: true }]);
                  }
                }}
                paper={selectedInLibrary ?? selected}
                saved={selectedInLibrary?.saved ?? false}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {searchMode && results.length > 0 ? (
        <div className="flex h-10 shrink-0 items-center border-t px-3">
          <span className="text-muted-foreground text-xs">
            {results.length} 条结果 · 来自实际 API 响应
          </span>
          <Button
            className="ml-auto"
            onClick={() =>
              addPapers(results.map((paper) => ({ ...paper, saved: true })))
            }
            size="sm"
            variant="outline"
          >
            <BookmarkIcon />
            全部加入文献库
          </Button>
        </div>
      ) : null}
      <ImportPaperDialog
        onImported={(paper) => {
          addPapers([paper]);
          setSelectedId(paper.id);
        }}
        open={importOpen}
        setOpen={setImportOpen}
      />
    </div>
  );
}

function KnowledgePanel() {
  const papers = useResearchStore((state) => state.papers);
  const saved = papers.filter((paper) => paper.saved);
  const venues = useMemo(() => {
    const counts = new Map<string, number>();
    for (const paper of saved) {
      if (paper.venue)
        counts.set(paper.venue, (counts.get(paper.venue) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort(
      (left, right) => right[1] - left[1],
    );
  }, [saved]);
  return (
    <div className="size-full overflow-y-auto p-4">
      <div className="flex items-center gap-2 border-b pb-3">
        <BookOpenIcon className="size-4 text-muted-foreground" />
        <h2 className="font-medium text-sm">知识资产</h2>
      </div>
      {saved.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground text-xs">
          收藏论文后，这里会从真实元信息中聚合来源和研究主题。
        </p>
      ) : (
        <>
          <p className="mt-4 text-muted-foreground text-xs">
            {saved.length} 篇收藏论文 · {venues.length} 个出版来源
          </p>
          <div className="mt-3 divide-y rounded-lg border">
            {venues.map(([venue, count]) => (
              <div className="flex items-center px-3 py-2 text-xs" key={venue}>
                <span className="min-w-0 flex-1 truncate">{venue}</span>
                <span className="text-muted-foreground">{count} 篇</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TrackingPanel() {
  const topics = useResearchStore((state) => state.trackingTopics);
  const addTrackingTopic = useResearchStore((state) => state.addTrackingTopic);
  const refreshTrackingTopic = useResearchStore(
    (state) => state.refreshTrackingTopic,
  );
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState<string>();
  const [error, setError] = useState<string>();
  const refreshGatesRef = useRef(new Map<string, RequestGate>());
  const refresh = async (id: string, topicQuery: string) => {
    const gate = refreshGatesRef.current.get(id) ?? new RequestGate();
    refreshGatesRef.current.set(id, gate);
    const requestToken = gate.begin();
    setRefreshing(id);
    setError(undefined);
    try {
      const result = await searchResearchPapers(topicQuery);
      if (!gate.isCurrent(requestToken)) return;
      refreshTrackingTopic(id, result.papers);
    } catch (reason) {
      if (!gate.isCurrent(requestToken)) return;
      setError(toUserMessage(reason));
    } finally {
      if (gate.isCurrent(requestToken)) {
        setRefreshing((current) => (current === id ? undefined : current));
      }
    }
  };

  useEffect(
    () => () => {
      for (const gate of refreshGatesRef.current.values()) {
        gate.invalidate();
      }
    },
    [],
  );
  return (
    <div className="size-full overflow-y-auto">
      <div className="border-b p-3">
        <div className="flex items-center gap-2">
          <Input
            onChange={(event) => setTitle(event.target.value)}
            placeholder="追踪主题名称"
            value={title}
          />
          <Input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="实际检索词"
            value={query}
          />
          <Button
            disabled={!title.trim() || !query.trim()}
            onClick={() => {
              addTrackingTopic(title.trim(), query.trim());
              setTitle("");
              setQuery("");
            }}
            size="sm"
          >
            <PlusIcon />
            添加
          </Button>
        </div>
      </div>
      {error ? (
        <p
          aria-live="assertive"
          className="border-b bg-destructive/8 px-3 py-2 text-destructive text-xs"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {topics.length === 0 ? (
        <div className="grid min-h-48 place-items-center p-6 text-center">
          <div>
            <RadarIcon className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-3 text-muted-foreground text-xs">
              尚无追踪主题。添加后可手动刷新真实检索结果。
            </p>
          </div>
        </div>
      ) : (
        <div className="divide-y">
          {topics.map((topic) => (
            <div className="flex items-center gap-3 px-3 py-3" key={topic.id}>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-xs">{topic.title}</p>
                <p className="mt-1 truncate text-muted-foreground text-xs">
                  {topic.query}
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {topic.lastCheckedAt
                    ? `${new Date(topic.lastCheckedAt).toLocaleString()} · ${topic.latestCount} 条`
                    : "尚未检索"}
                </p>
              </div>
              <Button
                aria-label={`刷新 ${topic.title}`}
                disabled={refreshing !== undefined}
                onClick={() => void refresh(topic.id, topic.query)}
                size="icon-sm"
                variant="outline"
              >
                <RefreshCwIcon
                  className={cn(refreshing === topic.id && "animate-spin")}
                />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ResearchPanel({ kind }: ResearchPanelProps) {
  if (kind === "knowledge") return <KnowledgePanel />;
  if (kind === "search") return <LibraryPanel searchMode />;
  if (kind === "tracking") return <TrackingPanel />;
  return <LibraryPanel searchMode={false} />;
}
