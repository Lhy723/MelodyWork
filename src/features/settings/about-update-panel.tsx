import { CheckCircleIcon, InfoIcon, RefreshCwIcon } from "lucide-react";

import { Dropdown } from "@/components/interior/dropdown";
import { LoadingButton } from "@/components/interior/loading-button";
import { ProgressBar } from "@/components/interior/progress-bar";
import { Switch } from "@/components/ui/switch";
import type { UpdateChannel } from "@/stores/app-settings-store";

import { PanelHeader } from "./about-ui";
import { type UpdateCheckState, updateChannelLabel } from "./about-types";

interface AboutUpdatePanelProps {
  autoCheckForUpdates: boolean;
  updateChannel: UpdateChannel;
  updateState: UpdateCheckState;
  hasUpdateDetails: boolean;
  onSetAutoCheck: (enabled: boolean) => void;
  onSetChannel: (channel: UpdateChannel) => void;
  onCheck: () => unknown;
  onInstall: () => unknown;
}

export function AboutUpdatePanel({
  autoCheckForUpdates,
  updateChannel,
  updateState,
  hasUpdateDetails,
  onSetAutoCheck,
  onSetChannel,
  onCheck,
  onInstall,
}: AboutUpdatePanelProps) {
  return (
    <section
      aria-labelledby="about-update-title"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <PanelHeader
        action={
          <div className="flex flex-wrap items-center justify-end gap-3">
            {updateState.status === "up-to-date" ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-500 text-sm">
                <CheckCircleIcon className="size-4" />
                已是最新版本
              </span>
            ) : null}
            <LoadingButton
              disabled={updateState.status === "installing"}
              errorLabel="重试"
              icon={<RefreshCwIcon />}
              onAction={onCheck}
              pendingLabel="检查中…"
              successLabel="检查完成"
              size="sm"
              variant="secondary"
            >
              检查更新
            </LoadingButton>
          </div>
        }
        description={`当前渠道：${updateChannelLabel[updateChannel]}。自动检查和渠道设置可在此处管理。`}
        title={<span id="about-update-title">软件更新</span>}
      />
      <div className="divide-y border-b">
        <div className="flex min-h-14 items-center gap-5 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">自动检查 MelodyWork 更新</p>
            <p className="mt-0.5 text-muted-foreground text-xs leading-4">
              启动时检查可用更新；发现新版本后由你确认安装。
            </p>
          </div>
          <Switch
            aria-label="自动检查 MelodyWork 更新"
            checked={autoCheckForUpdates}
            className="data-[state=checked]:bg-blue-500"
            onCheckedChange={onSetAutoCheck}
          />
        </div>
        <div className="flex min-h-14 items-center gap-5 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">检测更新渠道</p>
            <p className="mt-0.5 text-muted-foreground text-xs leading-4">
              正式版更稳定；测试版会更早提供新功能，可能包含未解决的问题。
            </p>
          </div>
          <Dropdown
            className="w-28"
            items={[
              { label: "正式版", value: "stable" },
              { label: "测试版", value: "beta" },
            ]}
            label="检测更新渠道"
            onChange={(next) => onSetChannel(next as UpdateChannel)}
            value={updateChannel}
          />
        </div>
      </div>
      {hasUpdateDetails ? (
        <div className="p-5">
          {updateState.status === "available" ||
          updateState.status === "installing" ? (
            <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 p-4">
              <div className="flex items-center gap-2">
                <InfoIcon className="size-4 text-blue-500" />
                <p className="font-medium text-sm">
                  发现{updateChannelLabel[updateState.channel]}新版本 v
                  {updateState.status === "available"
                    ? updateState.version
                    : updateState.version}
                </p>
              </div>
              {updateState.status === "available" && updateState.notes ? (
                <p className="mt-2 whitespace-pre-wrap text-muted-foreground text-xs">
                  {updateState.notes}
                </p>
              ) : null}
              {updateState.status === "installing" ? (
                <ProgressBar
                  className="mt-4"
                  label={
                    updateState.progress.phase === "downloading"
                      ? "下载更新"
                      : "安装更新"
                  }
                  pendingLabel={
                    updateState.progress.phase === "downloading"
                      ? "正在下载…"
                      : "正在安装并重启…"
                  }
                  size="compact"
                  value={
                    updateState.progress.phase === "downloading" &&
                    updateState.progress.totalBytes &&
                    updateState.progress.totalBytes > 0
                      ? Math.min(
                          100,
                          (updateState.progress.downloadedBytes /
                            updateState.progress.totalBytes) *
                            100,
                        )
                      : null
                  }
                />
              ) : null}
              <LoadingButton
                className="mt-3"
                errorLabel="重试"
                onAction={onInstall}
                pendingLabel="正在下载并安装…"
                successLabel="已安装"
                size="sm"
              >
                安装更新并重启
              </LoadingButton>
            </div>
          ) : null}
          {updateState.status === "error" ? (
            <div
              aria-live="assertive"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive text-sm"
              role="alert"
            >
              检查更新失败：{updateState.message}
            </div>
          ) : null}
          {updateState.status === "not-configured" ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-3 text-muted-foreground text-sm">
              当前运行环境未配置更新服务。
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
