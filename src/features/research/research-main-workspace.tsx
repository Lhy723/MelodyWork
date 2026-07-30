import {
  BookmarkIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderOpenIcon,
  HistoryIcon,
  LoaderCircleIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResearchPaper, ResearchSource } from "@/domain/research";
import { FileWorkspace } from "@/features/files/file-workspace";
import { TerminalPanel } from "@/features/terminal/terminal-panel";
import { openExternalUrl } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

import {
  DEFAULT_RESEARCH_SEARCH_SOURCES,
  importResearchPaper,
  RESEARCH_SEARCH_SOURCES,
  searchResearchPapers,
} from "./research-api";
import { useResearchStore } from "./research-store";

type ResearchMainKind =
  | "knowledge"
  | "library"
  | "experiments"
  | "sandbox"
  | "search"
  | "tracking";
type ResultSort = "relevance" | "year" | "citations";

const SourceToggle = ({
  checked,
  disabled,
  disabledReason,
  label,
  onCheckedChange,
}: {
  checked?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  label: string;
  onCheckedChange?: (checked: boolean) => void;
}) => (
  <label
    className={cn(
      "flex items-center gap-1.5 text-xs",
      disabled ? "cursor-not-allowed text-muted-foreground/55" : "text-foreground",
    )}
  >
    <input
      checked={checked}
      className="size-3.5 accent-primary"
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      readOnly={!onCheckedChange}
      type="checkbox"
    />
    {label}
    {disabledReason ? (
      <span className="text-[10px]">{disabledReason}</span>
    ) : null}
  </label>
);

function ResultTable({
  checked,
  emptyText = "输入研究问题后检索真实学术索引",
  onCheck,
  onSelect,
  papers,
  selectedId,
}: {
  checked: Set<string>;
  emptyText?: string;
  onCheck: (id: string) => void;
  onSelect: (paper: ResearchPaper) => void;
  papers: ResearchPaper[];
  selectedId?: string;
}) {
  if (papers.length === 0) {
    return (
      <div className="grid min-h-64 place-items-center text-center">
        <div>
          <SearchIcon className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-muted-foreground text-xs">
            {emptyText}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-[760px]">
      <div className="grid grid-cols-[34px_minmax(300px,1fr)_180px_68px_110px_72px_92px] border-b bg-muted/30 px-2 py-2 text-muted-foreground text-[11px]">
        <span />
        <span>标题</span>
        <span>作者</span>
        <span>年份</span>
        <span>来源</span>
        <span>引用</span>
        <span>核验状态</span>
      </div>
      {papers.map((paper) => (
        <div
          className={cn(
            "grid grid-cols-[34px_minmax(300px,1fr)_180px_68px_110px_72px_92px] items-start border-b px-2 text-left text-xs hover:bg-muted/30",
            selectedId === paper.id && "bg-muted/50",
          )}
          key={paper.id}
        >
          <label className="grid h-full min-h-16 place-items-center">
            <input
              checked={checked.has(paper.id)}
              className="size-3.5 accent-primary"
              onChange={() => onCheck(paper.id)}
              type="checkbox"
            />
          </label>
          <button
            className="min-w-0 py-3 pr-3 text-left"
            onClick={() => onSelect(paper)}
            type="button"
          >
            <span className="research-serif line-clamp-2 font-medium text-[13px] leading-4">{paper.title}</span>
            {paper.doi ? (
              <span className="mt-1 block truncate text-muted-foreground text-[10px]">
                {paper.doi}
              </span>
            ) : null}
          </button>
          <span className="line-clamp-2 py-3 pr-3 text-muted-foreground leading-4">
            {paper.authors.join("、") || "作者未收录"}
          </span>
          <span className="py-3 tabular-nums">{paper.year ?? "—"}</span>
          <span className="truncate py-3 pr-3" title={paper.venue}>
            {paper.venue ?? paper.sources[0]}
          </span>
          <span className="py-3 tabular-nums">
            {paper.citationCount?.toLocaleString() ?? "—"}
          </span>
          <span className="flex items-center gap-1 py-3">
            {paper.verified ? (
              <>
                <CheckCircle2Icon className="size-3.5 text-emerald-600" />
                已核验
              </>
            ) : (
              <span className="text-muted-foreground">单一来源</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function PaperInspector({
  onClose,
  onDelete,
  paper,
}: {
  onClose: () => void;
  onDelete?: () => void;
  paper: ResearchPaper;
}) {
  const addPapers = useResearchStore((state) => state.addPapers);
  const stored = useResearchStore((state) =>
    state.papers.find((item) => item.id === paper.id),
  );
  const [showPdf, setShowPdf] = useState(false);
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l bg-background">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FileTextIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-xs">文献详情</span>
        <Button className="ml-auto" onClick={onClose} size="icon-xs" variant="ghost">
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="research-serif font-semibold text-lg leading-6">{paper.title}</h2>
        <p className="mt-2 text-muted-foreground text-xs leading-5">
          {paper.authors.join(" · ") || "作者信息未收录"}
        </p>
        <p className="mt-1 text-muted-foreground text-[11px]">
          {[paper.year, paper.venue, paper.doi].filter(Boolean).join(" · ")}
        </p>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {paper.pdfUrl ? (
            <Button onClick={() => setShowPdf((value) => !value)} size="sm" variant="outline">
              <FileTextIcon />
              {showPdf ? "返回摘要" : "打开 PDF"}
            </Button>
          ) : null}
          <Button onClick={() => void openExternalUrl(paper.url)} size="sm" variant="outline">
            <ExternalLinkIcon />
            来源页面
          </Button>
          <Button
            onClick={() => addPapers([{ ...paper, saved: true }])}
            size="sm"
            variant={stored?.saved ? "secondary" : "outline"}
          >
            <BookmarkIcon className={cn(stored?.saved && "fill-current")} />
            {stored?.saved ? "已收藏" : "保存到库"}
          </Button>
          {onDelete ? (
            <Button onClick={onDelete} size="sm" variant="outline">
              <Trash2Icon />
              删除
            </Button>
          ) : null}
        </div>
        {showPdf && paper.pdfUrl ? (
          <iframe className="mt-4 h-[560px] w-full border" src={paper.pdfUrl} title={`${paper.title} PDF`} />
        ) : (
          <>
            <div className="mt-5 border-t pt-4">
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-xs">摘要</h3>
                <Badge variant={paper.verified ? "outline" : "secondary"}>
                  {paper.sources.join(" / ")}
                </Badge>
              </div>
              <p className="research-serif mt-3 whitespace-pre-wrap text-[13px] text-muted-foreground leading-6">
                {paper.abstract || "索引未提供摘要，可打开来源页面查看原文。"}
              </p>
            </div>
            <dl className="mt-5 grid grid-cols-[72px_1fr] gap-y-2 border-t pt-4 text-xs">
              <dt className="text-muted-foreground">引用次数</dt>
              <dd>{paper.citationCount?.toLocaleString() ?? "未提供"}</dd>
              <dt className="text-muted-foreground">数据来源</dt>
              <dd>{paper.sources.join("、")}</dd>
              <dt className="text-muted-foreground">核验状态</dt>
              <dd>{paper.verified ? "已由多个索引交叉匹配" : "当前仅有单一索引记录"}</dd>
            </dl>
          </>
        )}
      </div>
    </aside>
  );
}

function SearchWorkspace() {
  const addPapers = useResearchStore((state) => state.addPapers);
  const addSearchHistory = useResearchStore((state) => state.addSearchHistory);
  const history = useResearchStore((state) => state.searchHistory);
  const [query, setQuery] = useState("");
  const [papers, setPapers] = useState<ResearchPaper[]>([]);
  const [selected, setSelected] = useState<ResearchPaper>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<ResultSort>("relevance");
  const [year, setYear] = useState("all");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [enabledSources, setEnabledSources] = useState<Set<ResearchSource>>(
    () => new Set(DEFAULT_RESEARCH_SEARCH_SOURCES),
  );
  const [activeView, setActiveView] = useState<"results" | "history">("results");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const displayed = useMemo(() => {
    let next = papers.filter(
      (paper) =>
        (year === "all" || String(paper.year) === year) &&
        (!verifiedOnly || paper.verified),
    );
    if (sort === "year") {
      next = [...next].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    } else if (sort === "citations") {
      next = [...next].sort(
        (a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0),
      );
    }
    return next;
  }, [papers, sort, verifiedOnly, year]);
  const years = Array.from(
    new Set(papers.flatMap((paper) => (paper.year ? [paper.year] : []))),
  ).sort((a, b) => b - a);
  const runSearch = async (nextQuery = query) => {
    const normalized = nextQuery.trim();
    if (!normalized) return;
    setQuery(normalized);
    setLoading(true);
    setError(undefined);
    setActiveView("results");
    try {
      const result = await searchResearchPapers(
        normalized,
        Array.from(enabledSources),
      );
      setPapers(result.papers);
      setSelected(result.papers[0]);
      setChecked(new Set());
      addSearchHistory(normalized, result.papers.length);
      if (result.warnings.length) setError(result.warnings.join("；"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPapers([]);
      setSelected(undefined);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b px-6 pt-4 pb-3">
        <h1 className="research-serif font-semibold text-2xl">自然语言检索</h1>
        <p className="mt-1 text-muted-foreground text-xs">
          用自然语言描述研究问题，从已接通的真实学术索引中检索并交叉核验。
        </p>
        <div className="mt-4 rounded-lg border">
          <textarea
            className="h-16 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void runSearch();
            }}
            placeholder="例如：大语言模型在科研发现中的应用效果如何？有哪些可复现的证据？"
            value={query}
          />
          <div className="flex flex-wrap items-center gap-4 border-t px-3 py-2">
            <span className="text-muted-foreground text-[11px]">数据源</span>
            {RESEARCH_SEARCH_SOURCES.map((source) => (
              <SourceToggle
                checked={enabledSources.has(source)}
                disabled={source === "OpenAlex"}
                disabledReason={source === "OpenAlex" ? "需 API Key" : undefined}
                key={source}
                label={source}
                onCheckedChange={(checked) =>
                  setEnabledSources((current) => {
                    const next = new Set(current);
                    if (checked) next.add(source);
                    else next.delete(source);
                    return next;
                  })
                }
              />
            ))}
            <Button
              className="ml-auto"
              disabled={!query.trim() || loading || enabledSources.size === 0}
              onClick={() => void runSearch()}
              size="sm"
            >
              {loading ? <LoaderCircleIcon className="animate-spin" /> : <SearchIcon />}
              {loading ? "正在检索…" : "检索"}
            </Button>
          </div>
        </div>
      </header>
      <div className="flex h-10 shrink-0 items-end gap-5 border-b px-6">
        <button
          className={cn("h-10 border-b-2 px-1 text-xs", activeView === "results" ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground")}
          onClick={() => setActiveView("results")}
          type="button"
        >
          检索结果
        </button>
        <button
          className={cn("h-10 border-b-2 px-1 text-xs", activeView === "history" ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground")}
          onClick={() => setActiveView("history")}
          type="button"
        >
          检索历史
        </button>
      </div>
      {error ? <p className="border-b bg-amber-500/8 px-6 py-2 text-amber-800 text-xs dark:text-amber-200">{error}</p> : null}
      {activeView === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {history.length ? (
            <div className="max-w-4xl divide-y border-y">
              {history.map((item) => (
                <button className="flex w-full items-center gap-3 px-2 py-3 text-left hover:bg-muted/40" key={item.id} onClick={() => void runSearch(item.query)} type="button">
                  <HistoryIcon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{item.query}</span>
                  <span className="text-muted-foreground text-xs">{item.resultCount} 条</span>
                  <span className="text-muted-foreground text-[11px]">{new Date(item.createdAt).toLocaleString()}</span>
                </button>
              ))}
            </div>
          ) : <p className="py-12 text-center text-muted-foreground text-xs">暂无检索历史</p>}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
              <span className="font-medium text-xs">{displayed.length} 条结果</span>
              <select className="ml-auto h-7 rounded-md border bg-background px-2 text-xs" onChange={(event) => setYear(event.target.value)} value={year}>
                <option value="all">全部年份</option>
                {years.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <select className="h-7 rounded-md border bg-background px-2 text-xs" onChange={(event) => setSort(event.target.value as ResultSort)} value={sort}>
                <option value="relevance">相关度排序</option>
                <option value="year">最新发表</option>
                <option value="citations">引用次数</option>
              </select>
              <label className="flex items-center gap-1.5 px-2 text-xs">
                <input checked={verifiedOnly} className="accent-primary" onChange={(event) => setVerifiedOnly(event.target.checked)} type="checkbox" />
                仅已核验
              </label>
              <Button
                disabled={checked.size === 0}
                onClick={() => addPapers(papers.filter((paper) => checked.has(paper.id)).map((paper) => ({ ...paper, saved: true })))}
                size="sm"
                variant="outline"
              >
                <BookmarkIcon />
                保存所选 {checked.size || ""}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <ResultTable
                checked={checked}
                onCheck={(id) => setChecked((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return next;
                })}
                onSelect={setSelected}
                papers={displayed}
                selectedId={selected?.id}
              />
            </div>
          </section>
          {selected ? <PaperInspector onClose={() => setSelected(undefined)} paper={selected} /> : null}
        </div>
      )}
    </div>
  );
}

function TrackingWorkspace() {
  const topics = useResearchStore((state) => state.trackingTopics);
  const papers = useResearchStore((state) => state.papers);
  const addPapers = useResearchStore((state) => state.addPapers);
  const addTrackingTopic = useResearchStore((state) => state.addTrackingTopic);
  const removeTrackingTopic = useResearchStore((state) => state.removeTrackingTopic);
  const updateTrackingTopic = useResearchStore((state) => state.updateTrackingTopic);
  const [selectedId, setSelectedId] = useState<string>();
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState<string>();
  const [selectedPaper, setSelectedPaper] = useState<ResearchPaper>();
  const selectedTopic = topics.find((topic) => topic.id === selectedId) ?? topics[0];
  const topicPapers = selectedTopic?.paperIds?.flatMap((id) => {
    const paper = papers.find((item) => item.id === id);
    return paper ? [paper] : [];
  }) ?? [];
  const refresh = async (id: string, topicQuery: string) => {
    setRefreshing(id);
    try {
      const result = await searchResearchPapers(topicQuery);
      addPapers(result.papers);
      updateTrackingTopic(id, {
        lastCheckedAt: Date.now(),
        latestCount: result.papers.length,
        paperIds: result.papers.map((paper) => paper.id),
      });
    } finally {
      setRefreshing(undefined);
    }
  };
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b px-6 py-4">
        <h1 className="research-serif font-semibold text-2xl">科研追踪</h1>
        <p className="mt-1 text-muted-foreground text-xs">保存研究方向并按需刷新真实索引，结果自动进入本地文献库。</p>
        <div className="mt-4 flex max-w-4xl gap-2">
          <Input onChange={(event) => setTitle(event.target.value)} placeholder="追踪主题名称" value={title} />
          <Input onChange={(event) => setQuery(event.target.value)} placeholder="检索词，例如 multimodal RAG evaluation" value={query} />
          <Button disabled={!title.trim() || !query.trim()} onClick={() => {
            addTrackingTopic(title.trim(), query.trim());
            setTitle("");
            setQuery("");
          }}>
            <PlusIcon />添加追踪
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r">
          <div className="flex h-10 items-center border-b px-3 text-muted-foreground text-[11px]">追踪主题 · {topics.length}</div>
          {topics.map((topic) => (
            <button className={cn("w-full border-b px-3 py-3 text-left hover:bg-muted/40", selectedTopic?.id === topic.id && "bg-muted/60")} key={topic.id} onClick={() => setSelectedId(topic.id)} type="button">
              <div className="flex items-start gap-2">
                <RadarIcon className="mt-0.5 size-3.5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-xs">{topic.title}</p>
                  <p className="mt-1 truncate text-muted-foreground text-[11px]">{topic.query}</p>
                  <p className="mt-2 text-muted-foreground text-[10px]">{topic.lastCheckedAt ? `${topic.latestCount} 条 · ${new Date(topic.lastCheckedAt).toLocaleString()}` : "尚未刷新"}</p>
                </div>
              </div>
            </button>
          ))}
          {!topics.length ? <p className="px-4 py-10 text-center text-muted-foreground text-xs">添加第一个研究方向</p> : null}
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          {selectedTopic ? (
            <>
              <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{selectedTopic.title}</p>
                  <p className="truncate text-muted-foreground text-[11px]">{selectedTopic.query}</p>
                </div>
                <Button disabled={Boolean(refreshing)} onClick={() => void refresh(selectedTopic.id, selectedTopic.query)} size="sm">
                  <RefreshCwIcon className={cn(refreshing === selectedTopic.id && "animate-spin")} />
                  {refreshing === selectedTopic.id ? "正在刷新…" : "刷新进展"}
                </Button>
                <Button aria-label="删除追踪主题" onClick={() => removeTrackingTopic(selectedTopic.id)} size="icon-sm" variant="ghost"><Trash2Icon /></Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <ResultTable checked={new Set()} onCheck={() => {}} onSelect={setSelectedPaper} papers={topicPapers} selectedId={selectedPaper?.id} />
              </div>
            </>
          ) : <div className="grid flex-1 place-items-center text-muted-foreground text-xs">选择或创建一个追踪主题</div>}
        </section>
        {selectedPaper ? <PaperInspector onClose={() => setSelectedPaper(undefined)} paper={selectedPaper} /> : null}
      </div>
    </div>
  );
}

function LibraryWorkspace() {
  const papers = useResearchStore((state) => state.papers);
  const addPapers = useResearchStore((state) => state.addPapers);
  const removePaper = useResearchStore((state) => state.removePaper);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "saved" | "verified">("all");
  const [selected, setSelected] = useState<ResearchPaper>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [candidate, setCandidate] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return papers.filter(
      (paper) =>
        (scope === "all" ||
          (scope === "saved" && paper.saved) ||
          (scope === "verified" && paper.verified)) &&
        (!normalized ||
          paper.title.toLocaleLowerCase().includes(normalized) ||
          paper.authors.some((author) =>
            author.toLocaleLowerCase().includes(normalized),
          ) ||
          paper.doi?.toLocaleLowerCase().includes(normalized)),
    );
  }, [papers, query, scope]);
  const runImport = async () => {
    setImporting(true);
    setError(undefined);
    try {
      const paper = await importResearchPaper(candidate);
      addPapers([paper]);
      setSelected(paper);
      setCandidate("");
      setImportOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  };
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b px-6 py-4">
        <h1 className="research-serif font-semibold text-2xl">文献库</h1>
        <p className="mt-1 text-muted-foreground text-xs">
          集中管理与研究相关的真实文献、收藏和元信息。
        </p>
        <div className="mt-4 flex items-center gap-2">
          <div className="flex h-8 min-w-72 max-w-xl flex-1 items-center rounded-md border px-2">
            <SearchIcon className="size-3.5 text-muted-foreground" />
            <input
              className="min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="检索标题、作者或 DOI"
              value={query}
            />
          </div>
          {(["all", "saved", "verified"] as const).map((value) => (
            <Button
              key={value}
              onClick={() => setScope(value)}
              size="sm"
              variant={scope === value ? "secondary" : "ghost"}
            >
              {value === "all" ? "全部文献" : value === "saved" ? "已保存" : "已核验"}
            </Button>
          ))}
          <Button className="ml-auto" onClick={() => setImportOpen((value) => !value)} size="sm" variant="outline">
            <PlusIcon />
            导入文献
          </Button>
        </div>
        {importOpen ? (
          <div className="mt-2 flex items-center gap-2">
            <Input
              onChange={(event) => setCandidate(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && candidate.trim() && !importing)
                  void runImport();
              }}
              placeholder="arXiv 链接、doi.org 链接或 DOI"
              value={candidate}
            />
            <Button disabled={!candidate.trim() || importing} onClick={() => void runImport()} size="sm">
              {importing ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
              {importing ? "正在查询…" : "确认导入"}
            </Button>
          </div>
        ) : null}
        {error ? <p className="mt-2 text-destructive text-xs">{error}</p> : null}
      </header>
      <div className="flex h-10 shrink-0 items-center border-b px-4">
        <span className="font-medium text-xs">{visible.length} 篇文献</span>
        <Button
          className="ml-auto"
          disabled={checked.size === 0}
          onClick={() =>
            addPapers(
              papers
                .filter((paper) => checked.has(paper.id))
                .map((paper) => ({ ...paper, saved: true })),
            )
          }
          size="sm"
          variant="outline"
        >
          <BookmarkIcon />
          收藏所选 {checked.size || ""}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-auto">
          <ResultTable
            checked={checked}
            emptyText="文献库为空，可通过 DOI 或 arXiv 链接导入论文"
            onCheck={(id) =>
              setChecked((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onSelect={setSelected}
            papers={visible}
            selectedId={selected?.id}
          />
        </section>
        {selected ? (
          <PaperInspector
            onClose={() => setSelected(undefined)}
            onDelete={() => {
              removePaper(selected.id);
              setSelected(undefined);
            }}
            paper={selected}
          />
        ) : null}
      </div>
    </div>
  );
}

function KnowledgeWorkspace() {
  const papers = useResearchStore((state) => state.papers);
  const saved = useMemo(
    () => papers.filter((paper) => paper.saved),
    [papers],
  );
  const [venue, setVenue] = useState("all");
  const [selected, setSelected] = useState<ResearchPaper>();
  const venues = useMemo(() => {
    const counts = new Map<string, number>();
    for (const paper of saved) {
      const key = paper.venue || "未分类来源";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [saved]);
  const visible =
    venue === "all"
      ? saved
      : saved.filter((paper) => (paper.venue || "未分类来源") === venue);
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b px-6 py-4">
        <h1 className="research-serif font-semibold text-2xl">知识资产</h1>
        <p className="mt-1 text-muted-foreground text-xs">
          从已收藏文献中建立可追溯的来源索引与阅读脉络。
        </p>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r">
          <div className="flex h-10 items-center border-b px-3 font-medium text-xs">
            出版来源
          </div>
          <button
            className={cn("flex w-full items-center px-3 py-2.5 text-xs hover:bg-muted/40", venue === "all" && "bg-muted/60")}
            onClick={() => setVenue("all")}
            type="button"
          >
            <span className="flex-1 text-left">全部收藏</span>
            <span className="text-muted-foreground">{saved.length}</span>
          </button>
          {venues.map(([name, count]) => (
            <button
              className={cn("flex w-full items-center border-t px-3 py-2.5 text-xs hover:bg-muted/40", venue === name && "bg-muted/60")}
              key={name}
              onClick={() => setVenue(name)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate text-left">{name}</span>
              <span className="ml-2 text-muted-foreground">{count}</span>
            </button>
          ))}
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex h-10 items-center border-b px-4 text-xs">
            <span className="font-medium">{venue === "all" ? "全部收藏" : venue}</span>
            <span className="ml-2 text-muted-foreground">{visible.length} 篇</span>
          </div>
          {visible.length ? (
            <div className="divide-y">
              {visible.map((paper) => (
                <button
                  className={cn("block w-full px-5 py-4 text-left hover:bg-muted/30", selected?.id === paper.id && "bg-muted/50")}
                  key={paper.id}
                  onClick={() => setSelected(paper)}
                  type="button"
                >
                  <h2 className="research-serif text-base font-semibold leading-5">{paper.title}</h2>
                  <p className="mt-1 text-muted-foreground text-xs">{paper.authors.join(" · ") || "作者未收录"}</p>
                  <p className="mt-2 line-clamp-2 max-w-3xl research-serif text-[13px] text-muted-foreground leading-5">{paper.abstract || "索引未提供摘要。"}</p>
                </button>
              ))}
            </div>
          ) : (
            <p className="py-16 text-center text-muted-foreground text-xs">
              在文献库中收藏论文后，会在这里形成知识资产。
            </p>
          )}
        </section>
        {selected ? <PaperInspector onClose={() => setSelected(undefined)} paper={selected} /> : null}
      </div>
    </div>
  );
}

function ExperimentWorkspace({
  root,
}: {
  root: string;
}) {
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-end gap-4 border-b px-6 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="research-serif font-semibold text-2xl">实验资源</h1>
          <p className="mt-1 text-muted-foreground text-xs">
            浏览、编辑并组织当前工作区中的数据、代码、配置与实验结果。
          </p>
        </div>
        <div className="flex max-w-md items-center gap-2 rounded-md border px-3 py-2 text-muted-foreground text-xs">
          <FolderOpenIcon className="size-3.5" />
          <span className="truncate">{root}</span>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <FileWorkspace embedded root={root} />
      </div>
    </div>
  );
}

function SandboxWorkspace({ cwd }: { cwd: string }) {
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-end border-b px-6 py-4">
        <div>
          <h1 className="research-serif font-semibold text-2xl">研究沙盒</h1>
          <p className="mt-1 text-muted-foreground text-xs">
            在当前工作区中运行分析、复现实验并检查输出。
          </p>
        </div>
        <code className="ml-auto max-w-md truncate rounded-md border px-3 py-2 text-[11px] text-muted-foreground">
          {cwd}
        </code>
      </header>
      <div className="min-h-0 flex-1">
        <TerminalPanel cwd={cwd} embedded />
      </div>
    </div>
  );
}

export function ResearchMainWorkspace({
  cwd,
  kind,
  root,
}: {
  cwd: string;
  kind: ResearchMainKind;
  root: string;
}) {
  return (
    <div className="relative size-full min-h-0">
      <div
        aria-hidden={kind !== "search"}
        className={cn("absolute inset-0", kind !== "search" && "hidden")}
        inert={kind !== "search"}
      >
        <SearchWorkspace />
      </div>
      <div
        aria-hidden={kind !== "tracking"}
        className={cn("absolute inset-0", kind !== "tracking" && "hidden")}
        inert={kind !== "tracking"}
      >
        <TrackingWorkspace />
      </div>
      {kind === "knowledge" ? <KnowledgeWorkspace /> : null}
      {kind === "library" ? <LibraryWorkspace /> : null}
      {kind === "experiments" ? (
        <ExperimentWorkspace root={root} />
      ) : null}
      {kind === "sandbox" ? <SandboxWorkspace cwd={cwd} /> : null}
    </div>
  );
}
