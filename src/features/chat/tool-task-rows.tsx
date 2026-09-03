import {
  CheckIcon,
  ChevronRightIcon,
  CircleXIcon,
  LoaderCircleIcon,
  PencilIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { CopyButton } from "@/components/interior/copy-button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import type { AgentToolFileChange } from "@/domain/acp";
import type { ToolTimelineEntry } from "@/domain/timeline-groups";
import { cn } from "@/lib/utils";

import { visibleDiffLines } from "./tool-diff";
import {
  activityLabel,
  displayPath,
  isRunning,
  operationIcon,
  shortPath,
} from "./tool-task-utils";

export function DiffCard({
  change,
  label,
}: {
  change: AgentToolFileChange;
  label: string;
}) {
  const lines = useMemo(() => visibleDiffLines(change), [change]);
  const diffText = useMemo(
    () =>
      lines
        .filter((line) => line.kind !== "ellipsis")
        .map(
          (line) =>
            `${line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}${line.text}`,
        )
        .join("\n"),
    [lines],
  );

  return (
    <div className="motion-view-enter mt-2 overflow-hidden rounded-xl border border-border/80 bg-background">
      <div className="flex h-10 items-center gap-2 border-b bg-muted/35 px-4 text-sm">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {label}
        </span>
        <span className="text-emerald-600">+{change.additions}</span>
        <span className="text-red-600">-{change.deletions}</span>
        <CopyButton
          aria-label={`复制 ${label} 的差异`}
          className="ml-auto size-7 rounded-md border-0 bg-transparent p-1 text-muted-foreground shadow-none hover:text-foreground dark:bg-transparent"
          copiedLabel="已复制"
          data-copy-button="true"
          errorLabel="复制失败"
          iconOnly
          label={`复制 ${label} 的差异`}
          title={`复制 ${label} 的差异`}
          value={diffText}
        >
          <svg
            aria-hidden="true"
            className="size-4"
            fill="none"
            viewBox="0 0 16 16"
          >
            <path
              d="M6 5.5V4a1.5 1.5 0 0 1 1.5-1.5H12A1.5 1.5 0 0 1 13.5 4v4.5A1.5 1.5 0 0 1 12 10h-1.5"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.4"
            />
            <rect
              height="7"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.4"
              width="7"
              x="2.5"
              y="6.5"
            />
          </svg>
        </CopyButton>
      </div>
      <div className="max-h-[420px] overflow-auto font-mono text-xs leading-5">
        {lines.map((line, index) => (
          <div
            className={cn(
              "grid min-w-max grid-cols-[3rem_3rem_minmax(24rem,1fr)]",
              line.kind === "addition" && "bg-emerald-500/12",
              line.kind === "deletion" && "bg-red-500/12",
              line.kind === "ellipsis" && "text-muted-foreground",
            )}
            key={`${line.kind}-${line.oldNumber}-${line.newNumber}-${index}`}
          >
            <span
              className={cn(
                "select-none border-r px-2 text-right text-muted-foreground/70",
                line.kind === "deletion" && "text-red-600",
              )}
            >
              {line.oldNumber ?? ""}
            </span>
            <span
              className={cn(
                "select-none border-r px-2 text-right text-muted-foreground/70",
                line.kind === "addition" && "text-emerald-700",
              )}
            >
              {line.newNumber ?? ""}
            </span>
            <code className="whitespace-pre px-3 text-foreground">
              {line.text || " "}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FileChangeRow({
  change,
  cwd,
  projectRoot,
  running,
  onOpenFile,
}: {
  change: AgentToolFileChange;
  cwd: string;
  projectRoot: string;
  running: boolean;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const path = displayPath(change.path, projectRoot, cwd);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="harness-tool-row flex min-h-7 min-w-0 items-center gap-2">
        <PencilIcon className="size-4 shrink-0 text-muted-foreground" />
        <span
          className={cn("shrink-0", !running && "font-medium text-foreground")}
        >
          {activityLabel(change.operation, running)}
        </span>
        <button
          aria-label={`打开 ${path}`}
          className="min-w-0 truncate text-left underline decoration-muted-foreground/55 underline-offset-2 hover:text-foreground"
          onClick={() => onOpenFile(change.path)}
          title={path}
          type="button"
        >
          {shortPath(path)}
        </button>
        <span className="shrink-0 text-emerald-600">+{change.additions}</span>
        <span className="shrink-0 text-red-600">-{change.deletions}</span>
        {running ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-blue-500" />
        ) : (
          <span className="size-2 shrink-0 rounded-full bg-blue-400" />
        )}
        <button
          aria-expanded={open}
          aria-label={`${open ? "收起" : "展开"} ${path} 的差异`}
          className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <ChevronRightIcon
            className={cn("size-4 transition-transform", open && "rotate-90")}
          />
        </button>
      </div>
      <CollapsibleContent>
        <DiffCard change={change} label={shortPath(path)} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolRow({
  cwd,
  onOpenFile,
  pathOverride,
  projectRoot,
  tool,
}: {
  cwd: string;
  onOpenFile: (path: string) => void;
  pathOverride?: string;
  projectRoot: string;
  tool: ToolTimelineEntry;
}) {
  const activity = tool.activity;
  const operation = activity?.operation ?? "other";
  const Icon = operationIcon(operation);
  const running = isRunning(tool);
  const rawPath = pathOverride ?? activity?.path;
  const path = rawPath ? displayPath(rawPath, projectRoot, cwd) : undefined;
  const detail =
    operation === "search"
      ? (path ?? activity?.glob)
      : (path ?? tool.command.trim().split(/\r?\n/u, 1)[0]);

  return (
    <div className="harness-tool-row flex min-h-7 min-w-0 items-center gap-2">
      {tool.status === "failed" || tool.permission === "denied" ? (
        <CircleXIcon className="size-4 shrink-0 text-destructive" />
      ) : operation === "other" ? (
        <CheckIcon className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <Icon className="size-4 shrink-0 text-muted-foreground" />
      )}
      {operation === "search" && detail ? (
        <>
          <span className="min-w-0 truncate">
            {running ? "正在" : "已在"}{" "}
            <span className="underline decoration-muted-foreground/55 underline-offset-2">
              {detail}
            </span>{" "}
            中搜索
          </span>
          {activity?.query ? (
            <span className="min-w-0 truncate">“{activity.query}”</span>
          ) : null}
        </>
      ) : detail ? (
        <>
          <span className="shrink-0">{activityLabel(operation, running)}</span>
          {path && operation !== "search" ? (
            <button
              aria-label={`打开 ${path}`}
              className="min-w-0 truncate text-left underline decoration-muted-foreground/55 underline-offset-2 hover:text-foreground"
              onClick={() => onOpenFile(rawPath!)}
              title={detail}
              type="button"
            >
              {shortPath(detail)}
            </button>
          ) : (
            <span className="min-w-0 truncate" title={detail}>
              {path ? shortPath(detail) : detail}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="shrink-0">{activityLabel(operation, running)}</span>
          <span className="min-w-0 truncate">{tool.title}</span>
        </>
      )}
    </div>
  );
}
