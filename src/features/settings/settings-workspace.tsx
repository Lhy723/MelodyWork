import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  MelodyConfigDocument,
  MelodyConfigPatch,
  MelodyConfigScope,
  MelodyConfigValue,
  MelodyExtension,
  MelodyExtensionKind,
} from "@/domain/config";
import type { PermissionRule } from "@/domain/permission";
import {
  deletePermissionRule,
  listInstalledMelodyPlugins,
  listMelodyExtensions,
  listPermissionRules,
  readMelodyConfig,
  updateMelodyConfig,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

import {
  ConfigurationForm,
  getConfigurationNavigation,
} from "./configuration-form";
import { MarketplaceSettings } from "./marketplace-settings";
import { PluginInstaller } from "./plugin-installer";
import { PluginDetailsView } from "./plugin-details";

interface SettingsWorkspaceProps {
  cwd: string;
  projectId: string;
  initialPage?: SettingsPage;
  macSafeArea?: boolean;
  onClose: () => void;
}

export type SettingsPage =
  | "configuration"
  | "skills"
  | "plugins"
  | "hooks"
  | "permissions";

const kindLabel: Record<MelodyExtensionKind, string> = {
  skills: "技能",
  plugins: "插件",
  hooks: "钩子",
};

const kindDescription: Record<MelodyExtensionKind, string> = {
  skills: "查看从用户和项目 Melody 目录中发现的技能。",
  plugins: "管理 Melody 插件以及兼容的 Claude Code 插件。",
  hooks: "查看在 Melody 生命周期事件中运行的钩子。",
};

const kindIcon = {
  skills: SparklesIcon,
  plugins: PuzzleIcon,
  hooks: WebhookIcon,
} satisfies Record<MelodyExtensionKind, typeof SparklesIcon>;

export function SettingsWorkspace({
  cwd,
  projectId,
  initialPage = "configuration",
  macSafeArea = false,
  onClose,
}: SettingsWorkspaceProps) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [scope, setScope] = useState<MelodyConfigScope>("user");
  const [configSection, setConfigSection] = useState("general");
  const [document, setDocument] = useState<MelodyConfigDocument>();
  const [configValues, setConfigValues] = useState<
    Record<string, MelodyConfigValue>
  >({});
  const [configPatches, setConfigPatches] = useState<
    Record<string, MelodyConfigPatch>
  >({});
  const [extensions, setExtensions] = useState<MelodyExtension[]>([]);
  const [selectedPlugin, setSelectedPlugin] = useState<MelodyExtension>();
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedSaveCountRef = useRef(0);
  const pendingConfigPatchesRef = useRef(configPatches);
  const scopeRef = useRef(scope);
  const cwdRef = useRef(cwd);
  pendingConfigPatchesRef.current = configPatches;
  scopeRef.current = scope;
  cwdRef.current = cwd;

  useEffect(() => {
    setPage(initialPage);
    setSelectedPlugin(undefined);
  }, [initialPage]);

  useEffect(
    () => () => {
      const pending = Object.values(pendingConfigPatchesRef.current);
      if (pending.length === 0) {
        return;
      }
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await updateMelodyConfig(
            scopeRef.current,
            cwdRef.current,
            pending,
          );
        })
        .catch(() => undefined);
    },
    [],
  );

  const loadConfig = async (nextScope = scope) => {
    setLoading(true);
    setError(undefined);
    try {
      const nextDocument = await readMelodyConfig(nextScope, cwd);
      setDocument(nextDocument);
      setConfigValues(nextDocument.values);
      setConfigPatches({});
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
      const [discovered, installed] = await Promise.all([
        listMelodyExtensions(cwd),
        page === "plugins" ? listInstalledMelodyPlugins() : [],
      ]);
      const merged = [...installed, ...discovered].filter(
        (extension, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.kind === extension.kind &&
              candidate.path === extension.path,
          ) === index,
      );
      setExtensions(merged);
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
    if (
      page === "skills" ||
      page === "plugins" ||
      page === "hooks"
    ) {
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

  const changeConfig = (path: string[], value: MelodyConfigValue) => {
    setConfigValues((current) => {
      const next = structuredClone(current);
      const [leaf] = path.slice(-1);
      if (!leaf) {
        return current;
      }
      let table = next;
      for (const key of path.slice(0, -1)) {
        const existing = table[key];
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
          table[key] = {};
        }
        table = table[key] as Record<string, MelodyConfigValue>;
      }
      if (value === null) {
        delete table[leaf];
      } else {
        table[leaf] = value;
      }
      return next;
    });
    setConfigPatches((current) => {
      const key = path.join("\u0000");
      const next = { ...current };
      if (
        value === null ||
        (typeof value === "object" && !Array.isArray(value))
      ) {
        for (const existingKey of Object.keys(next)) {
          if (existingKey.startsWith(`${key}\u0000`)) {
            delete next[existingKey];
          }
        }
      }
      next[key] = { path, value };
      return next;
    });
  };

  useEffect(() => {
    const entries = Object.entries(configPatches);
    if (entries.length === 0) {
      return;
    }
    const batch = Object.fromEntries(entries);
    const timer = window.setTimeout(() => {
      queuedSaveCountRef.current += 1;
      setSaving(true);
      setError(undefined);
      const operation = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            const nextDocument = await updateMelodyConfig(
              scope,
              cwd,
              Object.values(batch),
            );
            setDocument(nextDocument);
            setConfigPatches((current) => {
              const next = { ...current };
              for (const [key, patch] of entries) {
                if (current[key] === patch) {
                  delete next[key];
                }
              }
              return next;
            });
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        })
        .finally(() => {
          queuedSaveCountRef.current -= 1;
          if (queuedSaveCountRef.current === 0) {
            setSaving(false);
          }
        });
      saveQueueRef.current = operation;
    }, 300);
    return () => window.clearTimeout(timer);
  }, [configPatches, cwd, scope]);

  const mcpServers = useMemo(() => {
    const servers = configValues.mcp_servers;
    return servers && typeof servers === "object" && !Array.isArray(servers)
      ? Object.keys(servers)
      : [];
  }, [configValues]);
  const configNavigation = useMemo(
    () => getConfigurationNavigation(scope),
    [scope],
  );
  const extensionConfigNavigation = configNavigation.filter(
    (item) => item.id === "tools" || item.id === "mcp",
  );
  const primaryConfigNavigation = configNavigation.filter(
    (item) => item.id !== "tools" && item.id !== "mcp",
  );
  const activeConfigSection =
    configNavigation.find((item) => item.id === configSection)?.id ??
    configNavigation[0]?.id ??
    "general";
  const isApplicationSettings =
    activeConfigSection === "general" ||
    activeConfigSection === "appearance";
  const extensionKind: MelodyExtensionKind | undefined =
    page === "skills" || page === "plugins" || page === "hooks"
      ? page
      : undefined;
  const visibleExtensions = extensionKind
    ? extensions.filter((extension) => extension.kind === extensionKind)
    : [];
  const ExtensionIcon = extensionKind
    ? kindIcon[extensionKind]
    : SparklesIcon;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <header
        className={cn(
          "sidebar-aware-header flex h-8 shrink-0 items-center gap-3 border-b pr-4",
          macSafeArea ? "pl-24" : "pl-2",
        )}
        data-tauri-drag-region
      >
        <Button
          aria-label="返回对话"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <SettingsIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1" data-tauri-drag-region>
          <h2 className="font-semibold text-base">设置</h2>
        </div>
      </header>

      {error ? (
        <p className="motion-view-enter border-b bg-destructive/5 px-5 py-2 text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 overflow-y-auto border-r px-3 py-4">
          <nav aria-label="设置分类">
            <div className="flex items-center gap-2 px-2 pb-1.5 text-muted-foreground">
              <CodeXmlIcon className="size-3.5" />
              <p className="font-medium text-xs">配置</p>
            </div>
            <div className="flex flex-col gap-0.5">
              {primaryConfigNavigation.map((item) => {
                const Icon = item.icon;
                const selected =
                  page === "configuration" &&
                  activeConfigSection === item.id;
                return (
                  <button
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
                      selected
                        ? "bg-[#eff0f0] text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    key={item.id}
                    onClick={() => {
                      setConfigSection(item.id);
                      setPage("configuration");
                      setSelectedPlugin(undefined);
                    }}
                    type="button"
                  >
                    <Icon className="size-3.5" />
                    {item.label}
                  </button>
                );
              })}
            </div>

            <p className="mt-5 px-2 pb-1.5 font-medium text-muted-foreground text-xs">
              扩展
            </p>
            <div className="flex flex-col gap-0.5">
              {extensionConfigNavigation.map((item) => {
                const Icon = item.icon;
                const selected =
                  page === "configuration" &&
                  activeConfigSection === item.id;
                return (
                  <button
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
                      selected
                        ? "bg-[#eff0f0] text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    key={item.id}
                    onClick={() => {
                      setConfigSection(item.id);
                      setPage("configuration");
                      setSelectedPlugin(undefined);
                    }}
                    type="button"
                  >
                    <Icon className="size-3.5" />
                    {item.label}
                  </button>
                );
              })}
              {(["skills", "plugins", "hooks"] as const).map((kind) => {
                const Icon = kindIcon[kind];
                const selected = page === kind;
                return (
                  <button
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
                      selected
                        ? "bg-[#eff0f0] text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    key={kind}
                    onClick={() => {
                      setPage(kind);
                      setSelectedPlugin(undefined);
                    }}
                    type="button"
                  >
                    <Icon className="size-3.5" />
                    {kindLabel[kind]}
                  </button>
                );
              })}
            </div>

            <p className="mt-5 px-2 pb-1.5 font-medium text-muted-foreground text-xs">
              安全
            </p>
            <button
              aria-current={page === "permissions" ? "page" : undefined}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
                page === "permissions"
                  ? "bg-[#eff0f0] text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onClick={() => {
                setPage("permissions");
                setSelectedPlugin(undefined);
              }}
              type="button"
            >
              <ShieldCheckIcon className="size-3.5" />
              权限
            </button>
          </nav>
        </aside>

        {page === "configuration" ? (
          <section
            className="motion-view-enter flex min-w-0 flex-1 flex-col"
            key="configuration"
          >
            <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              {(["user", "project"] as const).map((item) => (
                <Button
                  disabled={
                    saving || Object.keys(configPatches).length > 0
                  }
                  key={item}
                  onClick={() => setScope(item)}
                  size="sm"
                  variant={scope === item ? "secondary" : "ghost"}
                >
                  {item === "user" ? "用户" : "项目"}
                </Button>
              ))}
              {isApplicationSettings ? (
                <>
                  <span className="min-w-0 flex-1 px-2 text-muted-foreground text-xs">
                    MelodyWork 应用偏好
                  </span>
                  <Badge variant="secondary">自动保存</Badge>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate px-2 text-muted-foreground text-xs">
                    {document?.path}
                  </span>
                  {mcpServers.length > 0 ? (
                    <Badge variant="outline">
                      {mcpServers.length} MCP 个服务器
                    </Badge>
                  ) : null}
                  <Button
                    aria-label="重新加载配置"
                    disabled={
                      loading ||
                      saving ||
                      Object.keys(configPatches).length > 0
                    }
                    onClick={() => void loadConfig()}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <RefreshCwIcon className={cn(loading && "animate-spin")} />
                  </Button>
                  <Badge variant="secondary">
                    {saving
                      ? "正在保存…"
                      : Object.keys(configPatches).length > 0
                        ? "等待保存…"
                        : "已自动保存"}
                  </Badge>
                </>
              )}
            </div>
            {document?.parseError ? (
              <div className="m-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                <p className="font-medium text-destructive text-sm">
                  配置文件包含无效的 TOML
                </p>
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground text-xs">
                  {document.parseError}
                </p>
                <p className="mt-2 text-muted-foreground text-xs">
                  请先在外部编辑器中修复该文件，然后重新加载。
                </p>
              </div>
            ) : loading ? (
              <p className="p-6 text-muted-foreground text-sm">正在加载设置…</p>
            ) : (
              <ConfigurationForm
                onChange={changeConfig}
                sectionId={activeConfigSection}
                scope={scope}
                values={configValues}
              />
            )}
          </section>
        ) : extensionKind ? (
          <section
            className="motion-view-enter min-w-0 flex-1 overflow-y-auto p-6"
            key={extensionKind}
          >
            <div className="mx-auto max-w-4xl">
              {extensionKind === "plugins" && selectedPlugin ? (
                <PluginDetailsView
                  cwd={cwd}
                  onBack={() => setSelectedPlugin(undefined)}
                  onDeleted={async () => {
                    setSelectedPlugin(undefined);
                    await loadExtensions();
                  }}
                  plugin={selectedPlugin}
                />
              ) : (
                <>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <ExtensionIcon className="size-5 text-muted-foreground" />
                    <h3 className="font-semibold text-lg">
                      {kindLabel[extensionKind]}
                    </h3>
                    <Badge variant="secondary">
                      {visibleExtensions.length}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground text-sm">
                    {kindDescription[extensionKind]}
                  </p>
                </div>
                {extensionKind === "plugins" ? (
                  <PluginInstaller
                    cwd={cwd}
                    onInstalled={loadExtensions}
                  />
                ) : null}
                <Button
                  disabled={loading}
                  onClick={() => void loadExtensions()}
                  variant="outline"
                >
                  <RefreshCwIcon className={cn(loading && "animate-spin")} />
                  刷新
                </Button>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {visibleExtensions.map((item, index) => (
                  <button
                    className={cn(
                      "motion-list-item min-w-0 rounded-xl border bg-card px-4 py-3 text-left",
                      extensionKind === "plugins" &&
                        "transition-colors hover:bg-muted/50",
                    )}
                    disabled={extensionKind !== "plugins"}
                    key={`${item.scope}:${item.path}`}
                    onClick={() => setSelectedPlugin(item)}
                    style={{
                      animationDelay: `${Math.min(index, 6) * 24}ms`,
                    }}
                    title={item.path}
                    type="button"
                  >
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate font-medium text-sm">
                        {item.name}
                      </p>
                      {extensionKind === "plugins" ? (
                        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                      ) : null}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Badge variant="outline">
                        {item.scope === "user" ? "用户" : "项目"}
                      </Badge>
                      {extensionKind === "plugins" ? (
                        <Badge variant="secondary">
                          {item.provider === "claude"
                            ? "Claude Code"
                            : "Melody"}
                        </Badge>
                      ) : null}
                      <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                        {item.path}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
              {!loading && visibleExtensions.length === 0 ? (
                <div className="motion-view-enter mt-6 rounded-2xl border border-dashed py-16 text-center">
                  <ExtensionIcon className="mx-auto size-6 text-muted-foreground" />
                  <p className="mt-3 font-medium text-sm">
                    暂未发现{kindLabel[extensionKind]}
                  </p>
                  <p className="mt-1 text-muted-foreground text-xs">
                    {extensionKind === "plugins"
                      ? "Melody 会自动扫描 .melody/plugins 和 .claude/plugins。"
                      : "Melody 会自动扫描用户和项目目录。"}
                  </p>
                </div>
              ) : null}
              {extensionKind === "plugins" ? <MarketplaceSettings /> : null}
                </>
              )}
            </div>
          </section>
        ) : (
          <section
            className="motion-view-enter min-w-0 flex-1 overflow-y-auto p-6"
            key="permissions"
          >
            <div className="mx-auto max-w-4xl">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-lg">
                    项目权限规则
                  </h3>
                  <p className="mt-1 text-muted-foreground text-sm">
                    已为此项目允许或拒绝的精确工具调用会自动应用。
                  </p>
                </div>
                <Button
                  disabled={loading}
                  onClick={() => void loadRules()}
                  variant="outline"
                >
                  <RefreshCwIcon className={cn(loading && "animate-spin")} />
                  刷新
                </Button>
              </div>

              <div className="mt-6 flex flex-col gap-3">
                {rules.map((rule, index) => (
                  <article
                    className="motion-list-item flex items-start gap-4 rounded-2xl border bg-card p-4"
                    key={rule.id}
                    style={{
                      animationDelay: `${Math.min(index, 6) * 24}ms`,
                    }}
                  >
                    <Badge
                      variant={
                        rule.decision === "allow"
                          ? "secondary"
                          : "destructive"
                      }
                    >
                      {rule.decision === "allow" ? "允许" : "拒绝"}
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
                      aria-label={`删除“${rule.title}”权限规则`}
                      onClick={() => void removeRule(rule.id)}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2Icon />
                    </Button>
                  </article>
                ))}
                {!loading && rules.length === 0 ? (
                  <div className="motion-view-enter rounded-2xl border border-dashed py-16 text-center">
                    <ShieldCheckIcon className="mx-auto size-6 text-muted-foreground" />
                    <p className="mt-3 font-medium text-sm">
                      暂无项目规则
                    </p>
                    <p className="mt-1 text-muted-foreground text-xs">
                      在权限请求中选择“对项目允许”或“对项目拒绝”即可创建规则。
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
