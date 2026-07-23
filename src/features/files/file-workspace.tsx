import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  RefreshCwIcon,
  SaveIcon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkspaceEntry } from "@/domain/workspace";
import {
  getWorkspaceTree,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

interface FileWorkspaceProps {
  root: string;
  onClose: () => void;
}

const languageFor = (path: string) => {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return (
    {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      rs: "rust",
      json: "json",
      md: "markdown",
      css: "css",
      html: "html",
      toml: "toml",
      yaml: "yaml",
      yml: "yaml",
      py: "python",
      sh: "shell",
    }[extension ?? ""] ?? "plaintext"
  );
};

export function FileWorkspace({ root, onClose }: FileWorkspaceProps) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const loadTree = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setEntries(await getWorkspaceTree(root));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTree();
  }, [root]);

  const filteredEntries = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query
      ? entries.filter(
          (entry) =>
            !entry.isDirectory && entry.path.toLowerCase().includes(query),
        )
      : entries;
  }, [entries, filter]);

  const openFile = async (path: string) => {
    setSelectedPath(path);
    setLoading(true);
    setError(undefined);
    try {
      const nextContent = await readWorkspaceFile(root, path);
      setContent(nextContent);
      setSavedContent(nextContent);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!selectedPath || content === savedContent) {
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await writeWorkspaceFile(root, selectedPath, content);
      setSavedContent(content);
      await loadTree();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-base">Files</h2>
          <p className="truncate text-muted-foreground text-xs">{root}</p>
        </div>
        <Button
          aria-label="Refresh files"
          disabled={loading}
          onClick={() => void loadTree()}
          size="icon"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        <Button
          disabled={!selectedPath || content === savedContent || saving}
          onClick={() => void save()}
          variant="outline"
        >
          <SaveIcon />
          {saving ? "Saving" : "Save"}
        </Button>
        <Button
          aria-label="Close files"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>

      {error ? (
        <p className="border-b bg-destructive/5 px-4 py-2 text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r">
          <div className="p-3">
            <Input
              aria-label="Filter files"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter files"
              value={filter}
            />
          </div>
          <nav
            aria-label="File tree"
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          >
            {filteredEntries.map((entry) => (
              <button
                className={cn(
                  "flex h-8 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-xs hover:bg-muted/60",
                  selectedPath === entry.path && "bg-muted text-foreground",
                  entry.isDirectory
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
                disabled={entry.isDirectory}
                key={entry.path}
                onClick={() => void openFile(entry.path)}
                style={{ paddingLeft: `${8 + entry.depth * 14}px` }}
                title={entry.path}
                type="button"
              >
                {entry.isDirectory ? (
                  <>
                    <ChevronRightIcon className="size-3 shrink-0 rotate-90" />
                    <FolderIcon className="size-3.5 shrink-0" />
                  </>
                ) : (
                  <>
                    <span className="w-3 shrink-0" />
                    <FileIcon className="size-3.5 shrink-0" />
                  </>
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-4 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {selectedPath ?? "Select a file"}
            </span>
            {content !== savedContent ? (
              <span className="ml-3 text-amber-700">Unsaved</span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1">
            {selectedPath ? (
              <Suspense
                fallback={
                  <p className="p-6 text-muted-foreground text-sm">
                    Loading editor…
                  </p>
                }
              >
                <MonacoEditor
                  language={languageFor(selectedPath)}
                  onChange={(value) => setContent(value ?? "")}
                  options={{
                    fontFamily:
                      '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
                    fontSize: 12,
                    minimap: { enabled: false },
                    padding: { top: 14 },
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    wordWrap: "on",
                  }}
                  theme="vs"
                  value={content}
                />
              </Suspense>
            ) : (
              <div className="grid h-full place-items-center text-muted-foreground text-sm">
                Select a text file to inspect or edit.
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
