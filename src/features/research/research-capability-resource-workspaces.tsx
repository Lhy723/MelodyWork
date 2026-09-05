import { ArrowRightIcon, FolderOpenIcon, SearchIcon } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ResearchPaper } from "@/domain/research";
import { cn } from "@/lib/utils";

import type { ResearchMainKind } from "./research-main-workspace";
import { EmptyWorkflow, ProjectContext } from "./research-ui";
import { useResearchStore } from "./research-store";

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

export function KnowledgeWorkspace({
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
                reveal
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

export function ExperimentWorkspace({
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

export function SandboxWorkspace({
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
