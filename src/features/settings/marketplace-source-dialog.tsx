import { FolderIcon, GitBranchIcon } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

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

export const emptyMarketplaceSource: MarketplaceSource = {
  name: "",
  kind: "git",
  location: "",
};

export interface MarketplaceSourceDialogProps {
  draft: MarketplaceSource;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  open: boolean;
  originalName?: string;
  saving: boolean;
  setDraft: Dispatch<SetStateAction<MarketplaceSource>>;
  setSourceInput: Dispatch<SetStateAction<string>>;
  sourceInput: string;
}

export function MarketplaceSourceDialog({
  draft,
  error,
  onOpenChange,
  onSave,
  open,
  originalName,
  saving,
  setDraft,
  setSourceInput,
  sourceInput,
}: MarketplaceSourceDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {originalName ? "编辑 Marketplace" : "添加 Marketplace"}
          </DialogTitle>
          <DialogDescription>
            保存后会写入用户级 Melody 配置，并立即同步和扫描插件。
          </DialogDescription>
          {error ? (
            <p
              aria-live="assertive"
              className="rounded-lg bg-destructive/5 px-3 py-2 text-destructive text-xs"
              role="alert"
            >
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
                        branch: kind === "git" ? current.branch : undefined,
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
                if (event.key === "Enter" && sourceInput.trim() && !saving) {
                  event.preventDefault();
                  onSave();
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
            onClick={onSave}
          >
            {saving ? "正在保存并扫描…" : "保存并扫描"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
