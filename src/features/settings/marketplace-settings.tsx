import {
  CheckCircle2Icon,
  FolderIcon,
  GitBranchIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  StoreIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ExpandingSearch } from "@/components/interior/expanding-search";
import { HoldToConfirm } from "@/components/interior/hold-to-confirm";
import { LoadMore } from "@/components/interior/load-more";
import { LoadingButton } from "@/components/interior/loading-button";
import { PressDepthButton } from "@/components/interior/press-depth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MarketplacePlugin, MarketplaceSource } from "@/domain/config";
import { toUserMessage } from "@/domain/app-error";
import { useAsyncOperation } from "@/hooks/use-async-operation";
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

import { MarketplacePluginRow } from "./marketplace-plugin-row";
import {
  emptyMarketplaceSource,
  MarketplaceSourceDialog,
} from "./marketplace-source-dialog";

interface MarketplaceSettingsProps {
  cwd: string;
  onPluginsChanged: () => Promise<void> | void;
}

const marketplaceReference = (plugin: MarketplacePlugin) =>
  `${plugin.name}@${plugin.marketplace}`;

const marketplaceDomId = (key: string) =>
  `marketplace-${encodeURIComponent(key)}`;

const MARKETPLACE_PAGE_SIZE = 40;

export function MarketplaceSettings({
  cwd,
  onPluginsChanged,
}: MarketplaceSettingsProps) {
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [draft, setDraft] = useState<MarketplaceSource>(emptyMarketplaceSource);
  const [sourceInput, setSourceInput] = useState("");
  const [originalName, setOriginalName] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingSource, setDeletingSource] = useState(false);
  const [pendingDeleteSource, setPendingDeleteSource] =
    useState<MarketplaceSource>();
  const [busyPlugin, setBusyPlugin] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [activeMarketplaceKey, setActiveMarketplaceKey] = useState<string>();
  const [marketplaceVisibleCount, setMarketplaceVisibleCount] = useState(
    MARKETPLACE_PAGE_SIZE,
  );
  const [marketplaceSearchInput, setMarketplaceSearchInput] = useState("");
  const [marketplaceQuery, setMarketplaceQuery] = useState("");
  const [marketplaceSearchOpen, setMarketplaceSearchOpen] = useState(false);
  const { state: pluginActionState, run: runPluginOperation } =
    useAsyncOperation();
  const visibleError = pluginActionState.error ?? error;

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

  const marketplaceGroups = useMemo(() => {
    const configuredNames = new Set(sources.map((source) => source.name));
    const discoveredNames = Array.from(pluginsByMarketplace.keys())
      .filter((name) => !configuredNames.has(name))
      .sort((left, right) => left.localeCompare(right));

    return [
      ...sources.map((source) => ({
        key: "configured:" + source.name,
        name: source.name,
        source,
        plugins: pluginsByMarketplace.get(source.name) ?? [],
      })),
      ...discoveredNames.map((name) => ({
        key: "indexed:" + name,
        name,
        source: undefined,
        plugins: pluginsByMarketplace.get(name) ?? [],
      })),
    ];
  }, [pluginsByMarketplace, sources]);

  useEffect(() => {
    if (marketplaceGroups.length === 0) {
      setActiveMarketplaceKey(undefined);
      return;
    }

    setActiveMarketplaceKey((current) =>
      current && marketplaceGroups.some((group) => group.key === current)
        ? current
        : marketplaceGroups[0].key,
    );
  }, [marketplaceGroups]);

  const activeMarketplace =
    marketplaceGroups.find((group) => group.key === activeMarketplaceKey) ??
    marketplaceGroups[0];

  const visibleMarketplacePlugins = useMemo(() => {
    if (!activeMarketplace) return [];
    const normalized = marketplaceQuery.trim().toLocaleLowerCase();
    if (!normalized) return activeMarketplace.plugins;
    return activeMarketplace.plugins.filter((plugin) =>
      [plugin.name, plugin.description]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [activeMarketplace, marketplaceQuery]);

  const loadedMarketplacePlugins = useMemo(
    () => visibleMarketplacePlugins.slice(0, marketplaceVisibleCount),
    [marketplaceVisibleCount, visibleMarketplacePlugins],
  );
  const marketplaceHasMore = marketplaceVisibleCount < visibleMarketplacePlugins.length;

  const loadMoreMarketplacePlugins = useCallback(() => {
    const total = visibleMarketplacePlugins.length;
    const nextCount = Math.min(
      marketplaceVisibleCount + MARKETPLACE_PAGE_SIZE,
      total,
    );
    setMarketplaceVisibleCount(nextCount);
    return nextCount < total;
  }, [marketplaceVisibleCount, visibleMarketplacePlugins.length]);

  useEffect(() => {
    setMarketplaceVisibleCount(MARKETPLACE_PAGE_SIZE);
  }, [activeMarketplaceKey, marketplaceQuery]);

  useEffect(() => {
    setMarketplaceSearchInput("");
    setMarketplaceQuery("");
    setMarketplaceSearchOpen(false);
  }, [activeMarketplaceKey]);

  const load = useCallback(
    async (refresh = false) => {
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
        setError(toUserMessage(reason));
        throw reason;
      } finally {
        setLoading(false);
      }
    },
    [cwd],
  );

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const openEditor = (source?: MarketplaceSource) => {
    setDraft(source ? { ...source } : { ...emptyMarketplaceSource });
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
      setError(toUserMessage(reason));
      throw reason;
    } finally {
      setSaving(false);
      setLoading(false);
    }
  };

  const remove = async (name: string) => {
    setDeletingSource(true);
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const nextSources = await deleteMarketplaceSource(name);
      setSources(nextSources);
      setPlugins(await scanMarketplacePlugins(cwd));
      setPendingDeleteSource(undefined);
    } catch (reason) {
      setError(toUserMessage(reason));
      throw reason;
    } finally {
      setLoading(false);
      setDeletingSource(false);
    }
  };

  const runPluginAction = async (plugin: MarketplacePlugin) => {
    const key = marketplaceReference(plugin);
    setBusyPlugin(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await runPluginOperation(async () => {
        const actionResult =
          plugin.status === "installed"
            ? await updateMelodyPlugin(cwd, plugin.name)
            : await installMelodyPlugin(cwd, key);
        const [nextPlugins] = await Promise.all([
          scanMarketplacePlugins(cwd),
          onPluginsChanged(),
        ]);
        return { nextPlugins, message: actionResult.message };
      });
      setPlugins(result.nextPlugins);
      setNotice(result.message);
    } finally {
      setBusyPlugin(undefined);
    }
  };

  return (
    <section className="mt-7 pt-6">
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
        <div className="relative flex h-10 shrink-0 items-center pr-10">
          <div
            aria-hidden={marketplaceSearchOpen}
            className={cn(
              "flex items-center gap-2 transition-opacity",
              marketplaceSearchOpen && "pointer-events-none opacity-0",
            )}
          >
            <PressDepthButton onClick={() => openEditor()} size="sm">
              <PlusIcon className="size-3.5" />
              添加来源
            </PressDepthButton>
            <LoadingButton
              disabled={loading}
              errorLabel="重试"
              icon={<RefreshCwIcon />}
              onAction={() => load(true)}
              pendingLabel="刷新中…"
              size="sm"
              successLabel="已刷新"
              variant="outline"
            >
              刷新目录
            </LoadingButton>
          </div>
          <div className="absolute inset-y-0 right-0 z-10 flex w-60 items-center">
            <ExpandingSearch
              debounce={180}
              disabled={!activeMarketplace}
              label="搜索 Marketplace 插件"
              onChange={setMarketplaceSearchInput}
              onOpenChange={setMarketplaceSearchOpen}
              onSearch={setMarketplaceQuery}
              open={marketplaceSearchOpen}
              placeholder="搜索插件"
              resultCount={visibleMarketplacePlugins.length}
              size="sm"
              value={marketplaceSearchInput}
            />
          </div>
        </div>
      </div>

      {visibleError ? (
        <p
          aria-live="assertive"
          className="mt-3 rounded-lg bg-destructive/5 px-3 py-2 text-destructive text-xs"
          role="alert"
        >
          {visibleError}
        </p>
      ) : null}
      {notice ? (
        <div className="pointer-events-none fixed right-6 bottom-6 z-40 max-w-[calc(100vw-3rem)]">
          <div
            aria-live="polite"
            className="motion-success pointer-events-auto flex max-w-xl items-start gap-2 rounded-xl bg-emerald-500/10 px-4 py-2.5 text-emerald-800 text-xs shadow-lg shadow-emerald-950/10 backdrop-blur-md dark:text-emerald-300"
            role="status"
          >
            <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" />
            <p className="whitespace-pre-wrap">{notice}</p>
          </div>
        </div>
      ) : null}

      {loading && marketplaceGroups.length === 0 ? (
        <div className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-muted/20 px-4 py-10 text-muted-foreground text-xs">
          <RefreshCwIcon className="size-3.5 animate-spin" />
          正在扫描插件目录…
        </div>
      ) : null}
      {!loading && marketplaceGroups.length === 0 ? (
        <div className="mt-4 rounded-xl bg-muted/20 px-4 py-10 text-center">
          <StoreIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
          <p className="font-medium text-sm">尚未配置 Marketplace</p>
          <p className="mt-1 text-muted-foreground text-xs">
            添加来源后会立即扫描并显示其中的可用插件。
          </p>
        </div>
      ) : null}

      {activeMarketplace ? (
        <div className="mt-4 overflow-hidden rounded-xl bg-muted/20">
          <div
            aria-label="Marketplace 来源"
            className="flex gap-1 overflow-x-auto p-1.5"
            role="tablist"
          >
            {marketplaceGroups.map((group) => {
              const selected = group.key === activeMarketplace.key;
              const tabId = marketplaceDomId(group.key) + "-tab";
              const panelId = marketplaceDomId(group.key) + "-panel";
              return (
                <button
                  aria-controls={panelId}
                  aria-selected={selected}
                  className={cn(
                    "inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-[9px] px-3 py-2 text-sm transition-colors",
                    selected
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                  )}
                  id={tabId}
                  key={group.key}
                  onClick={() => setActiveMarketplaceKey(group.key)}
                  role="tab"
                  type="button"
                >
                  <span className="max-w-48 truncate">{group.name}</span>
                  <span
                    className={cn(
                      "text-xs",
                      selected ? "text-foreground" : "text-muted-foreground/80",
                    )}
                  >
                    {group.plugins.length}
                  </span>
                </button>
              );
            })}
          </div>

          <article
            aria-labelledby={marketplaceDomId(activeMarketplace.key) + "-tab"}
            id={marketplaceDomId(activeMarketplace.key) + "-panel"}
            role="tabpanel"
          >
            <header className="flex min-h-14 items-center gap-3 bg-background/20 px-4 py-3">
              {activeMarketplace.source ? (
                activeMarketplace.source.kind === "git" ? (
                  <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                )
              ) : (
                <StoreIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium text-sm">
                    {activeMarketplace.name}
                  </p>
                  <Badge variant="secondary">
                    {activeMarketplace.source
                      ? activeMarketplace.source.kind === "git"
                        ? "Git"
                        : "本地"
                      : "索引"}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {marketplaceQuery.trim()
                      ? `${visibleMarketplacePlugins.length}/${activeMarketplace.plugins.length} 个插件`
                      : `${activeMarketplace.plugins.length} 个插件`}
                  </span>
                </div>
                {activeMarketplace.source ? (
                  <p
                    className="mt-0.5 truncate text-muted-foreground text-xs"
                    title={activeMarketplace.source.location}
                  >
                    {activeMarketplace.source.location}
                    {activeMarketplace.source.branch
                      ? " · " + activeMarketplace.source.branch
                      : ""}
                  </p>
                ) : (
                  <p className="mt-0.5 truncate text-muted-foreground text-xs">
                    来自 Melody 的本地 Marketplace 索引
                  </p>
                )}
              </div>
              {activeMarketplace.source ? (
                <>
                  <Button
                    aria-label={"编辑 " + activeMarketplace.source.name}
                    onClick={() => openEditor(activeMarketplace.source)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    aria-label={"删除 " + activeMarketplace.source.name}
                    onClick={() =>
                      setPendingDeleteSource(activeMarketplace.source)
                    }
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2Icon />
                  </Button>
                </>
              ) : null}
            </header>
            <div className="grid gap-1.5 p-2">
              {loadedMarketplacePlugins.map((plugin) => (
                <MarketplacePluginRow
                  disabled={busyPlugin !== undefined}
                  key={marketplaceReference(plugin)}
                  onAction={runPluginAction}
                  plugin={plugin}
                />
              ))}
              {!loading && visibleMarketplacePlugins.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <PackageIcon className="mx-auto mb-2 size-4 text-muted-foreground" />
                  <p className="text-muted-foreground text-xs">
                    {marketplaceQuery.trim()
                      ? "没有匹配的插件。"
                      : "这个 Marketplace 中没有发现插件。"}
                  </p>
                </div>
              ) : null}
              {loading && activeMarketplace.plugins.length === 0 ? (
                <div className="flex items-center justify-center gap-2 px-4 py-8 text-muted-foreground text-xs">
                  <RefreshCwIcon className="size-3.5 animate-spin" />
                  正在扫描插件目录…
                </div>
              ) : null}
              {!loading &&
              visibleMarketplacePlugins.length > MARKETPLACE_PAGE_SIZE ? (
                <LoadMore
                  className="px-2 py-3"
                  hasMore={marketplaceHasMore}
                  labels={{
                    idle: "加载更多",
                    loading: "正在加载",
                    error: "加载失败，重试",
                    end: "已全部加载",
                  }}
                  onLoad={loadMoreMarketplacePlugins}
                  rootMargin="240px 0px"
                />
              ) : null}
            </div>
          </article>
        </div>
      ) : null}

      <MarketplaceSourceDialog
        draft={draft}
        error={error}
        onOpenChange={setDialogOpen}
        onSave={save}
        open={dialogOpen}
        originalName={originalName}
        saving={saving}
        setDraft={setDraft}
        setSourceInput={setSourceInput}
        sourceInput={sourceInput}
      />

      <Dialog
        onOpenChange={(open) => {
          if (!open && !deletingSource) {
            setPendingDeleteSource(undefined);
          }
        }}
        open={Boolean(pendingDeleteSource)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 Marketplace 来源？</DialogTitle>
            <DialogDescription>
              “{pendingDeleteSource?.name ?? ""}”及其本地索引会从 Melody
              中移除， 不会删除来源目录本身。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={deletingSource} variant="outline">
                取消
              </Button>
            </DialogClose>
            <HoldToConfirm
              confirmLabel={deletingSource ? "删除中…" : "已删除"}
              disabled={deletingSource}
              onConfirm={() => {
                if (pendingDeleteSource) {
                  return remove(pendingDeleteSource.name);
                }
              }}
              variant="destructive"
            >
              删除来源
            </HoldToConfirm>
          </DialogFooter>
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
