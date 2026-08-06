import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Task,
  TaskContent,
  TaskTrigger,
} from "@/components/ai-elements/task";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import type {
  AgentToolDiffHunk,
  AgentToolFileChange,
  AgentToolOperation,
} from "@/domain/acp";
import type { ToolTimelineEntry } from "@/domain/timeline-groups";
import { cn } from "@/lib/utils";
import {
  BookOpenIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleXIcon,
  CopyIcon,
  LoaderCircleIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface ToolTaskGroupProps {
  cwd: string;
  onPermission: (entryId: string, optionId: string) => void;
  projectRoot: string;
  turnRunning: boolean;
  tools: ToolTimelineEntry[];
}

interface DiffLine {
  kind: "context" | "addition" | "deletion" | "ellipsis";
  oldNumber?: number;
  newNumber?: number;
  text: string;
}

const splitLines = (text: string | undefined) => {
  if (!text) {
    return [];
  }
  const lines = text.split(/\r?\n/u);
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
};

const coarseDiff = (oldLines: string[], newLines: string[]) => {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...oldLines.slice(0, prefix).map((text) => ({ kind: "context", text })),
    ...oldLines
      .slice(prefix, oldLines.length - suffix)
      .map((text) => ({ kind: "deletion", text })),
    ...newLines
      .slice(prefix, newLines.length - suffix)
      .map((text) => ({ kind: "addition", text })),
    ...oldLines
      .slice(oldLines.length - suffix)
      .map((text) => ({ kind: "context", text })),
  ] as { kind: Exclude<DiffLine["kind"], "ellipsis">; text: string }[];
};

const sequenceDiff = (oldLines: string[], newLines: string[]) => {
  if (oldLines.length * newLines.length > 250_000) {
    return coarseDiff(oldLines, newLines);
  }
  const columns = newLines.length + 1;
  const matrix = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(columns),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? matrix[oldIndex + 1][newIndex + 1] + 1
          : Math.max(
              matrix[oldIndex + 1][newIndex],
              matrix[oldIndex][newIndex + 1],
            );
    }
  }
  const lines: ReturnType<typeof coarseDiff> = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      lines.push({ kind: "context", text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < newLines.length &&
      (oldIndex === oldLines.length ||
        matrix[oldIndex][newIndex + 1] >
          matrix[oldIndex + 1][newIndex])
    ) {
      lines.push({ kind: "addition", text: newLines[newIndex] });
      newIndex += 1;
    } else {
      lines.push({ kind: "deletion", text: oldLines[oldIndex] });
      oldIndex += 1;
    }
  }
  return lines;
};

const numberedDiffLines = ({
  oldText,
  newText,
  oldStartLine = 1,
  newStartLine = 1,
}: {
  oldText?: string;
  newText: string;
  oldStartLine?: number;
  newStartLine?: number;
}) => {
  const rawLines = sequenceDiff(
    splitLines(oldText),
    splitLines(newText),
  );
  let oldNumber = oldStartLine;
  let newNumber = newStartLine;
  return rawLines.map((line): DiffLine => {
    if (line.kind === "addition") {
      return { ...line, newNumber: newNumber++ };
    }
    if (line.kind === "deletion") {
      return { ...line, oldNumber: oldNumber++ };
    }
    return {
      ...line,
      oldNumber: oldNumber++,
      newNumber: newNumber++,
    };
  });
};

const linesForHunk = (hunk: AgentToolDiffHunk) => {
  const contextBefore = splitLines(hunk.contextBefore);
  const contextAfter = splitLines(hunk.contextAfter);
  return numberedDiffLines({
    oldText: [...contextBefore, ...splitLines(hunk.oldText), ...contextAfter]
      .join("\n"),
    newText: [...contextBefore, ...splitLines(hunk.newText), ...contextAfter]
      .join("\n"),
    oldStartLine: Math.max(1, hunk.oldStartLine - contextBefore.length),
    newStartLine: Math.max(1, hunk.newStartLine - contextBefore.length),
  });
};

const visibleDiffLines = (change: AgentToolFileChange): DiffLine[] => {
  if (change.hunks?.length) {
    return change.hunks.flatMap((hunk, index) => [
      ...(index > 0
        ? [{ kind: "ellipsis", text: "…" } satisfies DiffLine]
        : []),
      ...linesForHunk(hunk),
    ]).slice(0, 240);
  }
  const numbered = numberedDiffLines({
    oldText: change.oldText,
    newText: change.newText,
    oldStartLine: change.oldStartLine,
    newStartLine: change.newStartLine,
  });
  const changed = numbered.flatMap((line, index) =>
    line.kind === "context" ? [] : [index],
  );
  if (!changed.length) {
    return numbered.slice(0, 20);
  }
  const start = Math.max(0, changed[0] - 3);
  const end = Math.min(numbered.length, changed.at(-1)! + 4);
  const focused = numbered.slice(start, end);
  const withEdges: DiffLine[] = [];
  if (start > 0) {
    withEdges.push({ kind: "ellipsis", text: "…" });
  }
  withEdges.push(...focused.slice(0, 240));
  if (end < numbered.length || focused.length > 240) {
    withEdges.push({ kind: "ellipsis", text: "…" });
  }
  return withEdges;
};

const displayPath = (path: string, projectRoot: string, cwd: string) => {
  const normalized = path.replaceAll("\\", "/");
  const roots = [projectRoot, cwd]
    .map((root) => root.replaceAll("\\", "/").replace(/\/$/u, ""))
    .filter(Boolean);
  const root = roots.find((candidate) =>
    normalized.startsWith(`${candidate}/`),
  );
  return root ? normalized.slice(root.length + 1) : normalized;
};

const shortPath = (path: string) => path.split("/").at(-1) ?? path;

const isRunning = (tool: ToolTimelineEntry) =>
  tool.permission !== "denied" &&
  tool.status !== "failed" &&
  tool.status !== "completed";

const activityLabel = (operation: AgentToolOperation, running: boolean) => {
  const labels: Record<AgentToolOperation, [string, string]> = {
    read: ["正在读取", "已读取"],
    search: ["正在搜索", "已搜索"],
    create: ["正在创建", "已创建"],
    edit: ["正在编辑", "已编辑"],
    delete: ["正在删除", "已删除"],
    execute: ["正在运行", "已运行"],
    other: ["正在执行", "已执行"],
  };
  return labels[operation][running ? 0 : 1];
};

const operationIcon = (operation: AgentToolOperation) => {
  switch (operation) {
    case "read":
      return BookOpenIcon;
    case "search":
      return SearchIcon;
    case "create":
    case "edit":
    case "delete":
      return PencilIcon;
    case "execute":
      return TerminalIcon;
    default:
      return WrenchIcon;
  }
};

const groupTitle = (tools: ToolTimelineEntry[]) => {
  const active = tools.find(isRunning);
  if (active) {
    const operation = active.activity?.operation ?? "other";
    return `${activityLabel(operation, true)}${operation === "execute" ? "命令" : "文件"}`;
  }
  const operations = [...new Set(
    tools.map((tool) => tool.activity?.operation ?? "other"),
  )];
  const labels: Record<AgentToolOperation, string> = {
    read: "读取了文件",
    search: "搜索了文件",
    create: "创建了文件",
    edit: "编辑了文件",
    delete: "删除了文件",
    execute: "运行了命令",
    other: "执行了操作",
  };
  return operations.map((operation) => labels[operation]).join("、");
};

const DiffCard = ({ change, label }: {
  change: AgentToolFileChange;
  label: string;
}) => {
  const lines = useMemo(() => visibleDiffLines(change), [change]);
  const copyDiff = () => {
    const text = lines
      .filter((line) => line.kind !== "ellipsis")
      .map((line) =>
        `${line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}${line.text}`,
      )
      .join("\n");
    void navigator.clipboard.writeText(text);
  };

  return (
    <div className="motion-view-enter mt-2 overflow-hidden rounded-xl border border-border/80 bg-background">
      <div className="flex h-10 items-center gap-2 border-b bg-muted/35 px-4 text-sm">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {label}
        </span>
        <span className="text-emerald-600">+{change.additions}</span>
        <span className="text-red-600">-{change.deletions}</span>
        <button
          aria-label={`复制 ${label} 的差异`}
          className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={copyDiff}
          type="button"
        >
          <CopyIcon className="size-4" />
        </button>
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
};

const FileChangeRow = ({
  change,
  cwd,
  projectRoot,
  running,
}: {
  change: AgentToolFileChange;
  cwd: string;
  projectRoot: string;
  running: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const path = displayPath(change.path, projectRoot, cwd);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <PencilIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className={cn("shrink-0", !running && "font-medium text-foreground")}>
          {activityLabel(change.operation, running)}
        </span>
        <span
          className="min-w-0 truncate underline decoration-muted-foreground/55 underline-offset-2"
          title={path}
        >
          {shortPath(path)}
        </span>
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
          className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
};

const ToolRow = ({
  cwd,
  pathOverride,
  projectRoot,
  tool,
}: {
  cwd: string;
  pathOverride?: string;
  projectRoot: string;
  tool: ToolTimelineEntry;
}) => {
  const activity = tool.activity;
  const operation = activity?.operation ?? "other";
  const Icon = operationIcon(operation);
  const running = isRunning(tool);
  const path = (pathOverride ?? activity?.path)
    ? displayPath(pathOverride ?? activity?.path ?? "", projectRoot, cwd)
    : undefined;
  const detail =
    operation === "search"
      ? path ?? activity?.glob
      : path ?? tool.command.trim().split(/\r?\n/u, 1)[0];

  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2">
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
          <span
            className={cn(
              "min-w-0 truncate",
              path && "underline decoration-muted-foreground/55 underline-offset-2",
            )}
            title={detail}
          >
            {path ? shortPath(detail) : detail}
          </span>
        </>
      ) : (
        <>
          <span className="shrink-0">{activityLabel(operation, running)}</span>
          <span className="min-w-0 truncate">{tool.title}</span>
        </>
      )}
    </div>
  );
};

export function ToolTaskGroup({
  cwd,
  onPermission,
  projectRoot,
  turnRunning,
  tools,
}: ToolTaskGroupProps) {
  const running = tools.some(isRunning);
  const [open, setOpen] = useState(turnRunning);
  const wasTurnRunning = useRef(turnRunning);

  useEffect(() => {
    if (turnRunning && !wasTurnRunning.current) {
      setOpen(true);
    }
    if (!turnRunning && wasTurnRunning.current) {
      const timer = window.setTimeout(() => setOpen(false), 800);
      wasTurnRunning.current = turnRunning;
      return () => window.clearTimeout(timer);
    }
    wasTurnRunning.current = turnRunning;
  }, [turnRunning]);

  const headerOperation =
    tools.find((tool) =>
      tool.activity?.files?.length ||
      tool.activity?.operation === "edit" ||
      tool.activity?.operation === "create",
    )?.activity?.operation ??
    tools[0]?.activity?.operation ??
    "other";
  const HeaderIcon = operationIcon(headerOperation);

  return (
    <Task
      className="w-full"
      onOpenChange={setOpen}
      open={open}
    >
      <TaskTrigger title={groupTitle(tools)}>
        <button
          className="group flex min-h-7 w-full items-center gap-2 text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground"
          type="button"
        >
          <HeaderIcon className="size-4 shrink-0" />
          <span className="min-w-0 truncate font-medium">
            {groupTitle(tools)}
          </span>
          {running ? (
            <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
          ) : null}
          <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </TaskTrigger>
      <TaskContent className="[&>div]:mt-1 [&>div]:space-y-0.5 [&>div]:border-l-0 [&>div]:pl-0 [&>div]:text-[13px] [&>div]:leading-5">
        {tools.flatMap((tool) => {
          const changes = tool.activity?.files ?? [];
          const changePaths = new Set(changes.map((change) => change.path));
          const extraPaths = (tool.activity?.paths ?? []).filter(
            (path) => !changePaths.has(path),
          );
          const rows = [
            ...changes.map((change) => (
              <FileChangeRow
                change={change}
                cwd={cwd}
                key={`${tool.id}-${change.path}`}
                projectRoot={projectRoot}
                running={isRunning(tool)}
              />
            )),
            ...extraPaths.map((path) => (
              <ToolRow
                cwd={cwd}
                key={`${tool.id}-${path}`}
                pathOverride={path}
                projectRoot={projectRoot}
                tool={tool}
              />
            )),
          ];
          if (rows.length === 0) {
            rows.push(
              <ToolRow
                cwd={cwd}
                key={tool.id}
                projectRoot={projectRoot}
                tool={tool}
              />,
            );
          }
          if (tool.permission !== "pending") {
            return rows;
          }
          return [
            ...rows,
            <Confirmation
              approval={{ id: tool.id }}
              className="motion-view-enter ml-6"
              key={`${tool.id}-permission`}
              state="approval-requested"
            >
              <ConfirmationRequest>
                <ConfirmationTitle>
                  Melody 需要你的授权才能继续执行此步骤。
                </ConfirmationTitle>
                <ConfirmationActions>
                  {tool.permissionOptions?.map((option) => (
                    <ConfirmationAction
                      key={option.optionId}
                      onClick={() => onPermission(tool.id, option.optionId)}
                      variant={
                        option.kind.startsWith("reject")
                          ? "ghost"
                          : option.kind === "allow_once"
                            ? "outline"
                            : "default"
                      }
                    >
                      {option.kind === "reject_once"
                        ? "拒绝一次"
                        : option.kind === "reject_always"
                          ? "始终拒绝"
                          : option.kind === "allow_once"
                            ? "允许一次"
                            : "始终允许"}
                    </ConfirmationAction>
                  ))}
                  {tool.permissionOptions?.some((option) =>
                    option.kind.startsWith("reject"),
                  ) ? (
                    <ConfirmationAction
                      onClick={() => onPermission(tool.id, "project:deny")}
                      variant="ghost"
                    >
                      对项目拒绝
                    </ConfirmationAction>
                  ) : null}
                  {tool.permissionOptions?.some((option) =>
                    option.kind.startsWith("allow"),
                  ) ? (
                    <ConfirmationAction
                      onClick={() => onPermission(tool.id, "project:allow")}
                      variant="default"
                    >
                      对项目允许
                    </ConfirmationAction>
                  ) : null}
                </ConfirmationActions>
              </ConfirmationRequest>
            </Confirmation>,
          ];
        })}
      </TaskContent>
    </Task>
  );
}
