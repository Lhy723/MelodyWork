import { CheckCircle2Icon, PlusIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { FloatingLabelInput } from "@/components/interior/floating-label";
import { useGlobalLiveActivity } from "@/components/interior/live-activity";
import { LoadingButton } from "@/components/interior/loading-button";
import { Modal } from "@/components/interior/modal";
import { PressDepthButton } from "@/components/interior/press-depth";
import { Button } from "@/components/ui/button";
import { installMelodyPlugin } from "@/lib/melody-bridge";
import { useAsyncOperation } from "@/hooks/use-async-operation";
import { toUserMessage } from "@/domain/app-error";

interface PluginInstallerProps {
  cwd: string;
  onInstalled: () => Promise<void> | void;
}

export function PluginInstaller({ cwd, onInstalled }: PluginInstallerProps) {
  const liveActivity = useGlobalLiveActivity();
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

  const install = async (nextSource = source) => {
    const normalized = nextSource.trim();
    if (!normalized) return;
    liveActivity.start({
      detail: `正在安装插件“${normalized}”…`,
      title: "添加插件",
    });
    try {
      const result = await installation.run(async () => {
        const installed = await installMelodyPlugin(cwd, normalized);
        await onInstalled();
        return installed;
      });
      setSuccess(result.message);
      liveActivity.succeed({
        detail: result.message,
        title: "插件安装完成",
      });
    } catch (reason) {
      const message = toUserMessage(reason);
      liveActivity.fail(
        { detail: message, title: "插件安装失败" },
        {
          label: "重试",
          onClick: () => {
            void install(normalized).catch(() => undefined);
          },
        },
      );
      throw reason;
    }
  };

  return (
    <>
      <PressDepthButton
        onClick={() => {
          reset();
          setOpen(true);
        }}
        size="sm"
      >
        <PlusIcon className="size-3.5" />
        添加插件
      </PressDepthButton>

      <Modal
        description="输入 Marketplace 插件名、Git 仓库、GitHub 简写或本地路径。"
        footer={
          <>
            <Button
              onClick={() => {
                setOpen(false);
                reset();
              }}
              variant="outline"
            >
              关闭
            </Button>
            {!success ? (
              <LoadingButton
                disabled={!source.trim()}
                errorLabel="重试"
                onAction={install}
                pendingLabel="正在安装…"
                successLabel="已安装"
              >
                信任并安装
              </LoadingButton>
            ) : null}
          </>
        }
        onClose={() => {
          setOpen(false);
          reset();
        }}
        open={open}
        title="添加插件"
      >
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
          <div className="grid gap-4">
            <FloatingLabelInput
              autoFocus
              hint="例如 sentry、owner/repo 或 ./my-plugin；也可填写 Marketplace 插件名"
              label="插件来源"
              onChange={(value) => setSource(value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && source.trim() && !installing) {
                  event.preventDefault();
                  void install();
                }
              }}
              value={source}
            />

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
          </div>
        )}
      </Modal>
    </>
  );
}
