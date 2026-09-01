import {
  ArrowRightIcon,
  CheckCircle2Icon,
  FolderOpenIcon,
  SearchIcon,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import {
  pageEnterTransition,
  pageExitTransition,
} from "@/components/motion/page-transition";
import type { ResearchPaper } from "@/domain/research";
import { cn } from "@/lib/utils";

export function ResearchViewLayer({
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

export function ProjectContext({ projectName }: { projectName: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 text-muted-foreground text-[11px]">
      <FolderOpenIcon className="size-3.5" />
      <span>当前项目</span>
      <span className="font-medium text-foreground">{projectName}</span>
    </div>
  );
}

export function EmptyWorkflow({
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

export const SourceToggle = ({
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

export function ResultTable({
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
