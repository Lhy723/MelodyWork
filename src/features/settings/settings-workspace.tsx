import {
  BlocksIcon,
  CodeXmlIcon,
  RefreshCwIcon,
  SaveIcon,
  SettingsIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  MelodyConfigDocument,
  MelodyConfigScope,
  MelodyExtension,
  MelodyExtensionKind,
} from "@/domain/config";
import type { PermissionRule } from "@/domain/permission";
import {
  deletePermissionRule,
  listMelodyExtensions,
  listPermissionRules,
  readMelodyConfig,
  writeMelodyConfig,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

interface SettingsWorkspaceProps {
  cwd: string;
  projectId: string;
  onClose: () => void;
}

type SettingsPage = "configuration" | "extensions" | "permissions";

const kindLabel: Record<MelodyExtensionKind, string> = {
  skills: "Skills",
  plugins: "Plugins",
  hooks: "Hooks",
};

export function SettingsWorkspace({
  cwd,
  projectId,
  onClose,
}: SettingsWorkspaceProps) {
  const [page, setPage] = useState<SettingsPage>("configuration");
  const [scope, setScope] = useState<MelodyConfigScope>("user");
  const [document, setDocument] = useState<MelodyConfigDocument>();
  const [content, setContent] = useState("");
  const [extensions, setExtensions] = useState<MelodyExtension[]>([]);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const loadConfig = async (nextScope = scope) => {
    setLoading(true);
    setError(undefined);
    try {
      const nextDocument = await readMelodyConfig(nextScope, cwd);
      setDocument(nextDocument);
      setContent(nextDocument.content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const loadExtensions = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setExtensions(await listMelodyExtensions(cwd));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const loadRules = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setRules(await listPermissionRules(projectId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig(scope);
  }, [cwd, scope]);

  useEffect(() => {
    if (page === "extensions") {
      void loadExtensions();
    }
  }, [cwd, page]);

  useEffect(() => {
    if (page === "permissions") {
      void loadRules();
    }
  }, [page, projectId]);

  const removeRule = async (id: string) => {
    setError(undefined);
    try {
      await deletePermissionRule(projectId, id);
      setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await writeMelodyConfig(scope, cwd, content);
      setDocument((current) =>
        current ? { ...current, exists: true, content } : current,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const mcpServers = useMemo(
    () =>
      Array.from(
        content.matchAll(/^\[mcp_servers\.([^\]]+)\]/gm),
        (match) => match[1],
      ),
    [content],
  );

  return (
    <section className="absolute inset-0 z-40 flex min-h-0 flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-5">
        <SettingsIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-base">Melody settings</h2>
          <p className="truncate text-muted-foreground text-xs">
            Configure Melody Build for this device and workspace.
          </p>
        </div>
        <Button
          aria-label="Close settings"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>

      {error ? (
        <p className="border-b bg-destructive/5 px-5 py-2 text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 border-r p-3">
          <nav className="flex flex-col gap-1">
            <Button
              className="justify-start"
              onClick={() => setPage("configuration")}
              variant={page === "configuration" ? "secondary" : "ghost"}
            >
              <CodeXmlIcon />
              Configuration
            </Button>
            <Button
              className="justify-start"
              onClick={() => setPage("extensions")}
              variant={page === "extensions" ? "secondary" : "ghost"}
            >
              <BlocksIcon />
              Extensions
            </Button>
            <Button
              className="justify-start"
              onClick={() => setPage("permissions")}
              variant={page === "permissions" ? "secondary" : "ghost"}
            >
              <ShieldCheckIcon />
              Permissions
            </Button>
          </nav>
          <div className="mt-6 rounded-xl border bg-muted/30 p-3 text-muted-foreground text-xs leading-relaxed">
            User settings apply everywhere. Project settings live inside{" "}
            <code>.melody</code> and can travel with the repository.
          </div>
        </aside>

        {page === "configuration" ? (
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              {(["user", "project"] as const).map((item) => (
                <Button
                  key={item}
                  onClick={() => setScope(item)}
                  size="sm"
                  variant={scope === item ? "secondary" : "ghost"}
                >
                  {item === "user" ? "User" : "Project"}
                </Button>
              ))}
              <span className="min-w-0 flex-1 truncate px-2 text-muted-foreground text-xs">
                {document?.path}
              </span>
              {mcpServers.length > 0 ? (
                <Badge variant="outline">
                  {mcpServers.length} MCP{" "}
                  {mcpServers.length === 1 ? "server" : "servers"}
                </Badge>
              ) : null}
              <Button
                aria-label="Reload config"
                disabled={loading}
                onClick={() => void loadConfig()}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCwIcon className={cn(loading && "animate-spin")} />
              </Button>
              <Button
                disabled={
                  saving || !document || content === document.content
                }
                onClick={() => void save()}
                size="sm"
              >
                <SaveIcon />
                {saving ? "Saving" : "Save"}
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <p className="p-6 text-muted-foreground text-sm">
                    Loading configuration editor…
                  </p>
                }
              >
                <MonacoEditor
                  language="toml"
                  onChange={(value) => setContent(value ?? "")}
                  options={{
                    fontFamily:
                      '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
                    fontSize: 12,
                    minimap: { enabled: false },
                    padding: { top: 16 },
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    wordWrap: "on",
                  }}
                  theme="vs"
                  value={content}
                />
              </Suspense>
            </div>
          </section>
        ) : page === "extensions" ? (
          <section className="min-w-0 flex-1 overflow-y-auto p-6">
            <div className="mx-auto max-w-4xl">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-lg">
                    Skills, plugins and hooks
                  </h3>
                  <p className="mt-1 text-muted-foreground text-sm">
                    Discovered from user and project Melody directories.
                  </p>
                </div>
                <Button
                  disabled={loading}
                  onClick={() => void loadExtensions()}
                  variant="outline"
                >
                  <RefreshCwIcon className={cn(loading && "animate-spin")} />
                  Refresh
                </Button>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                {(["skills", "plugins", "hooks"] as const).map((kind) => {
                  const items = extensions.filter(
                    (extension) => extension.kind === kind,
                  );
                  return (
                    <section
                      className="min-h-56 rounded-2xl border bg-card p-4"
                      key={kind}
                    >
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium">{kindLabel[kind]}</h4>
                        <Badge variant="secondary">{items.length}</Badge>
                      </div>
                      <div className="mt-4 flex flex-col gap-2">
                        {items.map((item) => (
                          <div
                            className="rounded-xl border bg-background px-3 py-2.5"
                            key={`${item.scope}:${item.path}`}
                            title={item.path}
                          >
                            <p className="truncate font-medium text-sm">
                              {item.name}
                            </p>
                            <p className="mt-1 capitalize text-muted-foreground text-xs">
                              {item.scope}
                            </p>
                          </div>
                        ))}
                        {!loading && items.length === 0 ? (
                          <p className="py-8 text-center text-muted-foreground text-xs">
                            None discovered
                          </p>
                        ) : null}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          </section>
        ) : (
          <section className="min-w-0 flex-1 overflow-y-auto p-6">
            <div className="mx-auto max-w-4xl">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-lg">
                    Project permission rules
                  </h3>
                  <p className="mt-1 text-muted-foreground text-sm">
                    Exact tool calls approved or denied for this project are
                    applied automatically.
                  </p>
                </div>
                <Button
                  disabled={loading}
                  onClick={() => void loadRules()}
                  variant="outline"
                >
                  <RefreshCwIcon className={cn(loading && "animate-spin")} />
                  Refresh
                </Button>
              </div>

              <div className="mt-6 flex flex-col gap-3">
                {rules.map((rule) => (
                  <article
                    className="flex items-start gap-4 rounded-2xl border bg-card p-4"
                    key={rule.id}
                  >
                    <Badge
                      variant={
                        rule.decision === "allow"
                          ? "secondary"
                          : "destructive"
                      }
                    >
                      {rule.decision}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <h4 className="font-medium text-sm">{rule.title}</h4>
                      {rule.command ? (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-mono text-xs">
                          {rule.command}
                        </pre>
                      ) : null}
                    </div>
                    <Button
                      aria-label={`Delete ${rule.title} permission rule`}
                      onClick={() => void removeRule(rule.id)}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2Icon />
                    </Button>
                  </article>
                ))}
                {!loading && rules.length === 0 ? (
                  <div className="rounded-2xl border border-dashed py-16 text-center">
                    <ShieldCheckIcon className="mx-auto size-6 text-muted-foreground" />
                    <p className="mt-3 font-medium text-sm">
                      No project rules yet
                    </p>
                    <p className="mt-1 text-muted-foreground text-xs">
                      Choose “Allow for project” or “Deny for project” on a
                      permission request.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
