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
  embedded?: boolean;
  onOpenFile?: (path: string) => void;
  root: string;
  onClose?: () => void;
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

export function FileWorkspace({
  embedded = false,
  onOpenFile,
  root,
  onClose,
}: FileWorkspaceProps) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const editorTheme =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "vs-dark"
      : "vs";

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
    if (onOpenFile) {
      onOpenFile(path);
      return;
    }
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
    <section
      className={cn(
        "flex min-h-0 flex-col bg-background",
        embedded ? "size-full" : "absolute inset-0 z-20",
      )}
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-3 border-b px-4",
          embedded ? "h-12" : "h-16",
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-base">文件</h2>
          <p className="truncate text-muted-foreground text-xs">{root}</p>
        </div>
        <Button
          aria-label="刷新文件"
          disabled={loading}
          onClick={() => void loadTree()}
          size="icon"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        {!onOpenFile ? (
          <Button
            disabled={!selectedPath || content === savedContent || saving}
            onClick={() => void save()}
            variant="outline"
          >
            <SaveIcon />
            {saving ? "正在保存" : "保存"}
          </Button>
        ) : null}
        {onClose ? (
          <Button
            aria-label="关闭文件"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <XIcon />
          </Button>
        ) : null}
      </header>

      {error ? (
        <p className="motion-view-enter border-b bg-destructive/5 px-4 py-2 text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "flex shrink-0 flex-col",
            onOpenFile ? "w-full" : "w-64 border-r",
          )}
        >
          <div className="p-3">
            <Input
              aria-label="筛选文件"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="筛选文件"
              value={filter}
            />
          </div>
          <nav
            aria-label="文件树"
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

        {!onOpenFile ? (
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-4 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {selectedPath ?? "选择文件"}
            </span>
            {content !== savedContent ? (
              <span className="motion-view-enter ml-3 text-amber-700">
                未保存
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1">
            {selectedPath ? (
              <Suspense
                fallback={
                  <p className="motion-view-enter p-6 text-muted-foreground text-sm">
                    正在加载编辑器…
                  </p>
                }
              >
                <MonacoEditor
                  language={languageFor(selectedPath)}
                  loading="正在加载编辑器…"
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
                  theme={editorTheme}
                  value={content}
                />
              </Suspense>
            ) : (
              <div className="grid h-full place-items-center text-muted-foreground text-sm">
                选择文本文件以查看或编辑。
              </div>
            )}
          </div>
        </section>
        ) : null}
      </div>
    </section>
  );
}
