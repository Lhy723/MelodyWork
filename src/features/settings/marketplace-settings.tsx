import {
  BotIcon,
  BracesIcon,
  CheckCircle2Icon,
  FolderIcon,
  GitBranchIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  StoreIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
  MarketplacePlugin,
  MarketplaceSource,
} from "@/domain/config";
import {
  addMarketplaceSource,
  deleteMarketplaceSource,
  installMelodyPlugin,
  listMarketplaceSources,
  saveMarketplaceSource,
  scanMarketplacePlugins,
  updateMelodyPlugin,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

const emptySource: MarketplaceSource = {
  name: "",
  kind: "git",
  location: "",
};

interface MarketplaceSettingsProps {
  cwd: string;
  onPluginsChanged: () => Promise<void> | void;
}

const marketplaceReference = (plugin: MarketplacePlugin) =>
  `${plugin.name}@${plugin.marketplace}`;

export function MarketplaceSettings({
  cwd,
  onPluginsChanged,
}: MarketplaceSettingsProps) {
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [draft, setDraft] = useState<MarketplaceSource>(emptySource);
  const [sourceInput, setSourceInput] = useState("");
  const [originalName, setOriginalName] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const pluginsByMarketplace = useMemo(() => {
    const grouped = new Map<string, MarketplacePlugin[]>();
    for (const plugin of plugins) {
      const group = grouped.get(plugin.marketplace) ?? [];
      group.push(plugin);
      grouped.set(plugin.marketplace, group);
    }
    for (const group of grouped.values()) {
      group.sort(
        (left, right) =>
          Number(left.status !== "installed") -
            Number(right.status !== "installed") ||
          left.name.localeCompare(right.name),
      );
    }
    return grouped;
  }, [plugins]);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const [nextSources, nextPlugins] = await Promise.all([
        listMarketplaceSources(),
        scanMarketplacePlugins(cwd, refresh),
      ]);
      setSources(nextSources);
      setPlugins(nextPlugins);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [cwd]);

  const openEditor = (source?: MarketplaceSource) => {
    setDraft(source ? { ...source } : { ...emptySource });
    setSourceInput("");
    setOriginalName(source?.name);
    setError(undefined);
    setNotice(undefined);
    setDialogOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const nextSources = originalName
        ? await saveMarketplaceSource(originalName, draft)
        : await addMarketplaceSource(sourceInput);
      setSources(nextSources);
      setDialogOpen(false);
      setLoading(true);
      setPlugins(await scanMarketplacePlugins(cwd, true));
      setNotice("Marketplace 已保存并完成插件扫描。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
      setLoading(false);
    }
  };

  const remove = async (name: string) => {
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const nextSources = await deleteMarketplaceSource(name);
      setSources(nextSources);
      setPlugins(await scanMarketplacePlugins(cwd));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const runPluginAction = async (plugin: MarketplacePlugin) => {
    const key = marketplaceReference(plugin);
    setBusyPlugin(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const result =
        plugin.status === "installed"
          ? await updateMelodyPlugin(cwd, plugin.name)
          : await installMelodyPlugin(cwd, key);
      const [nextPlugins] = await Promise.all([
        scanMarketplacePlugins(cwd),
        onPluginsChanged(),
      ]);
      setPlugins(nextPlugins);
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyPlugin(undefined);
    }
  };

  return (
    <section className="mt-7 border-t pt-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StoreIcon className="size-4 text-muted-foreground" />
            <h4 className="font-semibold text-base">Marketplace</h4>
            <Badge variant="secondary">{plugins.length} 个插件</Badge>
          </div>
          <p className="mt-1 text-muted-foreground text-sm">
            从 Git 仓库或本地目录发现、安装和更新 Melody 插件。
          </p>
        </div>
        <Button
          disabled={loading}
          onClick={() => void load(true)}
          size="sm"
          variant="outline"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
          刷新目录
        </Button>
        <Button onClick={() => openEditor()} size="sm">
          <PlusIcon />
          添加来源
        </Button>
      </div>

      {error ? (
        <p className="mt-3 rounded-lg bg-destructive/5 px-3 py-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}
      {notice ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-500/8 px-3 py-2 text-emerald-800 text-xs dark:text-emerald-300">
          <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" />
          <p className="whitespace-pre-wrap">{notice}</p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3">
        {sources.map((source) => {
          const SourceIcon =
            source.kind === "git" ? GitBranchIcon : FolderIcon;
          const sourcePlugins = pluginsByMarketplace.get(source.name) ?? [];
          return (
            <article className="overflow-hidden rounded-xl border" key={source.name}>
              <header className="flex min-h-14 items-center gap-3 bg-muted/20 px-3 py-2.5">
                <SourceIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium text-sm">{source.name}</p>
                    <Badge variant="outline">
                      {source.kind === "git" ? "Git" : "本地"}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      {sourcePlugins.length} 个插件
                    </span>
                  </div>
                  <p
                    className="mt-0.5 truncate text-muted-foreground text-xs"
                    title={source.location}
                  >
                    {source.location}
                    {source.branch ? ` · ${source.branch}` : ""}
                  </p>
                </div>
                <Button
                  aria-label={`编辑 ${source.name}`}
                  onClick={() => openEditor(source)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <PencilIcon />
                </Button>
                <Button
                  aria-label={`删除 ${source.name}`}
                  onClick={() => void remove(source.name)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </header>
              <div className="divide-y">
                {sourcePlugins.map((plugin) => (
                  <MarketplacePluginRow
                    busy={busyPlugin === marketplaceReference(plugin)}
                    disabled={busyPlugin !== undefined}
                    key={`${plugin.marketplace}:${plugin.name}`}
                    onAction={runPluginAction}
                    plugin={plugin}
                  />
                ))}
                {!loading && sourcePlugins.length === 0 ? (
                  <div className="px-4 py-6 text-center">
                    <PackageIcon className="mx-auto mb-2 size-4 text-muted-foreground" />
                    <p className="text-muted-foreground text-xs">
                      这个来源中没有发现插件。
                    </p>
                  </div>
                ) : null}
                {loading && sourcePlugins.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 px-4 py-6 text-muted-foreground text-xs">
                    <RefreshCwIcon className="size-3.5 animate-spin" />
                    正在扫描插件目录…
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
        {!loading && sources.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-10 text-center">
            <StoreIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="font-medium text-sm">尚未配置 Marketplace</p>
            <p className="mt-1 text-muted-foreground text-xs">
              添加来源后会立即扫描并显示其中的可用插件。
            </p>
          </div>
        ) : null}
      </div>

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {originalName ? "编辑 Marketplace" : "添加 Marketplace"}
            </DialogTitle>
            <DialogDescription>
              保存后会写入用户级 Melody 配置，并立即同步和扫描插件。
            </DialogDescription>
            {error ? (
              <p className="rounded-lg bg-destructive/5 px-3 py-2 text-destructive text-xs">
                {error}
              </p>
            ) : null}
          </DialogHeader>

          {originalName ? (
            <div className="grid gap-4">
              <label className="grid gap-1.5">
                <span className="font-medium text-xs">名称</span>
                <Input
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="例如 Team Plugins"
                  value={draft.name}
                />
              </label>
              <div className="grid gap-1.5">
                <span className="font-medium text-xs">来源类型</span>
                <div className="grid grid-cols-2 gap-2">
                  {(["git", "local"] as const).map((kind) => (
                    <Button
                      key={kind}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          kind,
                          branch:
                            kind === "git" ? current.branch : undefined,
                        }))
                      }
                      type="button"
                      variant={draft.kind === kind ? "secondary" : "outline"}
                    >
                      {kind === "git" ? <GitBranchIcon /> : <FolderIcon />}
                      {kind === "git" ? "Git 仓库" : "本地目录"}
                    </Button>
                  ))}
                </div>
              </div>
              <label className="grid gap-1.5">
                <span className="font-medium text-xs">
                  {draft.kind === "git" ? "Git 地址" : "目录路径"}
                </span>
                <Input
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      location: event.target.value,
                    }))
                  }
                  placeholder={
                    draft.kind === "git"
                      ? "https://github.com/org/plugins.git"
                      : "~/dev/plugins"
                  }
                  value={draft.location}
                />
              </label>
              {draft.kind === "git" ? (
                <label className="grid gap-1.5">
                  <span className="font-medium text-xs">分支（可选）</span>
                  <Input
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        branch: event.target.value,
                      }))
                    }
                    placeholder="main"
                    value={draft.branch ?? ""}
                  />
                </label>
              ) : null}
            </div>
          ) : (
            <label className="grid gap-1.5">
              <span className="font-medium text-xs">链接或路径</span>
              <Input
                autoFocus
                onChange={(event) => setSourceInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    sourceInput.trim() &&
                    !saving
                  ) {
                    event.preventDefault();
                    void save();
                  }
                }}
                placeholder="Git 链接、owner/repo 或本地目录"
                value={sourceInput}
              />
              <span className="text-muted-foreground text-xs">
                自动识别来源类型、名称和 GitHub 简写中的分支。
              </span>
            </label>
          )}

          <DialogFooter showCloseButton>
            <Button
              disabled={
                saving ||
                (originalName
                  ? !draft.name.trim() || !draft.location.trim()
                  : !sourceInput.trim())
              }
              onClick={() => void save()}
            >
              {saving ? "正在保存并扫描…" : "保存并扫描"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function MarketplacePluginRow({
  busy,
  disabled,
  onAction,
  plugin,
}: {
  busy: boolean;
  disabled: boolean;
  onAction: (plugin: MarketplacePlugin) => Promise<void>;
  plugin: MarketplacePlugin;
}) {
  const capabilities = [
    plugin.skillCount > 0
      ? {
          icon: SparklesIcon,
          label: `${plugin.skillCount} Skills`,
        }
      : undefined,
    plugin.hasAgents ? { icon: BotIcon, label: "Agents" } : undefined,
    plugin.hasHooks ? { icon: WebhookIcon, label: "Hooks" } : undefined,
    plugin.hasMcp ? { icon: BracesIcon, label: "MCP" } : undefined,
  ].filter(
    (
      item,
    ): item is {
      icon: typeof SparklesIcon;
      label: string;
    } => item !== undefined,
  );

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
        <PackageIcon className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-sm">{plugin.name}</p>
          {plugin.status === "installed" ? (
            <Badge variant="secondary">已安装</Badge>
          ) : null}
          {plugin.installedVersion || plugin.version ? (
            <span className="text-muted-foreground text-xs">
              v{plugin.installedVersion ?? plugin.version}
            </span>
          ) : null}
        </div>
        {plugin.description ? (
          <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
            {plugin.description}
          </p>
        ) : null}
        {capabilities.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {capabilities.map(({ icon: Icon, label }) => (
              <span
                className="flex items-center gap-1 text-muted-foreground text-[11px]"
                key={label}
              >
                <Icon className="size-3" />
                {label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <Button
        disabled={disabled}
        onClick={() => void onAction(plugin)}
        size="sm"
        variant={plugin.status === "installed" ? "outline" : "default"}
      >
        {busy ? <RefreshCwIcon className="animate-spin" /> : null}
        {busy
          ? plugin.status === "installed"
            ? "正在更新"
            : "正在安装"
          : plugin.status === "installed"
            ? "更新"
            : "安装"}
      </Button>
    </div>
  );
}
