import {
  FileIcon,
  FolderIcon,
  RefreshCwIcon,
  SaveIcon,
  XIcon,
} from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useGlobalLiveActivity } from "@/components/interior/live-activity";
import { LoadingButton } from "@/components/interior/loading-button";
import { TreeView, type TreeNode } from "@/components/interior/tree-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toUserMessage } from "@/domain/app-error";
import type { WorkspaceEntry } from "@/domain/workspace";
import {
  getWorkspaceTree,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/melody-bridge";
import { MonacoEditor } from "@/features/files/monaco-editor";
import { cn } from "@/lib/utils";
import { useAppSettingsStore } from "@/stores/app-settings-store";

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

type WorkspaceTreeNode = TreeNode & {
  isDirectory: boolean;
  children?: WorkspaceTreeNode[];
};

type WorkspaceTreeModel = {
  nodes: WorkspaceTreeNode[];
  matchingDirectories: string[];
};

const parentPathFor = (path: string) => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? undefined : path.slice(0, separator);
};

function buildWorkspaceTree(
  entries: WorkspaceEntry[],
  filter = "",
): WorkspaceTreeModel {
  const nodeByPath = new Map<string, WorkspaceTreeNode>();
  const roots: WorkspaceTreeNode[] = [];

  for (const entry of entries) {
    nodeByPath.set(entry.path, {
      id: entry.path,
      isDirectory: entry.isDirectory,
      label: entry.name,
      selectable: !entry.isDirectory,
      icon: entry.isDirectory ? (
        <FolderIcon className="size-3.5" />
      ) : (
        <FileIcon className="size-3.5" />
      ),
      ...(entry.isDirectory ? { children: [] } : {}),
    });
  }

  for (const entry of entries) {
    const node = nodeByPath.get(entry.path);
    if (!node) continue;
    const parentPath = parentPathFor(entry.path);
    const parent = parentPath ? nodeByPath.get(parentPath) : undefined;
    if (parent?.isDirectory) {
      parent.children?.push(node);
    } else {
      roots.push(node);
    }
  }

  const query = filter.trim().toLowerCase();
  if (!query) {
    return { matchingDirectories: [], nodes: roots };
  }

  const included = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory || !entry.path.toLowerCase().includes(query)) {
      continue;
    }
    included.add(entry.path);
    let parent = parentPathFor(entry.path);
    while (parent) {
      included.add(parent);
      parent = parentPathFor(parent);
    }
  }

  const prune = (nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] =>
    nodes.flatMap((node) => {
      if (!included.has(node.id)) return [];
      const children = node.children ? prune(node.children) : undefined;
      return [
        {
          ...node,
          ...(node.children ? { children } : {}),
        },
      ];
    });
  const filteredNodes = prune(roots);

  return {
    matchingDirectories: [...included].filter(
      (path) => nodeByPath.get(path)?.isDirectory,
    ),
    nodes: filteredNodes,
  };
}

export function FileWorkspace({
  embedded = false,
  onOpenFile,
  root,
  onClose,
}: FileWorkspaceProps) {
  const {
    fail: failActivity,
    start: startActivity,
    succeed: succeedActivity,
  } = useGlobalLiveActivity();
  const codeFont = useAppSettingsStore((state) => state.codeFont);
  const codeFontSize = useAppSettingsStore((state) => state.codeFontSize);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const expandedRoot = useRef<string | undefined>(undefined);
  const editorTheme =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "vs-dark"
      : "vs";

  const loadTree = useCallback(
    async (announce = false) => {
      if (announce) {
        startActivity({
          detail: "正在读取工作区文件树…",
          title: "刷新文件",
        });
      }
      setLoading(true);
      setError(undefined);
      try {
        const nextEntries = await getWorkspaceTree(root);
        setEntries(nextEntries);
        if (expandedRoot.current !== root) {
          expandedRoot.current = root;
          const initialTree = buildWorkspaceTree(nextEntries);
          setExpandedPaths(
            initialTree.nodes
              .filter((node) => node.children && node.children.length > 0)
              .map((node) => node.id),
          );
        }
        if (announce) {
          succeedActivity({
            detail: `已读取 ${nextEntries.length} 个文件和目录。`,
            title: "文件已刷新",
          });
        }
      } catch (reason) {
        const message = toUserMessage(reason);
        setError(message);
        if (announce) {
          failActivity(
            { detail: message, title: "刷新文件失败" },
            {
              label: "重试",
              onClick: () => {
                void loadTree(true).catch(() => undefined);
              },
            },
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [failActivity, root, startActivity, succeedActivity],
  );

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    setSelectedPath(undefined);
    setContent("");
    setSavedContent("");
    setFilter("");
    setExpandedPaths([]);
    expandedRoot.current = undefined;
  }, [root]);

  const workspaceTree = useMemo(
    () => buildWorkspaceTree(entries, filter),
    [entries, filter],
  );
  const visibleExpandedPaths = useMemo(() => {
    const query = filter.trim();
    if (!query) return expandedPaths;
    return [
      ...new Set([...expandedPaths, ...workspaceTree.matchingDirectories]),
    ];
  }, [expandedPaths, filter, workspaceTree.matchingDirectories]);

  const openFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      if (onOpenFile) {
        onOpenFile(path);
        return;
      }
      setLoading(true);
      setError(undefined);
      try {
        const nextContent = await readWorkspaceFile(root, path);
        setContent(nextContent);
        setSavedContent(nextContent);
      } catch (reason) {
        setError(toUserMessage(reason));
      } finally {
        setLoading(false);
      }
    },
    [onOpenFile, root],
  );

  const handleTreeSelection = useCallback(
    (path: string) => {
      const entry = entries.find((candidate) => candidate.path === path);
      if (!entry || entry.isDirectory) return;
      void openFile(path);
    },
    [entries, openFile],
  );

  const save = async () => {
    if (!selectedPath || content === savedContent) {
      return;
    }
    const path = selectedPath;
    startActivity({
      detail: `正在保存 ${path}…`,
      title: "保存文件",
    });
    setError(undefined);
    try {
      await writeWorkspaceFile(root, path, content);
      setSavedContent(content);
      await loadTree();
      succeedActivity({ detail: `${path} 已保存。`, title: "文件已保存" });
    } catch (reason) {
      const message = toUserMessage(reason);
      setError(message);
      failActivity(
        { detail: message, title: "保存文件失败" },
        {
          label: "重试",
          onClick: () => {
            void save().catch(() => undefined);
          },
        },
      );
      throw reason;
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
        <LoadingButton
          aria-label="刷新文件"
          disabled={loading}
          errorLabel="重试"
          icon={<RefreshCwIcon />}
          iconOnly
          onAction={() => loadTree(true)}
          pendingLabel="刷新中…"
          size="default"
          successLabel="已刷新"
          variant="ghost"
        >
          刷新文件
        </LoadingButton>
        {!onOpenFile ? (
          <LoadingButton
            disabled={!selectedPath || content === savedContent}
            errorLabel="重试"
            icon={<SaveIcon />}
            onAction={save}
            pendingLabel="正在保存…"
            successLabel="已保存"
            variant="outline"
          >
            保存
          </LoadingButton>
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
        <p
          aria-live="assertive"
          className="motion-view-enter border-b bg-destructive/5 px-4 py-2 text-destructive text-sm"
          role="alert"
        >
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
            {loading && entries.length === 0 ? (
              <p className="px-2 py-3 text-muted-foreground text-xs">
                正在读取文件树…
              </p>
            ) : workspaceTree.nodes.length > 0 ? (
              <TreeView
                className="rounded-none border-0 bg-transparent p-0 shadow-none"
                expanded={visibleExpandedPaths}
                label="文件树"
                onExpandedChange={setExpandedPaths}
                onSelectedChange={handleTreeSelection}
                selected={selectedPath ?? null}
                nodes={workspaceTree.nodes}
              />
            ) : (
              <p className="px-2 py-3 text-muted-foreground text-xs">
                {filter.trim() ? "没有匹配的文件" : "工作区中没有可显示的文件"}
              </p>
            )}
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
                      fontFamily: codeFont,
                      fontSize: codeFontSize,
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
