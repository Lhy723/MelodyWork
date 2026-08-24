import {
  ArrowLeftIcon,
  ChartNoAxesCombinedIcon,
  ChevronRightIcon,
  InfoIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MotionPage } from "@/components/motion/page-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toUserMessage } from "@/domain/app-error";
import type {
  MelodyConfigDocument,
  MelodyConfigPatch,
  MelodyConfigScope,
  MelodyConfigValue,
  MelodyExtension,
  MelodyExtensionKind,
} from "@/domain/config";
import type { PermissionRule } from "@/domain/permission";
import { MelodyCapabilityLifecycle } from "@/domain/melody-capability-lifecycle";
import { useAsyncOperation } from "@/hooks/use-async-operation";
import {
  deletePermissionRule,
  listInstalledMelodyPlugins,
  listMelodyExtensions,
  listMelodySkills,
  listPermissionRules,
  readMelodyConfig,
  setMelodyExtensionEnabled,
  updateMelodyConfig,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/agent-store";

import {
  ConfigurationForm,
  getConfigurationNavigation,
} from "./configuration-form";
import { AboutPage } from "./about-page";
import { MarketplaceSettings } from "./marketplace-settings";
import { PluginInstaller } from "./plugin-installer";
import { PluginDetailsView } from "./plugin-details";
import { SkillDetailsView } from "./skill-details";

const capabilityLifecycle = new MelodyCapabilityLifecycle({
  listDiscovered: listMelodyExtensions,
  listSkills: listMelodySkills,
  listInstalledPlugins: listInstalledMelodyPlugins,
  setEnabled: setMelodyExtensionEnabled,
});

const StatisticsPage = lazy(() =>
  import("./statistics-page").then((module) => ({
    default: module.StatisticsPage,
  })),
);

interface SettingsWorkspaceProps {
  cwd: string;
  projectId: string;
  projectName?: string;
  initialPage?: SettingsPage;
  macSafeArea?: boolean;
  onClose: () => void;
}

export type SettingsPage =
  | "configuration"
  | "statistics"
  | "skills"
  | "plugins"
  | "hooks"
  | "permissions"
  | "about";

const kindLabel: Record<MelodyExtensionKind, string> = {
  skills: "技能",
  plugins: "插件",
  hooks: "钩子",
};

const kindDescription: Record<MelodyExtensionKind, string> = {
  skills: "查看 Melody 运行时实际发现的技能，包括兼容目录、插件与额外路径。",
  plugins: "管理 Melody 插件以及兼容的 Claude Code 插件。",
  hooks: "查看在 Melody 生命周期事件中运行的钩子。",
};

const kindIcon = {
  skills: SparklesIcon,
  plugins: PuzzleIcon,
  hooks: WebhookIcon,
} satisfies Record<MelodyExtensionKind, typeof SparklesIcon>;

const skillSourceLabel = (skill: MelodyExtension) => {
  if (skill.pluginName) {
    return `插件 · ${skill.pluginName}`;
  }
  if (skill.source === "bundled") {
    return "内置";
  }
  if (skill.source === "server") {
    return "服务端";
  }
  return (
    {
      agents: "Agents",
      claude: "Claude",
      cursor: "Cursor",
      melody: "Melody",
      plugin: "插件",
    }[skill.provider] ?? skill.provider
  );
};

const skillSourceGroups = [
  {
    id: "melody",
    label: "Melody",
    description: "来自 Melody 用户目录或当前项目的技能。",
  },
  {
    id: "agents",
    label: "Agents",
    description: "来自通用 .agents 技能目录。",
  },
  {
    id: "plugin",
    label: "插件",
    description: "由当前启用的插件提供的技能。",
  },
  {
    id: "claude",
    label: "Claude",
    description: "通过 Claude Code 兼容层发现的技能。",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "通过 Cursor 兼容层发现的技能。",
  },
  {
    id: "managed",
    label: "内置与服务端",
    description: "由 Melody 内置或服务端同步的技能。",
  },
  {
    id: "other",
    label: "其他来源",
    description: "来自额外技能路径的其他技能。",
  },
] as const;

type SkillSourceGroupId = (typeof skillSourceGroups)[number]["id"];

const skillSourceGroupId = (skill: MelodyExtension): SkillSourceGroupId => {
  if (skill.source === "bundled" || skill.source === "server") {
    return "managed";
  }
  if (skill.source === "plugin" || skill.pluginName) {
    return "plugin";
  }
  if (
    skill.provider === "melody" ||
    skill.path.includes("/.melody/") ||
    skill.path.includes("\\.melody\\")
  ) {
    return "melody";
  }
  if (skill.provider === "agents") {
    return "agents";
  }
  if (skill.provider === "claude") {
    return "claude";
  }
  if (skill.provider === "cursor") {
    return "cursor";
  }
  return "other";
};

const settingsSidebarGroupClass =
  "mt-5 px-2 pb-1.5 font-semibold text-muted-foreground text-xs tracking-[0.04em]";
const settingsSidebarItemClass =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors";
const settingsSidebarItemState = (selected: boolean) =>
  selected
    ? "bg-muted font-medium text-foreground"
    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground";

export function SettingsWorkspace({
  cwd,
  projectId,
  projectName: selectedProjectName,
  initialPage = "configuration",
  macSafeArea = false,
  onClose,
}: SettingsWorkspaceProps) {
  const availableModels = useAgentStore((state) => state.availableModels);
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
  const [skillQuery, setSkillQuery] = useState("");
  const [skillStatus, setSkillStatus] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [selectedPlugin, setSelectedPlugin] = useState<MelodyExtension>();
  const [togglingExtensions, setTogglingExtensions] = useState<Set<string>>(
    () => new Set(),
  );
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const { state: configLoadState, run: runConfigLoad } = useAsyncOperation();
  const { state: extensionLoadState, run: runExtensionLoad } =
    useAsyncOperation();
  const { state: rulesLoadState, run: runRulesLoad } = useAsyncOperation();
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedSaveCountRef = useRef(0);
  const pendingConfigPatchesRef = useRef(configPatches);
  const scopeTabRefs = useRef<
    Record<MelodyConfigScope, HTMLButtonElement | null>
  >({ user: null, project: null });
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
          await updateMelodyConfig(scopeRef.current, cwdRef.current, pending);
        })
        .catch(() => undefined);
    },
    [],
  );

  const loadConfig = useCallback(
    (nextScope = scope) => {
      setError(undefined);
      void runConfigLoad(
        () => readMelodyConfig(nextScope, cwd),
        (nextDocument) => {
          setDocument(nextDocument);
          setConfigValues(nextDocument.values);
          setConfigPatches({});
        },
      ).catch(() => undefined);
    },
    [cwd, runConfigLoad, scope],
  );

  const loadExtensions = useCallback(() => {
    if (page !== "skills" && page !== "plugins" && page !== "hooks") {
      return;
    }
    const capabilityPage = page;
    setError(undefined);
    void runExtensionLoad(
      () => capabilityLifecycle.load(cwd, capabilityPage),
      setExtensions,
    ).catch(() => undefined);
  }, [cwd, page, runExtensionLoad]);

  const loadRules = useCallback(() => {
    setError(undefined);
    void runRulesLoad(() => listPermissionRules(projectId), setRules).catch(
      () => undefined,
    );
  }, [projectId, runRulesLoad]);

  const loading =
    page === "configuration"
      ? configLoadState.phase === "pending"
      : page === "permissions"
        ? rulesLoadState.phase === "pending"
        : page === "skills" || page === "plugins" || page === "hooks"
          ? extensionLoadState.phase === "pending"
          : false;
  const pageLoadError =
    page === "configuration"
      ? configLoadState.error
      : page === "permissions"
        ? rulesLoadState.error
        : page === "skills" || page === "plugins" || page === "hooks"
          ? extensionLoadState.error
          : undefined;
  const visibleError = pageLoadError ?? error;

  useEffect(() => {
    void loadConfig(scope);
  }, [loadConfig, scope]);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  useEffect(() => {
    if (page === "permissions") void loadRules();
  }, [loadRules, page]);

  const removeRule = async (id: string) => {
    setError(undefined);
    try {
      await deletePermissionRule(projectId, id);
      setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (reason) {
      setError(toUserMessage(reason));
    }
  };

  const toggleExtension = async (
    extension: MelodyExtension,
    enabled: boolean,
  ) => {
    const key = `${extension.scope}:${extension.kind}:${extension.path}`;
    setError(undefined);
    setTogglingExtensions((current) => new Set(current).add(key));
    setExtensions((current) =>
      current.map((item) =>
        item.path === extension.path &&
        item.scope === extension.scope &&
        item.kind === extension.kind
          ? { ...item, enabled }
          : item,
      ),
    );
    try {
      const refreshed = await capabilityLifecycle.changeEnabled(
        cwd,
        extension,
        enabled,
      );
      if (refreshed) {
        setExtensions(refreshed);
      }
    } catch (reason) {
      setExtensions((current) =>
        current.map((item) =>
          item.path === extension.path &&
          item.scope === extension.scope &&
          item.kind === extension.kind
            ? { ...item, enabled: extension.enabled }
            : item,
        ),
      );
      setError(toUserMessage(reason));
    } finally {
      setTogglingExtensions((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
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
        if (
          !existing ||
          typeof existing !== "object" ||
          Array.isArray(existing)
        ) {
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
            setError(toUserMessage(reason));
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
  const projectName = useMemo(() => {
    if (selectedProjectName) {
      return selectedProjectName;
    }
    const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
    return normalizedCwd.split("/").at(-1) || "当前项目";
  }, [cwd, selectedProjectName]);
  const scopeDescription =
    scope === "user"
      ? "影响此设备上的所有任务"
      : "仅显示可写入当前项目的配置项";
  const configPath = document?.path ?? ".melody/config.toml";
  const saveStatus = saving
    ? "正在保存…"
    : Object.keys(configPatches).length > 0
      ? "等待保存…"
      : "已自动保存";
  const scopeLocked = saving || Object.keys(configPatches).length > 0;
  const changeScope = (nextScope: MelodyConfigScope) => {
    if (!scopeLocked && nextScope !== scope) {
      setScope(nextScope);
    }
  };
  const extensionKind: MelodyExtensionKind | undefined =
    page === "skills" || page === "plugins" || page === "hooks"
      ? page
      : undefined;
  const kindExtensions = useMemo(
    () =>
      extensionKind
        ? extensions.filter((extension) => extension.kind === extensionKind)
        : [],
    [extensionKind, extensions],
  );
  const visibleExtensions = useMemo(() => {
    if (extensionKind !== "skills") {
      return kindExtensions;
    }
    const query = skillQuery.trim().toLocaleLowerCase();
    return kindExtensions.filter((skill) => {
      if (
        skillStatus === "enabled"
          ? !skill.enabled
          : skillStatus === "disabled"
            ? skill.enabled
            : false
      ) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [
        skill.name,
        skill.description,
        skill.pluginName,
        skill.provider,
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [extensionKind, kindExtensions, skillQuery, skillStatus]);
  const visibleExtensionGroups = useMemo(() => {
    if (extensionKind !== "skills") {
      return [
        {
          id: extensionKind ?? "extensions",
          label: undefined,
          description: undefined,
          items: visibleExtensions,
        },
      ];
    }
    const grouped = new Map<SkillSourceGroupId, MelodyExtension[]>();
    for (const skill of visibleExtensions) {
      const groupId = skillSourceGroupId(skill);
      grouped.set(groupId, [...(grouped.get(groupId) ?? []), skill]);
    }
    return skillSourceGroups.flatMap((group) => {
      const items = grouped.get(group.id);
      return items ? [{ ...group, items }] : [];
    });
  }, [extensionKind, visibleExtensions]);
  const ExtensionIcon = extensionKind ? kindIcon[extensionKind] : SparklesIcon;
  const settingsViewKey = selectedPlugin
    ? `${page}:${selectedPlugin.path}`
    : page === "configuration"
      ? `${page}:${scope}:${activeConfigSection}`
      : page;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <header
        className={cn(
          "harness-window-titlebar sidebar-aware-header flex shrink-0 items-center gap-3 border-b pr-4",
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
        <div className="min-w-0 flex-1" data-tauri-drag-region>
          <h2 className="font-semibold text-base">设置</h2>
        </div>
      </header>

      {visibleError ? (
        <p
          aria-live="assertive"
          className="motion-view-enter border-b bg-destructive/5 px-5 py-2 text-destructive text-sm"
          role="alert"
        >
          {visibleError}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 overflow-y-auto border-r px-3 py-4">
          <div className="mb-4 border-b pb-4">
            <p className="px-1 pb-2 font-semibold text-muted-foreground text-xs tracking-[0.04em]">
              配置范围
            </p>
            <div
              aria-label="配置范围"
              className="grid grid-cols-2 rounded-lg bg-muted p-1"
              role="radiogroup"
            >
              {(["user", "project"] as const).map((item) => (
                <Button
                  aria-checked={scope === item}
                  className={cn(
                    "h-8 w-full justify-center rounded-md px-2 text-xs",
                    scope === item
                      ? "bg-background text-foreground shadow-sm hover:bg-background"
                      : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                  )}
                  disabled={scopeLocked}
                  key={item}
                  onClick={() => changeScope(item)}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "ArrowLeft" &&
                      event.key !== "ArrowRight"
                    ) {
                      return;
                    }
                    event.preventDefault();
                    const nextScope = item === "user" ? "project" : "user";
                    changeScope(nextScope);
                    scopeTabRefs.current[nextScope]?.focus();
                  }}
                  ref={(element) => {
                    scopeTabRefs.current[item] = element;
                  }}
                  role="radio"
                  tabIndex={scope === item ? 0 : -1}
                  type="button"
                  variant="ghost"
                >
                  {item === "user" ? "应用" : "当前项目"}
                </Button>
              ))}
            </div>
            <p className="mt-2 px-1 text-muted-foreground text-xs">
              {scopeDescription}
            </p>
          </div>
          <nav aria-label="设置分类">
            <button
              aria-current={page === "statistics" ? "page" : undefined}
              className={cn(
                "mb-4",
                settingsSidebarItemClass,
                settingsSidebarItemState(page === "statistics"),
              )}
              onClick={() => {
                setPage("statistics");
                setSelectedPlugin(undefined);
              }}
              type="button"
            >
              <ChartNoAxesCombinedIcon className="size-3.5" />
              统计
            </button>
            <p className={settingsSidebarGroupClass}>
              {scope === "project" ? "项目配置" : "应用配置"}
            </p>
            <div className="flex flex-col gap-0.5">
              {primaryConfigNavigation.map((item) => {
                const Icon = item.icon;
                const selected =
                  page === "configuration" && activeConfigSection === item.id;
                return (
                  <button
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      settingsSidebarItemClass,
                      settingsSidebarItemState(selected),
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

            <p className={settingsSidebarGroupClass}>扩展</p>
            <div className="flex flex-col gap-0.5">
              {extensionConfigNavigation.map((item) => {
                const Icon = item.icon;
                const selected =
                  page === "configuration" && activeConfigSection === item.id;
                return (
                  <button
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      settingsSidebarItemClass,
                      settingsSidebarItemState(selected),
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
                      settingsSidebarItemClass,
                      settingsSidebarItemState(selected),
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

            <p className={settingsSidebarGroupClass}>安全</p>
            <button
              aria-current={page === "permissions" ? "page" : undefined}
              className={cn(
                settingsSidebarItemClass,
                settingsSidebarItemState(page === "permissions"),
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

            <p className={settingsSidebarGroupClass}>关于</p>
            <button
              aria-current={page === "about" ? "page" : undefined}
              className={cn(
                settingsSidebarItemClass,
                settingsSidebarItemState(page === "about"),
              )}
              onClick={() => {
                setPage("about");
                setSelectedPlugin(undefined);
              }}
              type="button"
            >
              <InfoIcon className="size-3.5" />
              关于 MelodyWork
            </button>
          </nav>
        </aside>

        <AnimatePresence initial={false} mode="wait">
          <MotionPage
            className="flex min-w-0 flex-1 flex-col"
            key={settingsViewKey}
          >
            {page === "statistics" ? (
              <Suspense
                fallback={
                  <p className="min-w-0 flex-1 p-8 text-muted-foreground text-sm">
                    正在加载统计…
                  </p>
                }
              >
                <StatisticsPage cwd={cwd} />
              </Suspense>
            ) : page === "configuration" ? (
              <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
                  <div className="min-w-0 flex-1 px-2">
                    <p className="font-medium text-sm">
                      {scope === "user"
                        ? "应用设置"
                        : `当前项目：${projectName}`}
                    </p>
                    <p
                      className="truncate text-muted-foreground text-xs"
                      title={scope === "project" ? configPath : undefined}
                    >
                      {scope === "user" ? "影响此设备上的所有任务" : configPath}
                    </p>
                  </div>
                  {scope === "project" && mcpServers.length > 0 ? (
                    <Badge variant="outline">
                      {mcpServers.length} MCP 个服务器
                    </Badge>
                  ) : null}
                  {scope === "project" ? (
                    <Button
                      aria-label="重新加载项目配置"
                      disabled={loading || scopeLocked}
                      onClick={() => void loadConfig()}
                      size="sm"
                      title="重新加载项目配置"
                      variant="ghost"
                    >
                      <RefreshCwIcon
                        className={cn(loading && "animate-spin")}
                      />
                      重新加载
                    </Button>
                  ) : null}
                  <Badge variant="secondary">{saveStatus}</Badge>
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
                  <p className="p-6 text-muted-foreground text-sm">
                    正在加载设置…
                  </p>
                ) : (
                  <ConfigurationForm
                    availableModels={availableModels}
                    onChange={changeConfig}
                    sectionId={activeConfigSection}
                    scope={scope}
                    values={configValues}
                  />
                )}
              </section>
            ) : page === "about" ? (
              <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                <AboutPage />
              </section>
            ) : extensionKind ? (
              <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
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
                  ) : extensionKind === "skills" && selectedPlugin ? (
                    <SkillDetailsView
                      cwd={cwd}
                      onBack={() => setSelectedPlugin(undefined)}
                      onDeleted={async () => {
                        setSelectedPlugin(undefined);
                        await loadExtensions();
                      }}
                      skill={selectedPlugin}
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
                              {extensionKind === "skills" &&
                              visibleExtensions.length !== kindExtensions.length
                                ? `${visibleExtensions.length} / ${kindExtensions.length}`
                                : visibleExtensions.length}
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
                          <RefreshCwIcon
                            className={cn(loading && "animate-spin")}
                          />
                          刷新
                        </Button>
                      </div>

                      {extensionKind === "skills" ? (
                        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
                          <div className="relative min-w-0 flex-1">
                            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground" />
                            <Input
                              aria-label="搜索技能"
                              className="pl-9"
                              onChange={(event) =>
                                setSkillQuery(event.target.value)
                              }
                              placeholder="搜索技能名称、说明或来源"
                              value={skillQuery}
                            />
                          </div>
                          <div
                            aria-label="技能状态筛选"
                            className="flex items-center rounded-lg border bg-muted/30 p-0.5"
                            role="group"
                          >
                            {(
                              [
                                ["all", "全部"],
                                ["enabled", "已启用"],
                                ["disabled", "不可用"],
                              ] as const
                            ).map(([value, label]) => (
                              <Button
                                aria-pressed={skillStatus === value}
                                className="h-7 px-3"
                                key={value}
                                onClick={() => setSkillStatus(value)}
                                size="sm"
                                variant={
                                  skillStatus === value ? "secondary" : "ghost"
                                }
                              >
                                {label}
                              </Button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div className="mt-6 grid gap-7">
                        {visibleExtensionGroups.map((group) => (
                          <section key={group.id}>
                            {extensionKind === "skills" ? (
                              <div className="mb-3">
                                <div className="flex items-center gap-2">
                                  <h4 className="font-medium text-sm">
                                    {group.label}
                                  </h4>
                                  <Badge variant="secondary">
                                    {group.items.length}
                                  </Badge>
                                </div>
                                <p className="mt-0.5 text-muted-foreground text-xs">
                                  {group.description}
                                </p>
                              </div>
                            ) : null}
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                              {group.items.map((item, index) => {
                                const toggleKey = `${item.scope}:${item.kind}:${item.path}`;
                                const canInspect =
                                  extensionKind === "plugins" ||
                                  extensionKind === "skills";
                                const canToggle =
                                  extensionKind === "plugins" ||
                                  (extensionKind === "skills" &&
                                    item.compatibilityStatus !== "disabled");
                                return (
                                  <article
                                    className={cn(
                                      "motion-list-item flex min-w-0 items-start gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors",
                                      !item.enabled &&
                                        "bg-muted/30 text-muted-foreground",
                                    )}
                                    key={`${item.scope}:${item.path}`}
                                    style={{
                                      animationDelay: `${Math.min(index, 6) * 24}ms`,
                                    }}
                                    title={item.path}
                                  >
                                    <button
                                      className="min-w-0 flex-1 text-left"
                                      disabled={!canInspect}
                                      onClick={() => setSelectedPlugin(item)}
                                      type="button"
                                    >
                                      <div className="flex items-center gap-2">
                                        <p className="min-w-0 flex-1 truncate font-medium text-sm">
                                          {item.name}
                                        </p>
                                        {canInspect ? (
                                          <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                                        ) : null}
                                      </div>
                                      <div className="mt-2 flex items-center gap-2">
                                        <Badge variant="outline">
                                          {item.scope === "user"
                                            ? "用户"
                                            : "项目"}
                                        </Badge>
                                        {extensionKind === "skills" ? (
                                          <Badge variant="secondary">
                                            {skillSourceLabel(item)}
                                          </Badge>
                                        ) : null}
                                        {extensionKind === "plugins" ? (
                                          <Badge variant="secondary">
                                            {item.provider === "claude"
                                              ? "Claude Code"
                                              : "Melody"}
                                          </Badge>
                                        ) : null}
                                        {item.compatibilityStatus ===
                                        "disabled" ? (
                                          <Badge variant="secondary">
                                            兼容性已关闭
                                          </Badge>
                                        ) : !item.enabled ? (
                                          <Badge variant="secondary">
                                            已停用
                                          </Badge>
                                        ) : null}
                                      </div>
                                      {extensionKind === "skills" &&
                                      item.description ? (
                                        <p className="mt-2 line-clamp-2 text-muted-foreground text-xs leading-5">
                                          {item.description}
                                        </p>
                                      ) : (
                                        <p className="mt-2 truncate text-muted-foreground text-xs">
                                          {item.path}
                                        </p>
                                      )}
                                    </button>
                                    {canInspect ? (
                                      <Switch
                                        aria-label={`${item.enabled ? "停用" : "启用"}${kindLabel[extensionKind]} ${item.name}`}
                                        checked={item.enabled}
                                        className="mt-0.5"
                                        disabled={
                                          !canToggle ||
                                          togglingExtensions.has(toggleKey)
                                        }
                                        title={
                                          canToggle
                                            ? undefined
                                            : "请先在兼容性设置中启用此来源"
                                        }
                                        onCheckedChange={(checked) =>
                                          void toggleExtension(item, checked)
                                        }
                                      />
                                    ) : null}
                                  </article>
                                );
                              })}
                            </div>
                          </section>
                        ))}
                      </div>
                      {!loading && visibleExtensions.length === 0 ? (
                        <div className="motion-view-enter mt-6 rounded-2xl border border-dashed py-16 text-center">
                          <ExtensionIcon className="mx-auto size-6 text-muted-foreground" />
                          <p className="mt-3 font-medium text-sm">
                            {extensionKind === "skills" &&
                            (skillQuery.trim() || skillStatus !== "all")
                              ? "没有匹配的技能"
                              : `暂未发现${kindLabel[extensionKind]}`}
                          </p>
                          <p className="mt-1 text-muted-foreground text-xs">
                            {extensionKind === "skills" &&
                            (skillQuery.trim() || skillStatus !== "all")
                              ? "尝试调整关键词或状态筛选。"
                              : extensionKind === "plugins"
                                ? "Melody 会自动扫描 .melody/plugins 和 .claude/plugins。"
                                : "技能清单直接来自 Melody 运行时。"}
                          </p>
                        </div>
                      ) : null}
                      {extensionKind === "plugins" ? (
                        <MarketplaceSettings
                          cwd={cwd}
                          onPluginsChanged={loadExtensions}
                        />
                      ) : null}
                    </>
                  )}
                </div>
              </section>
            ) : (
              <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
                <div className="mx-auto max-w-4xl">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold text-lg">项目权限规则</h3>
                      <p className="mt-1 text-muted-foreground text-sm">
                        已为此项目允许或拒绝的精确工具调用会自动应用。
                      </p>
                    </div>
                    <Button
                      disabled={loading}
                      onClick={() => void loadRules()}
                      variant="outline"
                    >
                      <RefreshCwIcon
                        className={cn(loading && "animate-spin")}
                      />
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
                        <p className="mt-3 font-medium text-sm">暂无项目规则</p>
                        <p className="mt-1 text-muted-foreground text-xs">
                          在权限请求中选择“对项目允许”或“对项目拒绝”即可创建规则。
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
            )}
          </MotionPage>
        </AnimatePresence>
      </div>
    </section>
  );
}
