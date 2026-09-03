import {
  ArrowLeftIcon,
  BookmarkIcon,
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  MessageCircleQuestionIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { CopyButton } from "@/components/interior/copy-button";
import { useGlobalLiveActivity } from "@/components/interior/live-activity";
import { LoadingButton } from "@/components/interior/loading-button";
import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/domain/app-error";
import type { ResearchPaper } from "@/domain/research";
import { openExternalUrl } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

import {
  formatResearchBibtex,
  useResearchCapabilityStore,
} from "./research-capability-store";
import { verifyResearchPaper } from "./research-api";
import { useResearchStore } from "./research-store";
import { ProjectContext } from "./research-ui";

export function PaperDetailWorkspace({
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
  const liveActivity = useGlobalLiveActivity();
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
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState<string>();

  const verifyCitation = async () => {
    if (!citationAuditEnabled || !paper.doi) return;
    setVerificationBusy(true);
    setVerificationMessage(undefined);
    liveActivity.start({
      detail: "正在从 Crossref 和 OpenAlex 获取元数据…",
      title: "核验论文引用",
    });
    try {
      const verified = await verifyResearchPaper(paper);
      addPapers([verified]);
      const message = verified.verified
        ? `已匹配 ${verified.sources.join("、")}`
        : "已返回单一来源元数据，请打开原文核对。";
      setVerificationMessage(message);
      liveActivity.succeed({ detail: message, title: "论文引用核验完成" });
    } catch (reason) {
      const message = toUserMessage(reason, "验证失败，请稍后重试。");
      setVerificationMessage(message);
      liveActivity.fail(
        { detail: message, title: "论文引用核验失败" },
        {
          label: "重试",
          onClick: () => {
            void verifyCitation().catch(() => undefined);
          },
        },
      );
      throw reason;
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
              <CopyButton
                className="h-7 rounded-lg border-input bg-background px-2.5 text-[0.8rem] dark:border-input dark:bg-input/30"
                copiedLabel="BibTeX 已复制"
                errorLabel="复制失败"
                label="复制 BibTeX"
                value={() => formatResearchBibtex(paper)}
              >
                <FileTextIcon />
              </CopyButton>
            ) : null}
            {citationAuditEnabled && paper.doi ? (
              <LoadingButton
                disabled={verificationBusy}
                errorLabel="重试"
                icon={<RefreshCwIcon />}
                onAction={verifyCitation}
                pendingLabel="核验中…"
                size="sm"
                successLabel="已核验"
                variant="outline"
              >
                重新核验
              </LoadingButton>
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
