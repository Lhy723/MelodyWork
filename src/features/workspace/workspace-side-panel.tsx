import {
  FileCode2Icon,
  FilesIcon,
  GitCompareArrowsIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type PointerEventHandler,
} from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GitChange } from "@/domain/git";
import { FileWorkspace } from "@/features/files/file-workspace";
import { ChangeReview } from "@/features/git/change-review";
import { TerminalPanel } from "@/features/terminal/terminal-panel";
import { readWorkspaceFile } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

export type WorkspaceTab =
  | { id: string; kind: "files"; label: string }
  | { id: string; kind: "terminal"; label: string }
  | { id: string; kind: "review"; label: string }
  | {
      id: string;
      kind: "file";
      label: string;
      path: string;
    };

interface WorkspaceSidePanelProps {
  activeTabId?: string;
  changes: GitChange[];
  cwd: string;
  gitError?: string;
  gitLoading: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: (kind: "files" | "terminal" | "review") => void;
  onOpenFile: (path: string) => void;
  onResizeBy: (delta: number) => void;
  onResizeStart: PointerEventHandler<HTMLDivElement>;
  onResetWidth: () => void;
  onRefreshGit: () => void;
  root: string;
  tabs: WorkspaceTab[];
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

const tabIcon = (tab: WorkspaceTab) => {
  if (tab.kind === "files") {
    return <FilesIcon />;
  }
  if (tab.kind === "terminal") {
    return <TerminalSquareIcon />;
  }
  if (tab.kind === "review") {
    return <GitCompareArrowsIcon />;
  }
  return <FileCode2Icon />;
};

function FilePreview({ path, root }: { path: string; root: string }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const editorTheme =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "vs-dark"
      : "vs";

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void readWorkspaceFile(root, path)
      .then((nextContent) => {
        if (active) {
          setContent(nextContent);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [path, root]);

  return (
    <section className="flex size-full min-h-0 flex-col bg-background">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FileCode2Icon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs" title={path}>
          {path}
        </span>
        <Button
          aria-label="重新加载文件"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError(undefined);
            void readWorkspaceFile(root, path)
              .then(setContent)
              .catch((reason) =>
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                ),
              )
              .finally(() => setLoading(false));
          }}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
      </header>
      {error ? (
        <p className="border-b bg-destructive/5 px-3 py-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {loading && !content ? (
          <p className="p-4 text-muted-foreground text-xs">正在加载文件…</p>
        ) : (
          <Suspense
            fallback={
              <p className="p-4 text-muted-foreground text-xs">
                正在加载预览…
              </p>
            }
          >
            <MonacoEditor
              language={languageFor(path)}
              loading="正在加载预览…"
              options={{
                fontFamily:
                  '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
                fontSize: 12,
                lineNumbersMinChars: 3,
                minimap: { enabled: false },
                padding: { top: 12 },
                readOnly: true,
                renderLineHighlight: "none",
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                wordWrap: "on",
              }}
              theme={editorTheme}
              value={content}
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}

export function WorkspaceSidePanel({
  activeTabId,
  changes,
  cwd,
  gitError,
  gitLoading,
  onActivateTab,
  onCloseTab,
  onNewTab,
  onOpenFile,
  onResizeBy,
  onResizeStart,
  onResetWidth,
  onRefreshGit,
  root,
  tabs,
}: WorkspaceSidePanelProps) {
  return (
    <aside
      aria-label="右侧工作区"
      className="motion-workspace-panel relative flex size-full min-h-0 shrink-0 flex-col border-l bg-background shadow-[-12px_0_30px_-24px_rgba(0,0,0,0.35)]"
      style={{ width: "var(--workspace-panel-width, 35rem)" }}
    >
      <div
        aria-label="调整右侧工作区宽度"
        aria-orientation="vertical"
        className="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onDoubleClick={onResetWidth}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onResizeBy(24);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            onResizeBy(-24);
          } else if (event.key === "Home") {
            event.preventDefault();
            onResetWidth();
          }
        }}
        onPointerDown={onResizeStart}
        role="separator"
        tabIndex={0}
        title="拖拽调整宽度，双击恢复默认"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-ring group-focus-visible:bg-ring" />
      </div>
      <header className="flex h-8 shrink-0 items-center border-b">
        <div
          aria-label="工作区标签页"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1"
          role="tablist"
        >
          {tabs.map((tab) => (
            <div
              className={cn(
                "group flex h-6 min-w-0 max-w-52 shrink-0 items-center rounded-md border border-transparent text-muted-foreground transition-colors",
                activeTabId === tab.id &&
                  "border-border/80 bg-muted/70 text-foreground shadow-sm",
              )}
              key={tab.id}
            >
              <button
                aria-selected={activeTabId === tab.id}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 pl-2.5 text-xs outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onActivateTab(tab.id)}
                role="tab"
                title={tab.kind === "file" ? tab.path : tab.label}
                type="button"
              >
                <span className="[&>svg]:size-3.5">{tabIcon(tab)}</span>
                <span className="truncate">{tab.label}</span>
              </button>
              <Button
                aria-label={`关闭 ${tab.label}`}
                className="mr-1 size-6 shrink-0 opacity-55 hover:opacity-100"
                onClick={() => onCloseTab(tab.id)}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="新建工作区标签页"
              className="mr-1 size-7 shrink-0"
              size="icon-xs"
              title="新建标签页"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onNewTab("terminal")}>
              <TerminalSquareIcon />
              新建终端
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewTab("files")}>
              <FilesIcon />
              新建文件
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewTab("review")}>
              <GitCompareArrowsIcon />
              新建审阅
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="grid size-full place-items-center p-6">
            <div className="w-full max-w-xs">
              <p className="mb-4 text-center text-muted-foreground text-sm">
                打开一个标签页
              </p>
              <div className="grid gap-2">
                <Button
                  className="justify-start"
                  onClick={() => onNewTab("files")}
                  variant="outline"
                >
                  <FilesIcon />
                  文件
                </Button>
                <Button
                  className="justify-start"
                  onClick={() => onNewTab("review")}
                  variant="outline"
                >
                  <GitCompareArrowsIcon />
                  审阅
                </Button>
                <Button
                  className="justify-start"
                  onClick={() => onNewTab("terminal")}
                  variant="outline"
                >
                  <TerminalSquareIcon />
                  终端
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {tabs.map((tab) => (
          <div
            aria-hidden={activeTabId !== tab.id}
            className={cn(
              "absolute inset-0",
              activeTabId !== tab.id && "hidden",
            )}
            inert={activeTabId !== tab.id}
            key={tab.id}
            role="tabpanel"
          >
            {tab.kind === "files" ? (
              <FileWorkspace
                embedded
                onOpenFile={onOpenFile}
                root={root}
              />
            ) : tab.kind === "terminal" ? (
              <TerminalPanel cwd={cwd} embedded />
            ) : tab.kind === "review" ? (
              <ChangeReview
                changes={changes}
                cwd={cwd}
                embedded
                error={gitError}
                loading={gitLoading}
                onRefresh={onRefreshGit}
              />
            ) : (
              <FilePreview path={tab.path} root={root} />
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
