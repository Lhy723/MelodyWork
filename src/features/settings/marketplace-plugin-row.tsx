import {
  BotIcon,
  BracesIcon,
  PackageIcon,
  SparklesIcon,
  WebhookIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { LoadingButton } from "@/components/interior/loading-button";
import type { MarketplacePlugin } from "@/domain/config";

export function MarketplacePluginRow({
  disabled,
  onAction,
  plugin,
}: {
  disabled: boolean;
  onAction: (plugin: MarketplacePlugin) => Promise<void>;
  plugin: MarketplacePlugin;
}) {
  const isInstalled = plugin.status === "installed";
  const updateAvailable = isInstalled && plugin.updateAvailable === true;
  const actionLabel = isInstalled
    ? updateAvailable
      ? "更新"
      : "检查更新"
    : "安装";
  const capabilities = [
    plugin.skillCount > 0
      ? { icon: SparklesIcon, label: `${plugin.skillCount} Skills` }
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
    <div className="flex items-center gap-3 rounded-lg bg-background/55 px-4 py-3 transition-colors hover:bg-background/75">
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
      <LoadingButton
        disabled={disabled}
        errorLabel="重试"
        onAction={() => onAction(plugin)}
        pendingLabel={
          isInstalled
            ? updateAvailable
              ? "正在更新…"
              : "正在检查…"
            : "正在安装…"
        }
        size="sm"
        successLabel={
          isInstalled ? (updateAvailable ? "已更新" : "已检查") : "已安装"
        }
        variant={isInstalled ? "outline" : "default"}
      >
        {actionLabel}
      </LoadingButton>
    </div>
  );
}
