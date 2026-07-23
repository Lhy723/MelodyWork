import {
  FileCode2Icon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { GitChange, GitDiff } from "@/domain/git";
import { cn } from "@/lib/utils";
import { getGitDiff } from "@/lib/melody-bridge";

interface ChangeReviewProps {
  changes: GitChange[];
  cwd: string;
  error?: string;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

const statusLabel = (status: string) => {
  if (status === "??") {
    return "U";
  }
  return status.trim() || "M";
};

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
  error,
  loading,
  onClose,
  onRefresh,
}: ChangeReviewProps) {
  const [selectedPath, setSelectedPath] = useState<string>();
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
          setDiffError(reason instanceof Error ? reason.message : String(reason));
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
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[min(42rem,calc(100%-2rem))] flex-col border-l bg-background shadow-xl">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-sm">Changes</h2>
          <p className="text-muted-foreground text-xs">
            {changes.length} changed {changes.length === 1 ? "file" : "files"}
          </p>
        </div>
        <Button
          aria-label="Refresh changes"
          disabled={loading}
          onClick={onRefresh}
          size="icon"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        <Button
          aria-label="Close changes"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>

      {error ? (
        <p className="border-b px-4 py-3 text-destructive text-sm">{error}</p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Changed files"
          className="w-56 shrink-0 overflow-y-auto border-r p-2"
        >
          {changes.map((change) => (
            <button
              className={cn(
                "flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition-colors",
                selectedPath === change.path
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              key={change.path}
              onClick={() => setSelectedPath(change.path)}
              type="button"
            >
              <FileCode2Icon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {change.path.split("/").at(-1)}
                </span>
                <span className="block truncate text-[11px]">
                  {change.path}
                </span>
                <span className="mt-1 block text-[11px]">
                  <span className="text-emerald-700">+{change.additions}</span>
                  <span className="ml-2 text-red-700">−{change.deletions}</span>
                </span>
              </span>
              <span className="rounded bg-muted-foreground/10 px-1.5 py-0.5 font-mono text-[10px]">
                {statusLabel(change.status)}
              </span>
            </button>
          ))}
          {!loading && changes.length === 0 ? (
            <p className="px-3 py-8 text-center text-muted-foreground text-xs">
              Working tree is clean.
            </p>
          ) : null}
        </nav>

        <section className="min-w-0 flex-1 overflow-auto bg-muted/20">
          {selectedPath ? (
            <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur">
              <p className="truncate font-medium text-sm">{selectedPath}</p>
            </div>
          ) : null}
          {diffLoading ? (
            <p className="p-6 text-muted-foreground text-sm">Loading diff…</p>
          ) : diffError ? (
            <p className="p-6 text-destructive text-sm">{diffError}</p>
          ) : diff?.binary ? (
            <p className="p-6 text-muted-foreground text-sm">
              Binary file preview is not available.
            </p>
          ) : diffLines.length > 1 ? (
            <pre className="py-3 font-mono text-[11px] leading-5">
              {diffLines.map((line, index) => (
                <DiffLine key={`${index}-${line}`} line={line} />
              ))}
            </pre>
          ) : selectedPath ? (
            <p className="p-6 text-muted-foreground text-sm">
              No textual diff is available for this file yet.
            </p>
          ) : (
            <p className="p-6 text-muted-foreground text-sm">
              Select a changed file to review its diff.
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
