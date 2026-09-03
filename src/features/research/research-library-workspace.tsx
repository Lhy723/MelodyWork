import { BookmarkIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useGlobalLiveActivity } from "@/components/interior/live-activity";
import { LoadingButton } from "@/components/interior/loading-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toUserMessage } from "@/domain/app-error";
import type { ResearchPaper } from "@/domain/research";

import { importResearchPaper } from "./research-api";
import type { ResearchMainKind } from "./research-main-workspace";
import { useResearchStore } from "./research-store";
import { EmptyWorkflow, ProjectContext, ResultTable } from "./research-ui";

export function LibraryWorkspace({
  onOpenPaper,
  onNavigate,
  projectName,
}: {
  onOpenPaper: (paper: ResearchPaper) => void;
  onNavigate: (kind: ResearchMainKind) => void;
  projectName: string;
}) {
  const liveActivity = useGlobalLiveActivity();
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
  const runImport = async (nextCandidate = candidate) => {
    const normalized = nextCandidate.trim();
    if (!normalized) return;
    setImporting(true);
    setError(undefined);
    liveActivity.start({
      detail: "正在查询学术索引…",
      title: "导入论文",
    });
    try {
      const paper = await importResearchPaper(normalized);
      addPapers([paper]);
      onOpenPaper(paper);
      setCandidate("");
      setImportOpen(false);
      liveActivity.succeed({
        detail: `已导入《${paper.title}》。`,
        title: "论文导入完成",
      });
    } catch (reason) {
      const message = toUserMessage(reason);
      setError(message);
      liveActivity.fail(
        { detail: message, title: "论文导入失败" },
        {
          label: "重试",
          onClick: () => {
            void runImport(normalized).catch(() => undefined);
          },
        },
      );
      throw reason;
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
                  void runImport().catch(() => undefined);
              }}
              placeholder="arXiv 链接、doi.org 链接或 DOI"
              value={candidate}
            />
            <LoadingButton
              disabled={!candidate.trim() || importing}
              errorLabel="重试"
              icon={<PlusIcon />}
              onAction={runImport}
              pendingLabel="正在查询…"
              size="sm"
              successLabel="已导入"
            >
              确认导入
            </LoadingButton>
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
