import {
  BotIcon,
  BracesIcon,
  PackageIcon,
  RefreshCwIcon,
  SparklesIcon,
  WebhookIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MarketplacePlugin } from "@/domain/config";

export function MarketplacePluginRow({
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
