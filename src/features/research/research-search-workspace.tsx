import {
  BookmarkIcon,
  FolderOpenIcon,
  HistoryIcon,
  RadarIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/domain/app-error";
import type {
  ResearchPaper,
  ResearchSource,
  ResearchSourceRun,
} from "@/domain/research";
import { RequestGate } from "@/domain/request-gate";

import {
  DEFAULT_RESEARCH_SEARCH_SOURCES,
  searchResearchPapers,
} from "./research-api";
import { useResearchCapabilityStore } from "./research-capability-store";
import type { ResearchMainKind } from "./research-main-workspace";
import { buildResearchQueryPlan } from "./research-query";
import { ResearchSearchHeader } from "./research-search-header";
import { useResearchStore } from "./research-store";
import { EmptyWorkflow, ResultTable } from "./research-ui";

type ResultSort = "relevance" | "year" | "citations";
const EXAMPLE_RESEARCH_QUERY = "大语言模型在科研发现中的应用证据";

export function SearchWorkspace({
  onOpenPaper,
  onNavigate,
  projectName,
}: {
  onOpenPaper: (paper: ResearchPaper) => void;
  onNavigate: (kind: ResearchMainKind) => void;
  projectName: string;
}) {
  const addPapers = useResearchStore((state) => state.addPapers);
  const inbox = useResearchStore((state) => state.inbox);
  const recordSearchResult = useResearchStore(
    (state) => state.recordSearchResult,
  );
  const history = useResearchStore((state) => state.searchHistory);
  const searchToolEnabled = useResearchCapabilityStore((state) =>
    state.enabledToolIds.includes("search-literature"),
  );
  const [query, setQuery] = useState("");
  const [papers, setPapers] = useState<ResearchPaper[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<ResultSort>("relevance");
  const [year, setYear] = useState("all");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [enabledSources, setEnabledSources] = useState<Set<ResearchSource>>(
    () => new Set(DEFAULT_RESEARCH_SEARCH_SOURCES),
  );
  const [activeView, setActiveView] = useState<"results" | "history">(
    "results",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sourceSummary, setSourceSummary] = useState<ResearchSource[]>([]);
  const [sourceRuns, setSourceRuns] = useState<ResearchSourceRun[]>([]);
  const [showSourceRuns, setShowSourceRuns] = useState(false);
  const [showQueryDetails, setShowQueryDetails] = useState(false);
  const [refinedQuery, setRefinedQuery] = useState("");
  const searchGateRef = useRef(new RequestGate());
  const queryPlan = useMemo(() => buildResearchQueryPlan(query), [query]);
  const inboxCreatedAt = inbox?.createdAt;
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

  useEffect(() => {
    searchGateRef.current.invalidate();
    if (!inbox || inboxCreatedAt === undefined) return;
    const plan = buildResearchQueryPlan(inbox.query);
    setQuery(inbox.query);
    setRefinedQuery(inbox.searchQuery !== plan.query ? inbox.searchQuery : "");
    setPapers(inbox.papers);
    setChecked(new Set());
    setSourceRuns(inbox.sourceRuns);
    setSourceSummary(
      inbox.sourceRuns
        .filter((run) => run.status === "success")
        .map((run) => run.source),
    );
  }, [inbox, inboxCreatedAt]);

  useEffect(() => () => searchGateRef.current.invalidate(), []);

  const runSearch = async (nextQuery = query, historySearchQuery?: string) => {
    const normalized = nextQuery.trim();
    if (!normalized || !searchToolEnabled) return;
    const requestToken = searchGateRef.current.begin();
    const nextPlan = buildResearchQueryPlan(normalized);
    const queryForSearch =
      historySearchQuery?.trim() ||
      (nextQuery === query ? refinedQuery.trim() : "") ||
      nextPlan.query;
    setQuery(normalized);
    setRefinedQuery(
      historySearchQuery?.trim() && historySearchQuery.trim() !== nextPlan.query
        ? historySearchQuery.trim()
        : nextQuery === query
          ? refinedQuery
          : "",
    );
    setLoading(true);
    setError(undefined);
    setWarnings([]);
    setSourceRuns([]);
    setActiveView("results");
    try {
      const result = await searchResearchPapers(
        queryForSearch,
        Array.from(enabledSources),
      );
      if (!searchGateRef.current.isCurrent(requestToken)) return;
      setPapers(result.papers);
      setChecked(new Set());
      setSourceSummary(result.sources);
      setWarnings(result.warnings);
      setSourceRuns(result.sourceRuns);
      recordSearchResult({
        query: normalized,
        searchQuery: queryForSearch,
        terms: buildResearchQueryPlan(queryForSearch).terms,
        result,
      });
    } catch (reason) {
      if (!searchGateRef.current.isCurrent(requestToken)) return;
      setError(toUserMessage(reason));
      setPapers([]);
      setSourceSummary([]);
      setSourceRuns([]);
    } finally {
      if (searchGateRef.current.isCurrent(requestToken)) setLoading(false);
    }
  };

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <ResearchSearchHeader
        activeView={activeView}
        enabledSources={enabledSources}
        error={error}
        loading={loading}
        onNavigate={onNavigate}
        onRunSearch={() => void runSearch()}
        projectName={projectName}
        query={query}
        queryPlan={queryPlan}
        refinedQuery={refinedQuery}
        searchToolEnabled={searchToolEnabled}
        setActiveView={setActiveView}
        setEnabledSources={setEnabledSources}
        setQuery={setQuery}
        setRefinedQuery={setRefinedQuery}
        setShowQueryDetails={setShowQueryDetails}
        setShowSourceRuns={setShowSourceRuns}
        showQueryDetails={showQueryDetails}
        showSourceRuns={showSourceRuns}
        sourceRuns={sourceRuns}
        warnings={warnings}
      />
      {activeView === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {history.length ? (
            <div className="max-w-4xl divide-y border-y">
              {history.map((item) => (
                <button
                  className="flex w-full items-center gap-3 px-2 py-3 text-left hover:bg-muted/40"
                  key={item.id}
                  onClick={() => void runSearch(item.query, item.searchQuery)}
                  type="button"
                >
                  <HistoryIcon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{item.query}</span>
                    {item.searchQuery && item.searchQuery !== item.query ? (
                      <span className="mt-1 block truncate text-muted-foreground text-[10px]">
                        提交：{item.searchQuery}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {item.resultCount} 条
                  </span>
                  {item.sources?.length ? (
                    <span className="hidden text-muted-foreground text-[10px] lg:inline">
                      {item.sources.join("、")}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground text-[11px]">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="py-12 text-center text-muted-foreground text-xs">
              暂无检索历史。完成一次检索后会保存在当前项目中。
            </p>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
              <span className="font-medium text-xs">
                {displayed.length} 条结果
              </span>
              {sourceSummary.length ? (
                <span className="text-muted-foreground text-[11px]">
                  {sourceSummary.join("、")} ·{" "}
                  {papers.filter((paper) => paper.verified).length} 篇已多源匹配
                </span>
              ) : null}
              <select
                aria-label="按年份筛选"
                className="h-7 rounded-md border bg-background px-2 text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:ml-auto"
                onChange={(event) => setYear(event.target.value)}
                value={year}
              >
                <option value="all">全部年份</option>
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                aria-label="排序方式"
                className="h-7 rounded-md border bg-background px-2 text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                onChange={(event) => setSort(event.target.value as ResultSort)}
                value={sort}
              >
                <option value="relevance">相关度排序</option>
                <option value="year">最新发表</option>
                <option value="citations">引用次数</option>
              </select>
              <label className="flex min-h-6 items-center gap-1.5 px-2 text-xs">
                <input
                  checked={verifiedOnly}
                  className="accent-primary"
                  onChange={(event) => setVerifiedOnly(event.target.checked)}
                  type="checkbox"
                />
                仅已核验
              </label>
              <Button
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
                保存为知识资产 {checked.size || ""}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <ResultTable
                checked={checked}
                onCheck={(id) =>
                  setChecked((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onSelect={onOpenPaper}
                papers={displayed}
                emptyAction={
                  <EmptyWorkflow
                    actions={
                      <>
                        <Button
                          onClick={() => void runSearch(EXAMPLE_RESEARCH_QUERY)}
                          size="sm"
                        >
                          <SearchIcon />
                          {query.trim() ? "试用示例问题" : "运行示例检索"}
                        </Button>
                        <Button
                          onClick={() => onNavigate("library")}
                          size="sm"
                          variant="outline"
                        >
                          <FolderOpenIcon />
                          导入或查看文献库
                        </Button>
                        <Button
                          onClick={() => onNavigate("tracking")}
                          size="sm"
                          variant="ghost"
                        >
                          <RadarIcon />
                          创建科研追踪
                        </Button>
                      </>
                    }
                    description={
                      query.trim()
                        ? "当前问题没有返回结果。可以先运行一个真实索引示例，确认数据源可用，再调整检索词。"
                        : "没有预置假论文；运行示例会访问真实学术索引，返回结果后可以直接保存为知识资产。"
                    }
                    steps={[
                      {
                        title: "描述问题",
                        description: "用白话写下你想研究的方向。",
                      },
                      {
                        title: "多源检索",
                        description: "查看各索引的返回数量和异常。",
                      },
                      {
                        title: "保存为知识资产",
                        description: "收藏论文并在详情中继续阅读。",
                      },
                    ]}
                    title={
                      query.trim()
                        ? "换一个可验证的研究问题"
                        : "从一个研究问题开始"
                    }
                  />
                }
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
