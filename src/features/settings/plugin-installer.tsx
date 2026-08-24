import { CheckCircle2Icon, PlusIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

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
import { installMelodyPlugin } from "@/lib/melody-bridge";
import { useAsyncOperation } from "@/hooks/use-async-operation";

interface PluginInstallerProps {
  cwd: string;
  onInstalled: () => Promise<void> | void;
}

export function PluginInstaller({ cwd, onInstalled }: PluginInstallerProps) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [success, setSuccess] = useState<string>();
  const installation = useAsyncOperation();
  const installing = installation.state.phase === "pending";
  const error = installation.state.error;

  const reset = () => {
    setSource("");
    installation.reset();
    setSuccess(undefined);
  };

  const install = async () => {
    try {
      const result = await installation.run(async () => {
        const installed = await installMelodyPlugin(cwd, source);
        await onInstalled();
        return installed;
      });
      setSuccess(result.message);
    } catch {
      // The operation state owns the user-visible error.
    }
  };

  return (
    <>
      <Button
        onClick={() => {
          reset();
          setOpen(true);
        }}
        size="sm"
      >
        <PlusIcon />
        添加插件
      </Button>

      <Dialog
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            reset();
          }
        }}
        open={open}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加插件</DialogTitle>
            <DialogDescription>
              输入 Marketplace 插件名、Git 仓库、GitHub 简写或本地路径。
            </DialogDescription>
          </DialogHeader>

          {success ? (
            <div className="rounded-xl border bg-muted/40 p-3">
              <div className="flex items-center gap-2 font-medium text-sm">
                <CheckCircle2Icon className="size-4 text-emerald-600" />
                插件已安装
              </div>
              <p className="mt-2 whitespace-pre-wrap text-muted-foreground text-xs">
                {success}
              </p>
            </div>
          ) : (
            <>
              <label className="grid gap-1.5">
                <span className="font-medium text-xs">插件来源</span>
                <Input
                  autoFocus
                  onChange={(event) => setSource(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && source.trim() && !installing) {
                      event.preventDefault();
                      void install();
                    }
                  }}
                  placeholder="例如 sentry、owner/repo 或 ./my-plugin"
                  value={source}
                />
                <span className="text-muted-foreground text-xs">
                  已配置 Marketplace 时，可以直接填写其中的插件名。
                </span>
              </label>

              <div className="flex gap-2 rounded-xl bg-amber-500/8 p-3 text-amber-900 text-xs dark:text-amber-200">
                <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
                <p>
                  安装即表示信任该来源。插件可能加载技能、代理、Hook、MCP 和 LSP
                  服务。
                </p>
              </div>

              {error ? (
                <p
                  aria-live="assertive"
                  className="rounded-lg bg-destructive/5 px-3 py-2 text-destructive text-xs"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
            </>
          )}

          <DialogFooter showCloseButton>
            {!success ? (
              <Button
                disabled={installing || !source.trim()}
                onClick={() => void install()}
              >
                {installing ? "正在安装…" : "信任并安装"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
