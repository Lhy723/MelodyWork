import {
  FolderIcon,
  GitBranchIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  StoreIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

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
import type { MarketplaceSource } from "@/domain/config";
import {
  addMarketplaceSource,
  deleteMarketplaceSource,
  listMarketplaceSources,
  saveMarketplaceSource,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

const emptySource: MarketplaceSource = {
  name: "",
  kind: "git",
  location: "",
};

export function MarketplaceSettings() {
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [draft, setDraft] = useState<MarketplaceSource>(emptySource);
  const [sourceInput, setSourceInput] = useState("");
  const [originalName, setOriginalName] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setSources(await listMarketplaceSources());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openEditor = (source?: MarketplaceSource) => {
    setDraft(source ? { ...source } : { ...emptySource });
    setSourceInput("");
    setOriginalName(source?.name);
    setError(undefined);
    setDialogOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      setSources(
        originalName
          ? await saveMarketplaceSource(originalName, draft)
          : await addMarketplaceSource(sourceInput),
      );
      setDialogOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    setError(undefined);
    try {
      setSources(await deleteMarketplaceSource(name));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="mt-7 border-t pt-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StoreIcon className="size-4 text-muted-foreground" />
            <h4 className="font-semibold text-base">Marketplace</h4>
            <Badge variant="secondary">{sources.length}</Badge>
          </div>
          <p className="mt-1 text-muted-foreground text-sm">
            配置提供可安装插件的 Git 仓库或本地目录。
          </p>
        </div>
        <Button
          aria-label="刷新 Marketplace"
          disabled={loading}
          onClick={() => void load()}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
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

      <div className="mt-4 overflow-hidden rounded-xl border">
        {sources.map((source, index) => {
          const SourceIcon =
            source.kind === "git" ? GitBranchIcon : FolderIcon;
          return (
            <div
              className={cn(
                "flex min-h-14 items-center gap-3 px-3 py-2.5",
                index > 0 && "border-t",
              )}
              key={source.name}
            >
              <SourceIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium text-sm">{source.name}</p>
                  <Badge variant="outline">
                    {source.kind === "git" ? "Git" : "本地"}
                  </Badge>
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
            </div>
          );
        })}
        {!loading && sources.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="font-medium text-sm">尚未配置 Marketplace</p>
            <p className="mt-1 text-muted-foreground text-xs">
              添加一个 Git 仓库或包含插件目录的本地路径。
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
              保存后会写入用户级 Melody 配置中的 marketplace.sources。
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
                  if (event.key === "Enter" && sourceInput.trim()) {
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
              {saving ? "正在保存" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
