import {
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  SearchIcon,
  TriangleAlertIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import { CollapsibleBanner } from "@/components/interior/collapsible-banner";
import { LoadingButton } from "@/components/interior/loading-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResearchSource, ResearchSourceRun } from "@/domain/research";
import { cn } from "@/lib/utils";

import { RESEARCH_SEARCH_SOURCES } from "./research-api";
import type { ResearchQueryPlan } from "./research-query";
import type { ResearchMainKind } from "./research-main-workspace";
import { ProjectContext, SourceToggle } from "./research-ui";

export function ResearchSearchHeader({
  activeView,
  enabledSources,
  error,
  loading,
  onNavigate,
  onRunSearch,
  projectName,
  query,
  queryPlan,
  refinedQuery,
  setActiveView,
  setEnabledSources,
  setQuery,
  setRefinedQuery,
  setShowQueryDetails,
  setShowSourceRuns,
  showQueryDetails,
  showSourceRuns,
  sourceRuns,
  warnings,
  searchToolEnabled,
}: {
  activeView: "results" | "history";
  enabledSources: Set<ResearchSource>;
  error?: string;
  loading: boolean;
  onNavigate: (kind: ResearchMainKind) => void;
  onRunSearch: () => unknown;
  projectName: string;
  query: string;
  queryPlan: ResearchQueryPlan;
  refinedQuery: string;
  setActiveView: Dispatch<SetStateAction<"results" | "history">>;
  setEnabledSources: Dispatch<SetStateAction<Set<ResearchSource>>>;
  setQuery: (value: string) => void;
  setRefinedQuery: (value: string) => void;
  setShowQueryDetails: Dispatch<SetStateAction<boolean>>;
  setShowSourceRuns: Dispatch<SetStateAction<boolean>>;
  showQueryDetails: boolean;
  showSourceRuns: boolean;
  sourceRuns: ResearchSourceRun[];
  warnings: string[];
  searchToolEnabled: boolean;
}) {
  const searchButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <header className="shrink-0 border-b px-6 pt-4 pb-3">
        <h1 className="research-serif font-semibold text-2xl">自然语言检索</h1>
        <p className="mt-1 text-muted-foreground text-xs">
          用自然语言描述研究问题，从已接通的真实学术索引中检索并交叉核验。
        </p>
        <ProjectContext projectName={projectName} />
        <div className="mt-4 rounded-lg border focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
          <textarea
            aria-label="自然语言研究问题"
            className="h-16 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              setQuery(event.target.value);
              setRefinedQuery("");
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                searchButtonRef.current?.click();
              }
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
                disabledReason={
                  source === "OpenAlex" ? "需 API Key" : undefined
                }
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
            <LoadingButton
              className="sm:ml-auto"
              disabled={
                !searchToolEnabled ||
                !query.trim() ||
                loading ||
                enabledSources.size === 0
              }
              errorLabel="重试"
              icon={<SearchIcon />}
              onAction={onRunSearch}
              pendingLabel="正在检索…"
              ref={searchButtonRef}
              size="sm"
              successLabel="检索完成"
            >
              检索
            </LoadingButton>
          </div>
        </div>
        {!searchToolEnabled ? (
          <p className="mt-2 flex items-center gap-1.5 text-amber-700 text-[11px] dark:text-amber-300">
            <TriangleAlertIcon className="size-3.5" />
            多源文献检索工具已停用；请先在“科研能力”中启用。
          </p>
        ) : null}
        {queryPlan.query ? (
          <div className="mt-2 rounded-md border bg-muted/20 px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <WandSparklesIcon className="size-3.5 text-muted-foreground" />
              <span className="font-medium">检索词草案</span>
              <span className="text-muted-foreground">
                本地规则整理，可编辑
              </span>
              <Button
                aria-expanded={showQueryDetails}
                className="ml-auto h-6 gap-1 px-1.5 text-[11px]"
                onClick={() => setShowQueryDetails((value) => !value)}
                size="sm"
                variant="ghost"
              >
                {showQueryDetails ? "收起改写过程" : "查看改写过程"}
                <ChevronDownIcon
                  className={cn("size-3", showQueryDetails && "rotate-180")}
                />
              </Button>
            </div>
            <Input
              aria-label="可编辑的检索词草案"
              className="mt-2 h-8 bg-background text-xs"
              onChange={(event) => setRefinedQuery(event.target.value)}
              value={refinedQuery || queryPlan.query}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {queryPlan.terms.map((term) => (
                <span
                  className="rounded bg-background px-1.5 py-0.5 text-muted-foreground text-[10px]"
                  key={term}
                >
                  {term}
                </span>
              ))}
            </div>
            {showQueryDetails ? (
              <div className="mt-3 grid gap-2 border-t pt-3 text-[11px]">
                <div className="grid grid-cols-[68px_1fr] gap-2">
                  <span className="text-muted-foreground">原始问题</span>
                  <span className="break-words">{queryPlan.original}</span>
                </div>
                <div className="grid grid-cols-[68px_1fr] gap-2">
                  <span className="text-muted-foreground">实际提交</span>
                  <span className="break-words">
                    {refinedQuery || queryPlan.query}
                  </span>
                </div>
                <div className="grid grid-cols-[68px_1fr] gap-2">
                  <span className="text-muted-foreground">处理方式</span>
                  <span className="text-muted-foreground">
                    {queryPlan.strategy === "local-keyword-normalization"
                      ? "本地关键词归一化：去除常见疑问词，保留可检索术语"
                      : "透明规则整理"}
                  </span>
                </div>
                {queryPlan.removedTerms?.length ? (
                  <div className="grid grid-cols-[68px_1fr] gap-2">
                    <span className="text-muted-foreground">已去除</span>
                    <span className="text-muted-foreground">
                      {queryPlan.removedTerms.join("、")}
                    </span>
                  </div>
                ) : null}
                <p className="text-muted-foreground text-[10px] leading-4">
                  这一步不会假装成 AI
                  结论；你可以直接修改实际提交词，检索历史也会保存这份改写记录。
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            支持多源检索与 DOI 元信息核验；打开一篇论文进入专注详情页。
          </span>
          <Button
            className="ml-auto h-6 px-2 text-[11px]"
            onClick={() => onNavigate("library")}
            size="sm"
            variant="ghost"
          >
            查看文献库
            <ArrowRightIcon />
          </Button>
        </div>
        <p className="mt-1 text-muted-foreground text-[10px]">
          核验标记表示同一 DOI
          或规范化标题在多个索引中匹配；单一来源仍需打开原文核对。
        </p>
      </header>
      <div className="flex h-10 shrink-0 items-end gap-5 border-b px-6">
        <button
          aria-pressed={activeView === "results"}
          className={cn(
            "h-10 border-b-2 px-1 text-xs",
            activeView === "results"
              ? "border-primary font-medium text-primary"
              : "border-transparent text-muted-foreground",
          )}
          onClick={() => setActiveView("results")}
          type="button"
        >
          检索结果
        </button>
        <button
          aria-pressed={activeView === "history"}
          className={cn(
            "h-10 border-b-2 px-1 text-xs",
            activeView === "history"
              ? "border-primary font-medium text-primary"
              : "border-transparent text-muted-foreground",
          )}
          onClick={() => setActiveView("history")}
          type="button"
        >
          检索历史
        </button>
      </div>
      {error ? (
        <p
          aria-live="assertive"
          className="border-b bg-destructive/8 px-6 py-2 text-destructive text-xs"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {warnings.length ? (
        <CollapsibleBanner
          ariaLive="polite"
          className="mx-6 my-2"
          defaultState="folded"
          dismissible={false}
          icon={<TriangleAlertIcon className="size-3.5" />}
          role="status"
          title={`部分数据源未响应 · ${warnings.length} 项`}
          tone="warning"
        >
          <ul className="space-y-1 text-muted-foreground text-xs leading-5">
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </CollapsibleBanner>
      ) : null}
      {sourceRuns.length ? (
        <div className="shrink-0 border-b bg-muted/10 px-6 py-2">
          <button
            aria-expanded={showSourceRuns}
            className="flex w-full items-center gap-2 text-left text-xs"
            onClick={() => setShowSourceRuns((value) => !value)}
            type="button"
          >
            <span className="font-medium">检索证据</span>
            <span className="text-muted-foreground">
              {sourceRuns.filter((run) => run.status === "success").length}/
              {sourceRuns.length} 个数据源已响应
            </span>
            <span className="ml-auto text-muted-foreground text-[10px]">
              {showSourceRuns ? "收起" : "查看每个来源的响应"}
            </span>
            <ChevronDownIcon
              className={cn(
                "size-3.5 text-muted-foreground",
                showSourceRuns && "rotate-180",
              )}
            />
          </button>
          {showSourceRuns ? (
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {sourceRuns.map((run) => (
                <div
                  className="flex min-w-0 items-start gap-2 rounded-md border bg-background px-2.5 py-2 text-[11px]"
                  key={run.source}
                >
                  {run.status === "success" ? (
                    <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                  ) : (
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{run.source}</span>
                      <span className="text-muted-foreground">
                        {run.status === "success"
                          ? `${run.resultCount} 条`
                          : "请求失败"}
                      </span>
                    </div>
                    <p
                      className="mt-1 truncate text-muted-foreground"
                      title={run.requestQuery ?? run.query}
                    >
                      {run.requestQuery ?? run.query}
                    </p>
                    {run.message ? (
                      <p
                        className="mt-1 line-clamp-2 text-amber-700 dark:text-amber-300"
                        title={run.message}
                      >
                        {run.message}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
