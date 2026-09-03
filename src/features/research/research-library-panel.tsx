import {
  BookmarkIcon,
  ImportIcon,
  LibraryIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { MOTION_EASE } from "@/components/motion/page-transition";
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
import { cn } from "@/lib/utils";

import { searchResearchPapers } from "./research-api";
import { ImportPaperDialog } from "./research-import-dialog";
import { PaperDetail, PaperList } from "./research-paper-ui";
import { useResearchStore } from "./research-store";

export function LibraryPanel({ searchMode }: { searchMode: boolean }) {
  const liveActivity = useGlobalLiveActivity();
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
  const [pendingDeletePaper, setPendingDeletePaper] = useState<ResearchPaper>();
  const searchGateRef = useRef(new RequestGate());
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const visiblePapers = searchMode ? results : papers;
  const selected = visiblePapers.find((paper) => paper.id === selectedId);
  const selectedInLibrary = papers.find((paper) => paper.id === selectedId);

  const runSearch = async (nextQuery = query) => {
    const normalized = nextQuery.trim();
    if (!normalized) return;
    const requestToken = searchGateRef.current.begin();
    setLoading(true);
    setError(undefined);
    setWarnings([]);
    liveActivity.start({
      detail: "正在查询文献数据源…",
      progress: 0,
      title: "检索文献",
    });
    try {
      const response = await searchResearchPapers(
        normalized,
        undefined,
        (progress) => {
          if (!searchGateRef.current.isCurrent(requestToken)) return;
          const sourceDetail =
            progress.status === "running"
              ? `正在查询 ${progress.source}…`
              : progress.status === "success"
                ? `${progress.source} 返回 ${progress.resultCount ?? 0} 条`
                : `${progress.source} 查询失败`;
          liveActivity.update({
            detail: `${sourceDetail} · ${progress.completed}/${progress.total}`,
            progress: progress.completed / progress.total,
            title: "检索文献",
          });
        },
      );
      if (!searchGateRef.current.isCurrent(requestToken)) return;
      setResults(response.papers);
      setWarnings(response.warnings);
      setSelectedId(response.papers[0]?.id);
      liveActivity.succeed({
        detail: `找到 ${response.papers.length} 篇文献${
          response.warnings.length
            ? `，${response.warnings.length} 个数据源异常`
            : ""
        }。`,
        title: "文献检索完成",
      });
    } catch (reason) {
      if (!searchGateRef.current.isCurrent(requestToken)) return;
      const message = toUserMessage(reason);
      setError(message);
      setResults([]);
      liveActivity.fail(
        { detail: message, title: "文献检索失败" },
        {
          label: "重试",
          onClick: () => {
            void runSearch(normalized).catch(() => undefined);
          },
        },
      );
      throw reason;
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
                    searchButtonRef.current?.click();
                  }
                }}
                placeholder="搜索 Crossref、OpenAlex、arXiv、Semantic Scholar 与 PubMed"
                value={query}
              />
            </div>
            <LoadingButton
              disabled={!query.trim()}
              errorLabel="重试"
              icon={<SearchIcon />}
              onAction={runSearch}
              pendingLabel="正在检索…"
              ref={searchButtonRef}
              size="sm"
              successLabel="检索完成"
            >
              检索
            </LoadingButton>
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
                onDelete={() => setPendingDeletePaper(selected)}
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
      <Dialog
        onOpenChange={(open) => {
          if (!open) setPendingDeletePaper(undefined);
        }}
        open={Boolean(pendingDeletePaper)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从文献库删除？</DialogTitle>
            <DialogDescription>
              “{pendingDeletePaper?.title ?? ""}
              ”会从当前项目的文献库移除，原文链接不会受到影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <HoldToConfirm
              onConfirm={() => {
                if (pendingDeletePaper) {
                  removePaper(pendingDeletePaper.id);
                  setPendingDeletePaper(undefined);
                  setSelectedId(undefined);
                }
              }}
              variant="destructive"
            >
              删除论文
            </HoldToConfirm>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
