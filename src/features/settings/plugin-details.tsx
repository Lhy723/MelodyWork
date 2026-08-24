import {
  ArrowLeftIcon,
  BotIcon,
  BracesIcon,
  CommandIcon,
  FileJsonIcon,
  FolderIcon,
  RefreshCwIcon,
  ServerIcon,
  SparklesIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
import type {
  MelodyExtension,
  PluginComponentGroup,
  PluginDetails,
} from "@/domain/config";
import { useAsyncOperation } from "@/hooks/use-async-operation";
import {
  getMelodyPluginDetails,
  uninstallMelodyPlugin,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

const groupPresentation: Record<
  PluginComponentGroup["kind"],
  { label: string; icon: typeof SparklesIcon }
> = {
  skills: { label: "技能", icon: SparklesIcon },
  commands: { label: "命令", icon: CommandIcon },
  agents: { label: "代理", icon: BotIcon },
  hooks: { label: "钩子", icon: WebhookIcon },
  mcps: { label: "MCP 服务", icon: ServerIcon },
  lsps: { label: "LSP 服务", icon: BracesIcon },
};

interface PluginDetailsViewProps {
  cwd: string;
  plugin: MelodyExtension;
  onBack: () => void;
  onDeleted: () => Promise<void> | void;
}

export function PluginDetailsView({
  cwd,
  plugin,
  onBack,
  onDeleted,
}: PluginDetailsViewProps) {
  const [details, setDetails] = useState<PluginDetails>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { state: loadingState, run: runLoad } = useAsyncOperation();
  const {
    state: deleteState,
    reset: resetDelete,
    run: runDelete,
  } = useAsyncOperation();
  const loading = loadingState.phase === "pending";
  const error = loadingState.error;
  const deleting = deleteState.phase === "pending";
  const deleteError = deleteState.error;

  const load = useCallback(() => {
    void runLoad(() => getMelodyPluginDetails(cwd, plugin), setDetails).catch(
      () => undefined,
    );
  }, [cwd, plugin, runLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = () => {
    void runDelete(async () => {
      await uninstallMelodyPlugin(cwd, plugin.name);
      setDeleteOpen(false);
      await onDeleted();
    }).catch(() => undefined);
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-start gap-3">
        <Button
          aria-label="返回插件列表"
          onClick={onBack}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold text-lg">
              {details?.name ?? plugin.name}
            </h3>
            {details?.version ? (
              <Badge variant="secondary">v{details.version}</Badge>
            ) : null}
            <Badge variant="outline">
              {plugin.provider === "claude" ? "Claude Code" : "Melody"}
            </Badge>
          </div>
          <p className="mt-1 text-muted-foreground text-sm">
            {details?.description ?? "查看插件包含的能力和配置。"}
          </p>
        </div>
        <Button
          aria-label="刷新插件详情"
          disabled={loading}
          onClick={() => void load()}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        {plugin.managed ? (
          <Button
            onClick={() => {
              resetDelete();
              setDeleteOpen(true);
            }}
            size="sm"
            variant="destructive"
          >
            <Trash2Icon />
            删除插件
          </Button>
        ) : null}
      </div>

      {error ? (
        <p
          aria-live="assertive"
          className="mt-5 rounded-xl bg-destructive/5 px-4 py-3 text-destructive text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {details ? (
        <>
          <dl className="mt-6 overflow-hidden rounded-xl border text-sm">
            {[
              ["作者", details.author],
              ["许可证", details.license],
              ["主页", details.homepage],
              ["仓库", details.repository],
            ]
              .filter((entry): entry is [string, string] => Boolean(entry[1]))
              .map(([label, value], index) => (
                <div
                  className={cn(
                    "grid grid-cols-[6rem_1fr] gap-3 px-4 py-2.5",
                    index > 0 && "border-t",
                  )}
                  key={label}
                >
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 truncate" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
          </dl>

          <section className="mt-7">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-base">包含的组件</h4>
              <Badge variant="secondary">
                {details.components.reduce(
                  (total, group) => total + group.items.length,
                  0,
                )}
              </Badge>
            </div>
            <div className="mt-3 overflow-hidden rounded-xl border">
              {details.components.map((group, index) => {
                const presentation = groupPresentation[group.kind];
                const Icon = presentation.icon;
                return (
                  <div
                    className={cn(
                      "grid min-h-14 grid-cols-[9rem_1fr] gap-4 px-4 py-3",
                      index > 0 && "border-t",
                    )}
                    key={group.kind}
                  >
                    <div className="flex items-start gap-2 font-medium text-sm">
                      <Icon className="mt-0.5 size-4 text-muted-foreground" />
                      <span>{presentation.label}</span>
                      <Badge variant="outline">{group.items.length}</Badge>
                    </div>
                    <div className="flex min-w-0 flex-wrap gap-1.5">
                      {group.items.length > 0 ? (
                        group.items.map((item) => (
                          <Badge key={item} variant="secondary">
                            {item}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          未包含
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mt-7 overflow-hidden rounded-xl border text-xs">
            <div className="flex items-center gap-2 px-4 py-3">
              <FolderIcon className="size-4 text-muted-foreground" />
              <span className="w-16 text-muted-foreground">插件目录</span>
              <code className="min-w-0 flex-1 truncate" title={details.path}>
                {details.path}
              </code>
            </div>
            {details.manifestPath ? (
              <div className="flex items-center gap-2 border-t px-4 py-3">
                <FileJsonIcon className="size-4 text-muted-foreground" />
                <span className="w-16 text-muted-foreground">插件清单</span>
                <code
                  className="min-w-0 flex-1 truncate"
                  title={details.manifestPath}
                >
                  {details.manifestPath}
                </code>
              </div>
            ) : null}
          </section>
        </>
      ) : loading ? (
        <p className="mt-8 text-center text-muted-foreground text-sm">
          正在读取插件详情…
        </p>
      ) : null}

      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除“{plugin.name}”？</DialogTitle>
            <DialogDescription>
              这会从 Melody
              的安装注册表和本地安装目录中移除该插件。如果同一仓库包含多个插件，它们会一起被移除。
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p
              aria-live="assertive"
              className="rounded-lg bg-destructive/5 px-3 py-2 text-destructive text-xs"
              role="alert"
            >
              {deleteError}
            </p>
          ) : null}
          <DialogFooter showCloseButton>
            <Button
              disabled={deleting}
              onClick={() => void remove()}
              variant="destructive"
            >
              <Trash2Icon />
              {deleting ? "正在删除…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
