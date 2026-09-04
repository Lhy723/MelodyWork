import { FileCode2Icon, FolderIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { LoadingButton } from "@/components/interior/loading-button";
import { TreeView, type TreeNode } from "@/components/interior/tree-view";
import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/domain/app-error";
import type { GitChange, GitDiff } from "@/domain/git";
import { cn } from "@/lib/utils";
import { getGitDiff } from "@/lib/melody-bridge";

interface ChangeReviewProps {
  changes: GitChange[];
  cwd: string;
  embedded?: boolean;
  error?: string;
  loading: boolean;
  onClose?: () => void;
  onRefresh: () => unknown;
}

const statusLabel = (status: string) => {
  if (status === "??") {
    return "U";
  }
  return status.trim() || "M";
};

type ChangeTreeNode = TreeNode & {
  isDirectory: boolean;
  fileCount?: number;
  children?: ChangeTreeNode[];
};

const ancestorPathsFor = (path: string) => {
  const segments = path.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
};

const changeMeta = (change: GitChange) => (
  <span className="inline-flex items-center gap-1 font-mono text-[10px]">
    <span className="text-emerald-700">+{change.additions}</span>
    <span className="text-red-700">−{change.deletions}</span>
    <span className="rounded bg-muted-foreground/10 px-1">
      {statusLabel(change.status)}
    </span>
  </span>
);

function buildChangeTree(changes: GitChange[]): ChangeTreeNode[] {
  const roots: ChangeTreeNode[] = [];
  const nodeByPath = new Map<string, ChangeTreeNode>();

  for (const change of changes) {
    const segments = change.path.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let parentPath: string | undefined;
    let siblings = roots;
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      const path = parentPath ? `${parentPath}/${segment}` : segment;
      let node = nodeByPath.get(path);

      if (!node) {
        node = isFile
          ? {
              id: path,
              label: segment,
              icon: <FileCode2Icon className="size-3.5" />,
              meta: changeMeta(change),
              selectable: true,
              isDirectory: false,
            }
          : {
              id: path,
              label: segment,
              icon: <FolderIcon className="size-3.5" />,
              children: [],
              selectable: false,
              isDirectory: true,
            };
        nodeByPath.set(path, node);
        siblings.push(node);
      } else if (isFile) {
        node.meta = changeMeta(change);
      }

      if (!isFile) {
        parentPath = path;
        siblings = node.children ?? [];
        node.children = siblings;
      }
    });
  }

  const sortAndCount = (nodes: ChangeTreeNode[]): ChangeTreeNode[] =>
    [...nodes]
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.label.localeCompare(right.label, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      })
      .map((node) => {
        if (!node.isDirectory) return node;
        const children = sortAndCount(node.children ?? []);
        const fileCount = children.reduce(
          (count, child) =>
            count + (child.isDirectory ? (child.fileCount ?? 0) : 1),
          0,
        );
        return {
          ...node,
          children,
          fileCount,
          meta: `${fileCount}`,
        };
      });

  return sortAndCount(roots);
}

const DiffLine = ({ line }: { line: string }) => {
  const kind = line.startsWith("+")
    ? "addition"
    : line.startsWith("-")
      ? "deletion"
      : line.startsWith("@@")
        ? "hunk"
        : "context";

  return (
    <div
      className={cn(
        "min-w-max px-4 py-0.5",
        kind === "addition" && "bg-emerald-50 text-emerald-950",
        kind === "deletion" && "bg-red-50 text-red-950",
        kind === "hunk" && "bg-blue-50 text-blue-800",
      )}
    >
      {line || " "}
    </div>
  );
};

export function ChangeReview({
  changes,
  cwd,
  embedded = false,
  error,
  loading,
  onClose,
  onRefresh,
}: ChangeReviewProps) {
  const [selectedPath, setSelectedPath] = useState<string>();
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [diff, setDiff] = useState<GitDiff>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string>();

  useEffect(() => {
    if (
      changes.length > 0 &&
      !changes.some((change) => change.path === selectedPath)
    ) {
      setSelectedPath(changes[0].path);
    }
  }, [changes, selectedPath]);

  const changeTree = useMemo(() => buildChangeTree(changes), [changes]);

  useEffect(() => {
    const rootDirectories = changeTree
      .filter((node) => node.isDirectory && node.children?.length)
      .map((node) => node.id);
    const availableDirectories = new Set<string>();
    const collectDirectories = (nodes: ChangeTreeNode[]) => {
      nodes.forEach((node) => {
        if (!node.isDirectory) return;
        availableDirectories.add(node.id);
        collectDirectories(node.children ?? []);
      });
    };
    collectDirectories(changeTree);
    const selectedAncestors = selectedPath
      ? ancestorPathsFor(selectedPath).filter((path) =>
          availableDirectories.has(path),
        )
      : [];
    setExpandedPaths((previous) => {
      const retained = previous.filter((path) =>
        availableDirectories.has(path),
      );
      const base =
        retained.length > 0 || rootDirectories.length === 0
          ? retained
          : rootDirectories;
      return [...new Set([...base, ...selectedAncestors])];
    });
  }, [changeTree, selectedPath]);

  useEffect(() => {
    if (!selectedPath) {
      setDiff(undefined);
      return;
    }
    let active = true;
    setDiffLoading(true);
    setDiffError(undefined);
    void getGitDiff(cwd, selectedPath)
      .then((result) => {
        if (active) {
          setDiff(result);
        }
      })
      .catch((reason) => {
        if (active) {
          setDiffError(toUserMessage(reason));
        }
      })
      .finally(() => {
        if (active) {
          setDiffLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [cwd, selectedPath]);

  const diffLines = useMemo(() => diff?.content.split("\n") ?? [], [diff]);

  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col bg-background",
        embedded
          ? "size-full"
          : "absolute inset-y-0 right-0 z-20 w-[min(42rem,calc(100%-2rem))] border-l",
      )}
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-3 border-b px-4",
          embedded ? "h-12" : "h-16",
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-sm">更改</h2>
          <p className="text-muted-foreground text-xs">
            {changes.length} 个已更改文件
          </p>
        </div>
        <LoadingButton
          aria-label="刷新更改"
          disabled={loading}
          errorLabel="重试"
          icon={<RefreshCwIcon />}
          iconOnly
          onAction={onRefresh}
          pendingLabel="刷新中…"
          size="default"
          successLabel="已刷新"
          variant="ghost"
        >
          刷新更改
        </LoadingButton>
        {onClose ? (
          <Button
            aria-label="关闭更改"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <XIcon />
          </Button>
        ) : null}
      </header>

      {error ? (
        <p
          aria-live="assertive"
          className="motion-view-enter border-b px-4 py-3 text-destructive text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="已更改文件"
          className="w-64 shrink-0 overflow-y-auto border-r p-2"
        >
          {changeTree.length > 0 ? (
            <TreeView
              className="rounded-none border-0 bg-transparent p-0 shadow-none"
              expanded={expandedPaths}
              label="已更改文件"
              nodes={changeTree}
              onExpandedChange={setExpandedPaths}
              onSelectedChange={setSelectedPath}
              selected={selectedPath ?? null}
            />
          ) : null}
          {!loading && changes.length === 0 ? (
            <p className="px-3 py-8 text-center text-muted-foreground text-xs">
              工作树是干净的。
            </p>
          ) : null}
        </nav>

        <section className="min-w-0 flex-1 overflow-auto bg-muted/20">
          {selectedPath ? (
            <div className="sticky top-0 z-10 border-b bg-background/84 px-4 py-3 backdrop-blur">
              <p className="truncate font-medium text-sm">{selectedPath}</p>
            </div>
          ) : null}
          {diffLoading ? (
            <p className="p-6 text-muted-foreground text-sm">正在加载差异…</p>
          ) : diffError ? (
            <p className="p-6 text-destructive text-sm">{diffError}</p>
          ) : diff?.binary ? (
            <p className="p-6 text-muted-foreground text-sm">
              暂不支持预览二进制文件。
            </p>
          ) : diffLines.length > 1 ? (
            <pre className="py-3 font-mono text-xs leading-5">
              {diffLines.map((line, index) => (
                <DiffLine key={`${index}-${line}`} line={line} />
              ))}
            </pre>
          ) : selectedPath ? (
            <p className="p-6 text-muted-foreground text-sm">
              此文件暂无文本差异。
            </p>
          ) : (
            <p className="p-6 text-muted-foreground text-sm">
              选择已更改的文件以查看差异。
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
