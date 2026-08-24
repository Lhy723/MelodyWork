import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookmarkIcon,
  BlocksIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderOpenIcon,
  HistoryIcon,
  InboxIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Badge } from "@/components/ui/badge";
import {
  MotionPage,
  pageEnterTransition,
  pageExitTransition,
} from "@/components/motion/page-transition";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toUserMessage } from "@/domain/app-error";
import type {
  ResearchPaper,
  ResearchSource,
  ResearchSourceRun,
} from "@/domain/research";
import { RequestGate } from "@/domain/request-gate";
import {
  openExternalUrl,
  readMelodyConfig,
  updateMelodyConfig,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

import {
  DEFAULT_RESEARCH_SEARCH_SOURCES,
  importResearchPaper,
  RESEARCH_SEARCH_SOURCES,
  searchResearchPapers,
  verifyResearchPaper,
} from "./research-api";
import {
  buildResearchEvidenceMatrix,
  formatResearchBibtex,
  RESEARCH_MCP,
  RESEARCH_SKILLS,
  RESEARCH_TOOLS,
  useResearchCapabilityStore,
} from "./research-capability-store";
import { buildResearchQueryPlan } from "./research-query";
import { ResearchOverviewWorkspace } from "./research-overview-workspace";
import { useResearchStore } from "./research-store";

export type ResearchMainKind =
  | "overview"
  | "knowledge"
  | "library"
  | "experiments"
  | "sandbox"
  | "search"
  | "tracking"
  | "inbox"
  | "capabilities";
export type ResearchMainDetail =
  | {
      type: "paper";
      paper: ResearchPaper;
      returnTo?: { type: "tracking"; topicId: string };
    }
  | { type: "tracking"; topicId: string };
type ResultSort = "relevance" | "year" | "citations";
const EXAMPLE_RESEARCH_QUERY = "大语言模型在科研发现中的应用证据";

const FileWorkspace = lazy(() =>
  import("@/features/files/file-workspace").then(({ FileWorkspace }) => ({
    default: FileWorkspace,
  })),
);
const TerminalPanel = lazy(() =>
  import("@/features/terminal/terminal-panel").then(({ TerminalPanel }) => ({
    default: TerminalPanel,
  })),
);

function ResearchViewLayer({
  active,
  children,
  mounted,
}: {
  active: boolean;
  children: ReactNode;
  mounted: boolean;
}) {
  if (!mounted) {
    return null;
  }

  return (
    <motion.div
      animate={{
        opacity: active ? 1 : 0,
        scale: active ? 1 : 0.99,
        y: active ? 0 : 8,
      }}
      aria-hidden={!active}
      className="absolute inset-0"
      inert={!active}
      initial={false}
      style={{
        pointerEvents: active ? "auto" : "none",
        willChange: "opacity, transform",
      }}
      transition={active ? pageEnterTransition : pageExitTransition}
    >
      {children}
    </motion.div>
  );
}

function ProjectContext({ projectName }: { projectName: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 text-muted-foreground text-[11px]">
      <FolderOpenIcon className="size-3.5" />
      <span>当前项目</span>
      <span className="font-medium text-foreground">{projectName}</span>
    </div>
  );
}

function EmptyWorkflow({
  actions,
  description,
  steps,
  title,
}: {
  actions: ReactNode;
  description: string;
  steps: Array<{ description: string; title: string }>;
  title: string;
}) {
  return (
    <div className="w-full max-w-3xl border bg-muted/10 px-5 py-5 text-left">
      <h2 className="research-serif font-semibold text-lg">{title}</h2>
      <p className="mt-1 max-w-2xl text-muted-foreground text-xs leading-5">
        {description}
      </p>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {steps.map((step, index) => (
          <div className="flex gap-2.5" key={step.title}>
            <span className="grid size-6 shrink-0 place-items-center rounded-full border text-[11px] tabular-nums">
              {index + 1}
            </span>
            <div>
              <p className="font-medium text-xs">{step.title}</p>
              <p className="mt-1 text-muted-foreground text-[11px] leading-4">
                {step.description}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t pt-4">
        {actions}
      </div>
    </div>
  );
}

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
      "flex min-h-6 items-center gap-1.5 text-xs",
      disabled
        ? "cursor-not-allowed text-muted-foreground/55"
        : "text-foreground",
    )}
  >
    <input
      checked={checked}
      className="size-4 accent-primary"
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
  emptyAction,
  onCheck,
  onSelect,
  papers,
  selectedId,
}: {
  checked: Set<string>;
  emptyAction?: ReactNode;
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
          <p className="mt-3 text-muted-foreground text-xs">{emptyText}</p>
          {emptyAction ? <div className="mt-4">{emptyAction}</div> : null}
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="hidden min-w-[700px] md:block">
        <div className="grid grid-cols-[34px_minmax(320px,1fr)_72px_140px_82px_120px] border-b bg-muted/30 px-2 py-2 text-muted-foreground text-[11px]">
          <span />
          <span>论文</span>
          <span>年份</span>
          <span>来源</span>
          <span>引用</span>
          <span>核验 / 详情</span>
        </div>
        {papers.map((paper) => (
          <div
            className={cn(
              "grid grid-cols-[34px_minmax(320px,1fr)_72px_140px_82px_120px] items-start border-b px-2 text-left text-xs hover:bg-muted/30",
              selectedId === paper.id && "bg-muted/50",
            )}
            key={paper.id}
          >
            <label className="grid h-full min-h-16 min-w-6 place-items-center">
              <input
                aria-label={`选择论文：${paper.title}`}
                checked={checked.has(paper.id)}
                className="size-4 accent-primary"
                onChange={() => onCheck(paper.id)}
                type="checkbox"
              />
            </label>
            <button
              className="min-w-0 py-3 pr-3 text-left"
              onClick={() => onSelect(paper)}
              type="button"
            >
              <span className="research-serif line-clamp-2 font-medium text-[13px] leading-4">
                {paper.title}
              </span>
              {paper.doi ? (
                <span className="mt-1 block truncate text-muted-foreground text-[10px]">
                  {paper.doi}
                </span>
              ) : null}
              <span className="mt-1 block truncate text-muted-foreground text-[11px]">
                {paper.authors.join("、") || "作者未收录"}
              </span>
            </button>
            <span className="py-3 tabular-nums">{paper.year ?? "—"}</span>
            <span className="truncate py-3 pr-3" title={paper.venue}>
              {paper.venue ?? paper.sources[0]}
            </span>
            <span className="py-3 tabular-nums">
              {paper.citationCount?.toLocaleString() ?? "—"}
            </span>
            <span className="flex items-center gap-2 py-3">
              {paper.verified ? (
                <>
                  <CheckCircle2Icon className="size-3.5 text-emerald-600" />
                  <span>已核验</span>
                </>
              ) : (
                <span className="text-muted-foreground">单一来源</span>
              )}
              <ArrowRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
            </span>
          </div>
        ))}
      </div>
      <div className="divide-y md:hidden">
        {papers.map((paper) => (
          <div className="flex items-start gap-3 px-4 py-4" key={paper.id}>
            <label className="flex min-h-6 min-w-6 items-start justify-center pt-1">
              <input
                aria-label={`选择论文：${paper.title}`}
                checked={checked.has(paper.id)}
                className="size-4 accent-primary"
                onChange={() => onCheck(paper.id)}
                type="checkbox"
              />
            </label>
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => onSelect(paper)}
              type="button"
            >
              <span className="research-serif block font-medium text-sm leading-5">
                {paper.title}
              </span>
              <span className="mt-1 block line-clamp-2 text-muted-foreground text-[11px] leading-4">
                {paper.authors.join("、") || "作者未收录"}
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                <span>{paper.year ?? "年份未提供"}</span>
                <span>·</span>
                <span>{paper.venue ?? paper.sources[0] ?? "来源未提供"}</span>
                {paper.verified ? (
                  <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2Icon className="size-3" />
                    已核验
                  </span>
                ) : null}
              </span>
            </button>
            <ArrowRightIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
          </div>
        ))}
      </div>
    </>
  );
}

function PaperDetailWorkspace({
  initialPaper,
  onAskPaper,
  onBack,
  projectName,
}: {
  initialPaper: ResearchPaper;
  onAskPaper?: (paper: ResearchPaper) => void;
  onBack: () => void;
  projectName: string;
}) {
  const stored = useResearchStore((state) =>
    state.papers.find((item) => item.id === initialPaper.id),
  );
  const addPapers = useResearchStore((state) => state.addPapers);
  const paper = stored ?? initialPaper;
  const bibtexEnabled = useResearchCapabilityStore((state) =>
    state.enabledToolIds.includes("format-bibtex"),
  );
  const studyCardEnabled = useResearchCapabilityStore((state) =>
    state.enabledToolIds.includes("study-card"),
  );
  const citationAuditEnabled = useResearchCapabilityStore((state) =>
    state.enabledToolIds.includes("verify-citation"),
  );
  const [showPdf, setShowPdf] = useState(false);
  const [bibtexCopied, setBibtexCopied] = useState(false);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState<string>();

  const copyBibtex = async () => {
    if (!bibtexEnabled) return;
    const value = formatResearchBibtex(paper);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setBibtexCopied(true);
      window.setTimeout(() => setBibtexCopied(false), 1800);
    } catch {
      setBibtexCopied(false);
    }
  };

  const verifyCitation = async () => {
    if (!citationAuditEnabled || !paper.doi) return;
    setVerificationBusy(true);
    setVerificationMessage(undefined);
    try {
      const verified = await verifyResearchPaper(paper);
      addPapers([verified]);
      setVerificationMessage(
        verified.verified
          ? `已匹配 ${verified.sources.join("、")}`
          : "已返回单一来源元数据，请打开原文核对。",
      );
    } catch (reason) {
      setVerificationMessage(toUserMessage(reason, "验证失败，请稍后重试。"));
    } finally {
      setVerificationBusy(false);
    }
  };

  const evidence =
    paper.verification?.evidence ??
    paper.sources.map((source) => ({
      source,
      status: "matched" as const,
      checkedAt: paper.verification?.checkedAt ?? paper.addedAt,
      recordId: paper.id.replace(
        /^(?:doi|arxiv|pubmed|semantic-scholar):/i,
        "",
      ),
      title: paper.title,
      url: paper.url,
    }));

  return (
    <div className="flex size-full min-h-0 flex-col overflow-y-auto bg-background">
      <header className="shrink-0 border-b px-6 py-4">
        <Button
          className="-ml-2 h-7 px-2 text-xs"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
          返回上一页
        </Button>
        <ProjectContext projectName={projectName} />
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="max-w-5xl">
          <h1 className="research-serif text-3xl font-semibold leading-tight tracking-tight lg:text-4xl">
            {paper.title}
          </h1>
          <p className="mt-3 max-w-4xl text-sm text-muted-foreground leading-6">
            {paper.authors.join("、") || "作者信息未收录"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {[paper.year, paper.venue, paper.doi].filter(Boolean).join(" · ")}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2 border-y py-3">
            <Button
              onClick={() => addPapers([{ ...paper, saved: true }])}
              size="sm"
              variant={paper.saved ? "secondary" : "outline"}
            >
              <BookmarkIcon className={cn(paper.saved && "fill-current")} />
              {paper.saved ? "已收藏" : "收藏"}
            </Button>
            {paper.pdfUrl ? (
              <Button
                onClick={() => setShowPdf((value) => !value)}
                size="sm"
                variant="outline"
              >
                <FileTextIcon />
                {showPdf ? "返回摘要" : "打开 PDF"}
              </Button>
            ) : null}
            {paper.pdfUrl ? (
              <Button asChild size="sm" variant="outline">
                <a
                  download
                  href={paper.pdfUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <DownloadIcon />
                  下载 PDF
                </a>
              </Button>
            ) : null}
            <Button
              onClick={() => void openExternalUrl(paper.url)}
              size="sm"
              variant="outline"
            >
              <ExternalLinkIcon />
              打开原文
            </Button>
            {bibtexEnabled ? (
              <Button
                onClick={() => void copyBibtex()}
                size="sm"
                variant="outline"
              >
                <FileTextIcon />
                {bibtexCopied ? "BibTeX 已复制" : "复制 BibTeX"}
              </Button>
            ) : null}
            {citationAuditEnabled && paper.doi ? (
              <Button
                disabled={verificationBusy}
                onClick={() => void verifyCitation()}
                size="sm"
                variant="outline"
              >
                {verificationBusy ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <RefreshCwIcon />
                )}
                {verificationBusy ? "核验中…" : "重新核验"}
              </Button>
            ) : null}
            {onAskPaper ? (
              <Button
                disabled={!studyCardEnabled}
                onClick={() => onAskPaper(paper)}
                size="sm"
                title={
                  studyCardEnabled
                    ? undefined
                    : "请先在科研能力中启用论文研究卡片"
                }
              >
                <MessageCircleQuestionIcon />向 Melody 提问
              </Button>
            ) : null}
          </div>
        </div>
        {verificationMessage ? (
          <p
            aria-live="polite"
            className="mt-3 max-w-5xl rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            role="status"
          >
            {verificationMessage}
          </p>
        ) : null}
        {showPdf && paper.pdfUrl ? (
          <div className="mt-8 max-w-5xl border bg-muted/10 p-2">
            <iframe
              className="h-[min(72vh,760px)] w-full border bg-background"
              src={paper.pdfUrl}
              title={`${paper.title} PDF`}
            />
          </div>
        ) : (
          <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_260px]">
            <article className="max-w-3xl">
              <section className="border-b pb-7">
                <h2 className="research-serif font-semibold text-xl">摘要</h2>
                <p className="research-serif mt-4 whitespace-pre-wrap text-base text-foreground/85 leading-8">
                  {paper.abstract || "索引未提供摘要，可打开原文查看。"}
                </p>
              </section>
              <section className="pt-7">
                <h2 className="research-serif font-semibold text-xl">
                  证据导读
                </h2>
                <p className="mt-2 text-xs text-muted-foreground leading-5">
                  这里保留论文的分析结构，不把模型推断伪装成原文结论。启用论文研究卡片后，可在对话中生成带证据边界的导读。
                </p>
                <div className="mt-5 divide-y border-y">
                  {[
                    ["01", "研究问题", "从摘要与原文中确认研究目标。"],
                    [
                      "02",
                      "研究方法",
                      "在对话中提取数据、实验设置与比较基线。",
                    ],
                    ["03", "关键证据", "回到原文核对结果、指标与统计信息。"],
                    [
                      "04",
                      "局限与下一步",
                      "记录作者明确说明的限制，避免过度外推。",
                    ],
                  ].map(([number, title, description]) => (
                    <div className="flex gap-4 py-4" key={number}>
                      <span className="research-serif grid size-7 shrink-0 place-items-center rounded-full border text-xs">
                        {number}
                      </span>
                      <div>
                        <h3 className="research-serif font-semibold text-base">
                          {title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground leading-5">
                          {description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </article>
            <aside className="border-l pl-6">
              <section>
                <h2 className="research-serif font-semibold text-base">
                  来源与核验
                </h2>
                <dl className="mt-4 grid gap-3 text-xs">
                  <div>
                    <dt className="text-muted-foreground">来源</dt>
                    <dd className="mt-1">
                      {paper.sources.join("、") || "未提供"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">发表年份</dt>
                    <dd className="mt-1">{paper.year ?? "未提供"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">期刊 / 会议</dt>
                    <dd className="mt-1">{paper.venue || "未提供"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">DOI</dt>
                    <dd className="mt-1 break-all text-primary">
                      {paper.doi || "未提供"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">引用次数</dt>
                    <dd className="mt-1">
                      {paper.citationCount?.toLocaleString() ?? "未提供"}
                    </dd>
                  </div>
                </dl>
              </section>
              <section className="mt-8 border-t pt-6">
                <h2 className="research-serif font-semibold text-base">
                  核验状态
                </h2>
                <div
                  className={cn(
                    "mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
                    paper.verified
                      ? "border-emerald-200 bg-emerald-500/6 text-emerald-800 dark:border-emerald-900 dark:text-emerald-200"
                      : "border-amber-200 bg-amber-500/6 text-amber-800 dark:border-amber-900 dark:text-amber-200",
                  )}
                >
                  {paper.verified ? (
                    <CheckCircle2Icon className="size-3.5" />
                  ) : (
                    <TriangleAlertIcon className="size-3.5" />
                  )}
                  {paper.verified
                    ? "已通过多源元信息核验"
                    : "单一来源，需打开原文核对"}
                </div>
                <div className="mt-4 space-y-2">
                  {evidence.map((item) => (
                    <div
                      className="border-b pb-2 text-[11px]"
                      key={`${item.source}:${item.recordId ?? item.title}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{item.source}</span>
                        <span className="text-emerald-700 dark:text-emerald-300">
                          已匹配
                        </span>
                      </div>
                      <p
                        className="mt-1 truncate text-muted-foreground"
                        title={item.recordId}
                      >
                        {item.recordId || "记录 ID 未提供"}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}

function SearchWorkspace({
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
    if (!inbox || inboxCreatedAt === undefined) {
      return;
    }
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
      if (searchGateRef.current.isCurrent(requestToken)) {
        setLoading(false);
      }
    }
  };
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
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
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
                void runSearch();
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
            <Button
              className="sm:ml-auto"
              disabled={
                !searchToolEnabled ||
                !query.trim() ||
                loading ||
                enabledSources.size === 0
              }
              onClick={() => void runSearch()}
              size="sm"
            >
              {loading ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <SearchIcon />
              )}
              {loading ? "正在检索…" : "检索"}
            </Button>
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
        <p className="border-b bg-amber-500/8 px-6 py-2 text-amber-800 text-xs dark:text-amber-200">
          {warnings.join("；")}
        </p>
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

function InboxWorkspace({
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
            <Button onClick={clearResearchInbox} size="sm" variant="ghost">
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
    </div>
  );
}

function TrackingWorkspace({
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
            <label className="grid gap-1.5">
              <span className="font-medium text-xs">主题名称</span>
              <Input
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：多模态 RAG 可复现性"
                value={title}
              />
              <span className="text-muted-foreground text-[10px] leading-4">
                这是侧栏和主题列表里显示的标题，方便你识别方向。
              </span>
            </label>
            <label className="grid gap-1.5">
              <span className="font-medium text-xs">检索词</span>
              <Input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="例如：multimodal RAG evaluation reproducibility benchmark"
                value={query}
              />
              <span className="text-muted-foreground text-[10px] leading-4">
                刷新时会把这段关键词发送给已启用的数据源。
              </span>
            </label>
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

function TrackingDetailWorkspace({
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
    try {
      const result = await searchResearchPapers(topic.query);
      if (!refreshGateRef.current.isCurrent(requestToken)) return;
      refreshTrackingTopic(topic.id, result.papers);
    } catch (reason) {
      if (!refreshGateRef.current.isCurrent(requestToken)) return;
      setError(toUserMessage(reason));
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
            <Button
              disabled={refreshing}
              onClick={() => void refresh()}
              size="sm"
            >
              <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
              {refreshing ? "正在刷新…" : "刷新进展"}
            </Button>
            <Button
              aria-label="删除追踪主题"
              onClick={() => {
                removeTrackingTopic(topic.id);
                onBack();
              }}
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
    </div>
  );
}

function LibraryWorkspace({
  onOpenPaper,
  onNavigate,
  projectName,
}: {
  onOpenPaper: (paper: ResearchPaper) => void;
  onNavigate: (kind: ResearchMainKind) => void;
  projectName: string;
}) {
  const papers = useResearchStore((state) => state.papers);
  const addPapers = useResearchStore((state) => state.addPapers);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "saved" | "verified">("all");
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
      onOpenPaper(paper);
      setCandidate("");
      setImportOpen(false);
    } catch (reason) {
      setError(toUserMessage(reason));
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
        <ProjectContext projectName={projectName} />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex h-8 min-w-0 w-full max-w-xl flex-1 items-center rounded-md border px-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 sm:w-auto">
            <SearchIcon className="size-3.5 text-muted-foreground" />
            <input
              aria-label="检索文献库"
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
              {value === "all"
                ? "全部文献"
                : value === "saved"
                  ? "已保存"
                  : "已核验"}
            </Button>
          ))}
          <Button
            className="sm:ml-auto"
            onClick={() => setImportOpen((value) => !value)}
            size="sm"
            variant="outline"
          >
            <PlusIcon />
            导入文献
          </Button>
        </div>
        {importOpen ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              aria-label="导入文献地址或 DOI"
              className="min-w-0 flex-1"
              onChange={(event) => setCandidate(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && candidate.trim() && !importing)
                  void runImport();
              }}
              placeholder="arXiv 链接、doi.org 链接或 DOI"
              value={candidate}
            />
            <Button
              disabled={!candidate.trim() || importing}
              onClick={() => void runImport()}
              size="sm"
            >
              {importing ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <PlusIcon />
              )}
              {importing ? "正在查询…" : "确认导入"}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p
            aria-live="assertive"
            className="mt-2 text-destructive text-xs"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </header>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1">
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
            emptyAction={
              <EmptyWorkflow
                actions={
                  <>
                    <Button onClick={() => setImportOpen(true)} size="sm">
                      <PlusIcon />
                      导入第一篇论文
                    </Button>
                    <Button
                      onClick={() => onNavigate("search")}
                      size="sm"
                      variant="outline"
                    >
                      <SearchIcon />
                      从自然语言检索开始
                    </Button>
                  </>
                }
                description="粘贴 DOI 或 arXiv 链接即可拉取真实元信息；之后可以打开原文、收藏，并在知识资产中继续整理。"
                steps={[
                  {
                    title: "粘贴链接",
                    description: "支持 DOI、doi.org 或 arXiv。",
                  },
                  {
                    title: "查看详情",
                    description: "读取摘要、作者、来源和 PDF。",
                  },
                  {
                    title: "加入知识资产",
                    description: "收藏后即可形成项目阅读脉络。",
                  },
                ]}
                title="导入或发现第一篇文献"
              />
            }
            onCheck={(id) =>
              setChecked((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onSelect={onOpenPaper}
            papers={visible}
          />
        </section>
      </div>
    </div>
  );
}

function KnowledgeWorkspace({
  onOpenPaper,
  onNavigate,
  projectName,
}: {
  onOpenPaper: (paper: ResearchPaper) => void;
  onNavigate: (kind: ResearchMainKind) => void;
  projectName: string;
}) {
  const papers = useResearchStore((state) => state.papers);
  const saved = useMemo(() => papers.filter((paper) => paper.saved), [papers]);
  const [venue, setVenue] = useState("all");
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
        <ProjectContext projectName={projectName} />
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="research-knowledge-venues w-72 shrink-0 overflow-y-auto border-r">
          <div className="flex h-10 items-center border-b px-3 font-medium text-xs">
            出版来源
          </div>
          <button
            className={cn(
              "flex w-full items-center px-3 py-2.5 text-xs hover:bg-muted/40",
              venue === "all" && "bg-muted/60",
            )}
            onClick={() => setVenue("all")}
            type="button"
          >
            <span className="flex-1 text-left">全部收藏</span>
            <span className="text-muted-foreground">{saved.length}</span>
          </button>
          {venues.map(([name, count]) => (
            <button
              className={cn(
                "flex w-full items-center border-t px-3 py-2.5 text-xs hover:bg-muted/40",
                venue === name && "bg-muted/60",
              )}
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
            <span className="font-medium">
              {venue === "all" ? "全部收藏" : venue}
            </span>
            <span className="ml-2 text-muted-foreground">
              {visible.length} 篇
            </span>
          </div>
          {visible.length ? (
            <div className="divide-y">
              {visible.map((paper) => (
                <button
                  className="block w-full px-5 py-4 text-left hover:bg-muted/30"
                  key={paper.id}
                  onClick={() => onOpenPaper(paper)}
                  type="button"
                >
                  <h2 className="research-serif text-base font-semibold leading-5">
                    {paper.title}
                  </h2>
                  <p className="mt-1 text-muted-foreground text-xs">
                    {paper.authors.join(" · ") || "作者未收录"}
                  </p>
                  <p className="mt-2 line-clamp-2 max-w-3xl research-serif text-sm text-muted-foreground leading-5">
                    {paper.abstract || "索引未提供摘要。"}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex min-h-full items-start justify-center p-6 pt-12">
              <EmptyWorkflow
                actions={
                  <>
                    <Button onClick={() => onNavigate("search")} size="sm">
                      <SearchIcon />
                      从检索结果生成知识资产
                      <ArrowRightIcon />
                    </Button>
                    <Button
                      onClick={() => onNavigate("library")}
                      size="sm"
                      variant="outline"
                    >
                      <FolderOpenIcon />
                      从文献库收藏
                    </Button>
                  </>
                }
                description="这里不会自动塞入无法追溯的示例论文。先检索真实来源，再用“保存为知识资产”收藏论文，摘要与来源记录会保留在当前项目。"
                steps={[
                  {
                    title: "提出问题",
                    description: "用自然语言描述你的研究方向。",
                  },
                  {
                    title: "选择论文",
                    description: "打开结果详情，核对来源与原文。",
                  },
                  {
                    title: "生成资产",
                    description: "保存后在这里按出版来源整理。",
                  },
                ]}
                title="建立第一份知识资产"
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ExperimentWorkspace({
  projectName,
  root,
}: {
  projectName: string;
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
          <ProjectContext projectName={projectName} />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="grid size-full place-items-center text-muted-foreground text-xs">
              正在加载实验资源…
            </div>
          }
        >
          <FileWorkspace embedded root={root} />
        </Suspense>
      </div>
    </div>
  );
}

function SandboxWorkspace({
  cwd,
  projectName,
}: {
  cwd: string;
  projectName: string;
}) {
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-end border-b px-6 py-4">
        <div>
          <h1 className="research-serif font-semibold text-2xl">研究沙盒</h1>
          <p className="mt-1 text-muted-foreground text-xs">
            在当前工作区中运行分析、复现实验并检查输出。
          </p>
          <ProjectContext projectName={projectName} />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="grid size-full place-items-center text-muted-foreground text-xs">
              正在加载研究沙盒…
            </div>
          }
        >
          <TerminalPanel cwd={cwd} embedded />
        </Suspense>
      </div>
    </div>
  );
}

function CapabilityCard({
  category,
  checked,
  description,
  onCheckedChange,
  title,
  trigger,
}: {
  category?: string;
  checked: boolean;
  description: string;
  onCheckedChange: (checked: boolean) => void;
  title: string;
  trigger?: string;
}) {
  return (
    <article className="flex items-start gap-3 border bg-background/70 p-4 transition-colors hover:bg-muted/20">
      <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/30">
        <WandSparklesIcon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="research-serif font-semibold text-sm">{title}</h3>
          {category ? <Badge variant="outline">{category}</Badge> : null}
        </div>
        <p className="mt-1 text-muted-foreground text-xs leading-5">
          {description}
        </p>
        {trigger ? (
          <p className="mt-2 text-muted-foreground text-[11px]">
            适用：{trigger}
          </p>
        ) : null}
      </div>
      <Switch
        aria-label={`${checked ? "停用" : "启用"}${title}`}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </article>
  );
}

function CapabilitiesWorkspace({
  cwd,
  onNavigate,
  projectName,
}: {
  cwd: string;
  onNavigate: (kind: ResearchMainKind) => void;
  projectName: string;
}) {
  const enabledSkillIds = useResearchCapabilityStore(
    (state) => state.enabledSkillIds,
  );
  const enabledToolIds = useResearchCapabilityStore(
    (state) => state.enabledToolIds,
  );
  const mcpEnabled = useResearchCapabilityStore((state) => state.mcpEnabled);
  const setSkillEnabled = useResearchCapabilityStore(
    (state) => state.setSkillEnabled,
  );
  const setToolEnabled = useResearchCapabilityStore(
    (state) => state.setToolEnabled,
  );
  const setMcpEnabled = useResearchCapabilityStore(
    (state) => state.setMcpEnabled,
  );
  const reset = useResearchCapabilityStore((state) => state.reset);
  const [mcpConfigured, setMcpConfigured] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string>();
  const [capabilityView, setCapabilityView] = useState<
    "skills" | "tools" | "mcp"
  >("skills");

  const handleCapabilityTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    value: "skills" | "tools" | "mcp",
  ) => {
    const values = ["skills", "tools", "mcp"] as const;
    const index = values.indexOf(value);
    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % values.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + values.length) % values.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = values.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextValue = values[nextIndex];
    setCapabilityView(nextValue);
    requestAnimationFrame(() =>
      document
        .getElementById(`research-capabilities-tab-${nextValue}`)
        ?.focus(),
    );
  };

  useEffect(() => {
    let cancelled = false;
    void readMelodyConfig("project", cwd)
      .then((document) => {
        if (cancelled) return;
        const servers = document.values.mcp_servers;
        const configured =
          Boolean(servers) &&
          typeof servers === "object" &&
          !Array.isArray(servers) &&
          Boolean((servers as Record<string, unknown>)[RESEARCH_MCP.id]);
        setMcpConfigured(configured);
        if (configured) setMcpEnabled(true);
      })
      .catch(() => {
        if (!cancelled) setMcpConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, setMcpEnabled]);

  const toggleMcp = async (enabled: boolean) => {
    setMcpBusy(true);
    setMcpError(undefined);
    try {
      await updateMelodyConfig("project", cwd, [
        {
          path: ["mcp_servers", RESEARCH_MCP.id],
          value: enabled
            ? {
                command: "node",
                args: [RESEARCH_MCP.relativeCommand],
              }
            : null,
        },
      ]);
      setMcpConfigured(enabled);
      setMcpEnabled(enabled);
    } catch (reason) {
      setMcpError(toUserMessage(reason));
    } finally {
      setMcpBusy(false);
    }
  };

  return (
    <div className="flex size-full min-h-0 flex-col overflow-y-auto bg-background">
      <header className="shrink-0 border-b px-6 py-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <BlocksIcon className="size-5 text-muted-foreground" />
              <h1 className="research-serif font-semibold text-2xl">
                科研能力
              </h1>
            </div>
            <p className="mt-1 max-w-2xl text-muted-foreground text-xs leading-5">
              Research 内置一套证据优先的技能、工具和本地
              MCP。启用后会参与论文检索、导读、核验和对话，不需要在每次任务里重新说明工作方法。
            </p>
            <ProjectContext projectName={projectName} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline">{enabledSkillIds.length} 项技能</Badge>
            <Badge variant="outline">{enabledToolIds.length} 个工具</Badge>
            <Button onClick={reset} size="sm" variant="ghost">
              恢复默认
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => onNavigate("search")} size="sm">
            <SearchIcon />
            开始自然语言检索
            <ArrowRightIcon />
          </Button>
          <Button
            onClick={() => onNavigate("inbox")}
            size="sm"
            variant="outline"
          >
            <InboxIcon />
            打开研究收件箱
          </Button>
        </div>
        <nav
          aria-label="科研能力分组"
          className="mt-5 flex max-w-2xl items-end gap-5 border-b"
          role="tablist"
        >
          {(
            [
              ["skills", "内置技能", `${enabledSkillIds.length} 项`],
              ["tools", "可调用工具", `${enabledToolIds.length} 项`],
              ["mcp", "本地 MCP", mcpEnabled ? "已启用" : "可选"],
            ] as const
          ).map(([value, label, count]) => (
            <button
              aria-controls={`research-capabilities-panel-${value}`}
              aria-selected={capabilityView === value}
              className={cn(
                "border-b-2 px-1 pb-2 text-left text-xs",
                capabilityView === value
                  ? "border-primary font-medium text-primary"
                  : "border-transparent text-muted-foreground",
              )}
              id={`research-capabilities-tab-${value}`}
              key={value}
              onClick={() => setCapabilityView(value)}
              onKeyDown={(event) => handleCapabilityTabKeyDown(event, value)}
              role="tab"
              tabIndex={capabilityView === value ? 0 : -1}
              type="button"
            >
              <span className="block">{label}</span>
              <span className="mt-1 block text-[10px] font-normal text-muted-foreground">
                {count}
              </span>
            </button>
          ))}
        </nav>
      </header>

      <div className="mx-auto w-full max-w-6xl space-y-8 p-6">
        {capabilityView === "skills" ? (
          <section
            aria-labelledby="research-capabilities-tab-skills"
            id="research-capabilities-panel-skills"
            role="tabpanel"
            tabIndex={0}
          >
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h2 className="research-serif font-semibold text-lg">
                  内置 Research 技能
                </h2>
                <p className="mt-1 text-muted-foreground text-xs">
                  每项技能都带有触发场景、输出边界和可复用的工作流；停用后不会写入对话上下文。
                </p>
              </div>
              <Badge variant="secondary">本地插件 · melody-research</Badge>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {RESEARCH_SKILLS.map((skill) => (
                <CapabilityCard
                  category={skill.category}
                  checked={enabledSkillIds.includes(skill.id)}
                  description={skill.description}
                  key={skill.id}
                  onCheckedChange={(checked) =>
                    setSkillEnabled(skill.id, checked)
                  }
                  title={`${skill.title} · ${skill.englishTitle}`}
                  trigger={skill.trigger}
                />
              ))}
            </div>
          </section>
        ) : null}

        {capabilityView === "tools" ? (
          <section
            aria-labelledby="research-capabilities-tab-tools"
            id="research-capabilities-panel-tools"
            role="tabpanel"
            tabIndex={0}
          >
            <div className="mb-3">
              <h2 className="research-serif font-semibold text-lg">
                可调用工具
              </h2>
              <p className="mt-1 text-muted-foreground text-xs">
                工具对应真实的 Research 页面或本地 MCP
                方法；开关只控制它们是否进入 Research 对话的可用能力集合。
              </p>
            </div>
            <div className="divide-y border">
              {RESEARCH_TOOLS.map((tool) => (
                <article
                  className="flex items-start gap-3 bg-background/70 p-4"
                  key={tool.id}
                >
                  <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/30">
                    <CheckCircle2Icon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="research-serif font-semibold text-sm">
                        {tool.title}
                      </h3>
                      <Badge variant="outline">{tool.availability}</Badge>
                    </div>
                    <p className="mt-1 text-muted-foreground text-xs leading-5">
                      {tool.description}
                    </p>
                    <p className="mt-1 text-muted-foreground text-[11px]">
                      {tool.detail}
                    </p>
                  </div>
                  <Switch
                    aria-label={`${enabledToolIds.includes(tool.id) ? "停用" : "启用"}${tool.title}`}
                    checked={enabledToolIds.includes(tool.id)}
                    onCheckedChange={(checked) =>
                      setToolEnabled(tool.id, checked)
                    }
                  />
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {capabilityView === "mcp" ? (
          <section
            aria-labelledby="research-capabilities-tab-mcp"
            id="research-capabilities-panel-mcp"
            role="tabpanel"
            tabIndex={0}
          >
            <div className="mb-3">
              <h2 className="research-serif font-semibold text-lg">
                本地 MCP 插件
              </h2>
              <p className="mt-1 text-muted-foreground text-xs">
                MCP 按照 tools、resources、prompts
                分开暴露能力，方便在本地对话代理或其他兼容客户端复用。
              </p>
            </div>
            <article className="border bg-muted/10 p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
                  <BlocksIcon className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="research-serif font-semibold text-sm">
                      {RESEARCH_MCP.title}
                    </h3>
                    <Badge variant={mcpConfigured ? "outline" : "secondary"}>
                      {mcpConfigured ? "已写入当前项目" : "可选启用"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground text-xs leading-5">
                    {RESEARCH_MCP.description}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {RESEARCH_MCP.sources.map((source) => (
                      <Badge key={source} variant="secondary">
                        source · {source}
                      </Badge>
                    ))}
                    {RESEARCH_MCP.tools.map((tool) => (
                      <Badge key={tool} variant="outline">
                        tool · {tool}
                      </Badge>
                    ))}
                    {RESEARCH_MCP.resources.map((resource) => (
                      <Badge key={resource} variant="outline">
                        resource · {resource}
                      </Badge>
                    ))}
                    {RESEARCH_MCP.prompts.map((prompt) => (
                      <Badge key={prompt} variant="outline">
                        prompt · {prompt}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
                    node {RESEARCH_MCP.relativeCommand}
                  </p>
                  <p className="mt-2 text-muted-foreground text-[11px] leading-4">
                    启用会更新当前项目的 <code>.melody/config.toml</code>
                    ；已打开的会话不会自动重载，下一次新建或重新载入会话后生效。
                  </p>
                  {mcpError ? (
                    <p
                      aria-live="assertive"
                      className="mt-2 flex items-center gap-1.5 text-destructive text-xs"
                      role="alert"
                    >
                      <TriangleAlertIcon className="size-3.5" />
                      {mcpError}
                    </p>
                  ) : null}
                </div>
                <Switch
                  aria-label={`${mcpEnabled ? "停用" : "启用"} Melody Research MCP`}
                  checked={mcpEnabled}
                  disabled={mcpBusy}
                  onCheckedChange={(checked) => void toggleMcp(checked)}
                />
              </div>
            </article>
          </section>
        ) : null}

        <p className="border-t pt-4 text-muted-foreground text-[11px] leading-5">
          这些技能借鉴证据矩阵、系统综述和高影响力期刊常见的严谨写作流程；它们不是任何期刊的官方插件，也不会替代原文、同行评审或人工核验。
        </p>
      </div>
    </div>
  );
}

export function ResearchMainWorkspace({
  cwd,
  detail,
  kind,
  onNavigate,
  onAskPaper,
  onCloseDetail,
  onOpenPaper,
  onOpenTrackingTopic,
  projectId,
  projectName,
  root,
}: {
  cwd: string;
  detail?: ResearchMainDetail;
  kind: ResearchMainKind;
  onNavigate: (kind: ResearchMainKind) => void;
  onAskPaper?: (paper: ResearchPaper) => void;
  onCloseDetail: () => void;
  onOpenPaper: (paper: ResearchPaper) => void;
  onOpenTrackingTopic: (topicId: string) => void;
  projectId?: string;
  projectName: string;
  root: string;
}) {
  const setActiveProject = useResearchStore((state) => state.setActiveProject);
  const [visitedKinds, setVisitedKinds] = useState<Set<ResearchMainKind>>(
    () => new Set([kind]),
  );

  useEffect(() => {
    setActiveProject(projectId);
  }, [projectId, setActiveProject]);

  useEffect(() => {
    setVisitedKinds((current) => {
      if (current.has(kind)) return current;
      return new Set(current).add(kind);
    });
  }, [kind]);

  const detailActive = Boolean(detail);
  const renderedKinds = visitedKinds.has(kind)
    ? visitedKinds
    : new Set(visitedKinds).add(kind);

  return (
    <div className="relative size-full min-h-0">
      <ResearchViewLayer
        active={kind === "overview" && !detailActive}
        mounted={renderedKinds.has("overview")}
      >
        <ResearchOverviewWorkspace
          key={`overview:${projectId ?? "unscoped"}`}
          onNavigate={onNavigate}
          onOpenPaper={onOpenPaper}
          projectName={projectName}
        />
      </ResearchViewLayer>
      <ResearchViewLayer
        active={kind === "search" && !detailActive}
        mounted={renderedKinds.has("search")}
      >
        <SearchWorkspace
          key={`search:${projectId ?? "unscoped"}`}
          onOpenPaper={onOpenPaper}
          onNavigate={onNavigate}
          projectName={projectName}
        />
      </ResearchViewLayer>
      <ResearchViewLayer
        active={kind === "tracking" && !detailActive}
        mounted={renderedKinds.has("tracking")}
      >
        <TrackingWorkspace
          key={`tracking:${projectId ?? "unscoped"}`}
          onOpenTopic={onOpenTrackingTopic}
          onNavigate={onNavigate}
          projectName={projectName}
        />
      </ResearchViewLayer>
      <ResearchViewLayer
        active={kind === "inbox" && !detailActive}
        mounted={renderedKinds.has("inbox")}
      >
        <InboxWorkspace
          key={`inbox:${projectId ?? "unscoped"}`}
          onAskPaper={onAskPaper}
          onOpenPaper={onOpenPaper}
          onNavigate={onNavigate}
          projectName={projectName}
        />
      </ResearchViewLayer>

      <AnimatePresence initial={false} mode="wait">
        {kind === "knowledge" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`knowledge:${projectId ?? "unscoped"}`}
          >
            <KnowledgeWorkspace
              onOpenPaper={onOpenPaper}
              onNavigate={onNavigate}
              projectName={projectName}
            />
          </MotionPage>
        ) : null}
        {kind === "library" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`library:${projectId ?? "unscoped"}`}
          >
            <LibraryWorkspace
              onOpenPaper={onOpenPaper}
              onNavigate={onNavigate}
              projectName={projectName}
            />
          </MotionPage>
        ) : null}
        {kind === "experiments" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`experiments:${projectId ?? "unscoped"}`}
          >
            <ExperimentWorkspace projectName={projectName} root={root} />
          </MotionPage>
        ) : null}
        {kind === "sandbox" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`sandbox:${projectId ?? "unscoped"}`}
          >
            <SandboxWorkspace cwd={cwd} projectName={projectName} />
          </MotionPage>
        ) : null}
        {kind === "capabilities" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`capabilities:${projectId ?? "unscoped"}`}
          >
            <CapabilitiesWorkspace
              cwd={cwd}
              onNavigate={onNavigate}
              projectName={projectName}
            />
          </MotionPage>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false} mode="wait">
        {detail?.type === "paper" ? (
          <MotionPage
            className="absolute inset-0 z-20"
            key={`paper:${detail.paper.id}`}
          >
            <PaperDetailWorkspace
              initialPaper={detail.paper}
              onAskPaper={onAskPaper}
              onBack={onCloseDetail}
              projectName={projectName}
            />
          </MotionPage>
        ) : detail?.type === "tracking" ? (
          <MotionPage
            className="absolute inset-0 z-20"
            key={`tracking-detail:${detail.topicId}`}
          >
            <TrackingDetailWorkspace
              onBack={onCloseDetail}
              onOpenPaper={onOpenPaper}
              projectName={projectName}
              topicId={detail.topicId}
            />
          </MotionPage>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
