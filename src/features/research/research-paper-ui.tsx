import {
  BookmarkIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileTextIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ResearchPaper } from "@/domain/research";
import { openExternalUrl } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

export function PaperMetadata({ paper }: { paper: ResearchPaper }) {
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

export function PaperList({
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

export function PaperDetail({
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
