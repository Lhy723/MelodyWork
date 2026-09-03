import { FolderIcon, GitBranchIcon } from "lucide-react";
import { useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import { FloatingLabelInput } from "@/components/interior/floating-label";
import { LoadingButton } from "@/components/interior/loading-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  onSave: () => unknown;
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
  const saveButtonRef = useRef<HTMLButtonElement>(null);

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
            <FloatingLabelInput
              hint="例如 Team Plugins"
              label="名称"
              onChange={(value) =>
                setDraft((current) => ({ ...current, name: value }))
              }
              value={draft.name}
            />
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
            <FloatingLabelInput
              hint={
                draft.kind === "git"
                  ? "例如 https://github.com/org/plugins.git"
                  : "例如 ~/dev/plugins"
              }
              label={draft.kind === "git" ? "Git 地址" : "目录路径"}
              onChange={(value) =>
                setDraft((current) => ({ ...current, location: value }))
              }
              value={draft.location}
            />
            {draft.kind === "git" ? (
              <FloatingLabelInput
                hint="可选，例如 main"
                label="分支"
                onChange={(value) =>
                  setDraft((current) => ({ ...current, branch: value }))
                }
                value={draft.branch ?? ""}
              />
            ) : null}
          </div>
        ) : (
          <FloatingLabelInput
            autoFocus
            hint="Git 链接、owner/repo 或本地目录；会自动识别来源类型"
            label="链接或路径"
            onChange={(value) => setSourceInput(value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && sourceInput.trim() && !saving) {
                event.preventDefault();
                saveButtonRef.current?.click();
              }
            }}
            value={sourceInput}
          />
        )}

        <DialogFooter showCloseButton>
          <LoadingButton
            disabled={
              originalName
                ? !draft.name.trim() || !draft.location.trim()
                : !sourceInput.trim()
            }
            errorLabel="重试"
            onAction={onSave}
            pendingLabel="正在保存并扫描…"
            ref={saveButtonRef}
            successLabel="已保存"
          >
            保存并扫描
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
