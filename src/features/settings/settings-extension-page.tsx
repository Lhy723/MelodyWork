import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  ChevronRightIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import type { MelodyExtension, MelodyExtensionKind } from "@/domain/config";
import { cn } from "@/lib/utils";

import { MarketplaceSettings } from "./marketplace-settings";
import { PluginDetailsView } from "./plugin-details";
import { PluginInstaller } from "./plugin-installer";
import { SkillDetailsView } from "./skill-details";
import { kindDescription, kindIcon, kindLabel } from "./settings-types";
import { skillSourceLabel } from "./settings-extension-utils";

export interface SettingsExtensionGroup {
  id: string;
  label?: string;
  description?: string;
  items: MelodyExtension[];
}

interface SettingsExtensionPageProps {
  cwd: string;
  extensionKind: MelodyExtensionKind;
  kindExtensions: MelodyExtension[];
  loading: boolean;
  onRefresh: () => void;
  onSelectedPluginChange: (extension?: MelodyExtension) => void;
  onSkillQueryChange: (query: string) => void;
  onSkillStatusChange: (status: "all" | "enabled" | "disabled") => void;
  onToggleExtension: (
    extension: MelodyExtension,
    enabled: boolean,
  ) => void | Promise<void>;
  selectedPlugin?: MelodyExtension;
  skillQuery: string;
  skillStatus: "all" | "enabled" | "disabled";
  togglingExtensions: Set<string>;
  visibleExtensions: MelodyExtension[];
  visibleExtensionGroups: SettingsExtensionGroup[];
}

export function SettingsExtensionPage({
  cwd,
  extensionKind,
  kindExtensions,
  loading,
  onRefresh,
  onSelectedPluginChange,
  onSkillQueryChange,
  onSkillStatusChange,
  onToggleExtension,
  selectedPlugin,
  skillQuery,
  skillStatus,
  togglingExtensions,
  visibleExtensions,
  visibleExtensionGroups,
}: SettingsExtensionPageProps) {
  const ExtensionIcon = kindIcon[extensionKind] ?? SparklesIcon;
  return (
    <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        {extensionKind === "plugins" && selectedPlugin ? (
          <PluginDetailsView
            cwd={cwd}
            onBack={() => onSelectedPluginChange(undefined)}
            onDeleted={async () => {
              onSelectedPluginChange(undefined);
              await onRefresh();
            }}
            plugin={selectedPlugin}
          />
        ) : extensionKind === "skills" && selectedPlugin ? (
          <SkillDetailsView
            cwd={cwd}
            onBack={() => onSelectedPluginChange(undefined)}
            onDeleted={async () => {
              onSelectedPluginChange(undefined);
              await onRefresh();
            }}
            skill={selectedPlugin}
          />
        ) : (
          <>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <ExtensionIcon className="size-5 text-muted-foreground" />
                  <h3 className="font-semibold text-2xl">
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
                <PluginInstaller cwd={cwd} onInstalled={onRefresh} />
              ) : null}
              <Button
                disabled={loading}
                onClick={() => void onRefresh()}
                variant="outline"
              >
                <RefreshCwIcon className={cn(loading && "animate-spin")} />
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
                    onChange={(event) => onSkillQueryChange(event.target.value)}
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
                      onClick={() => onSkillStatusChange(value)}
                      size="sm"
                      variant={skillStatus === value ? "secondary" : "ghost"}
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
                        <h4 className="font-medium text-sm">{group.label}</h4>
                        <Badge variant="secondary">{group.items.length}</Badge>
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
                            onClick={() => onSelectedPluginChange(item)}
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
                                {item.scope === "user" ? "用户" : "项目"}
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
                              {item.compatibilityStatus === "disabled" ? (
                                <Badge variant="secondary">兼容性已关闭</Badge>
                              ) : !item.enabled ? (
                                <Badge variant="secondary">已停用</Badge>
                              ) : null}
                            </div>
                            {extensionKind === "skills" && item.description ? (
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
                                !canToggle || togglingExtensions.has(toggleKey)
                              }
                              title={
                                canToggle
                                  ? undefined
                                  : "请先在兼容性设置中启用此来源"
                              }
                              onCheckedChange={(checked) =>
                                void onToggleExtension(item, checked)
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
              <MarketplaceSettings cwd={cwd} onPluginsChanged={onRefresh} />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
