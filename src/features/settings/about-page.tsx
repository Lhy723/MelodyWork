import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  HistoryIcon,
  InfoIcon,
  MonitorIcon,
  RefreshCwIcon,
  ScaleIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import appPackage from "../../../package.json";
import appIcon from "../../../src-tauri/icons/128x128.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toUserMessage } from "@/domain/app-error";
import {
  getAppReleaseHistory,
  getEnvironmentCapabilities,
  checkAppUpdate,
  isTauriRuntime,
  openExternalUrl,
  type AppReleaseHistoryItem,
  type EnvironmentCapability,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";
import {
  useAppSettingsStore,
  type UpdateChannel,
} from "@/stores/app-settings-store";

type UpdateCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date" }
  | {
      status: "available";
      channel: UpdateChannel;
      version: string;
      notes?: string;
    }
  | { status: "installing"; channel: UpdateChannel }
  | { status: "installed" }
  | { status: "error"; message: string }
  | { status: "not-configured" };

const GITHUB_REPO_URL = "https://github.com/Lhy723/MelodyWork";
const updateChannelLabel: Record<UpdateChannel, string> = {
  stable: "正式版",
  beta: "测试版",
};

const fallbackReleaseHistory: AppReleaseHistoryItem[] = [
  {
    tagName: "v0.3.0",
    name: "MelodyWork v0.3.0",
    body: "稳定版更新，包含正式版与测试版更新渠道。",
    isPrerelease: false,
    url: `${GITHUB_REPO_URL}/releases/tag/v0.3.0`,
  },
  {
    tagName: "v0.2.0",
    name: "MelodyWork v0.2.0",
    body: "完善会话持久化、设置页面与桌面端更新能力。",
    isPrerelease: false,
    url: `${GITHUB_REPO_URL}/releases/tag/v0.2.0`,
  },
];

const formatReleaseDate = (value?: string) => {
  if (!value) {
    return "日期未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
};

const releaseVersion = (tagName: string) =>
  tagName.startsWith("v") ? tagName.slice(1) : tagName;

function InfoRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1 border-b px-5 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <p className="font-medium text-sm">{label}</p>
        {description ? (
          <p className="mt-1 text-muted-foreground text-xs">{description}</p>
        ) : null}
      </div>
      <div className="min-w-0 text-left text-muted-foreground text-sm sm:text-right">
        {children}
      </div>
    </div>
  );
}

function PanelHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="flex items-center gap-2 font-semibold text-base">
          {title}
        </h3>
        {description ? (
          <p className="mt-1 text-muted-foreground text-xs">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function CapabilityCard({ capability }: { capability: EnvironmentCapability }) {
  return (
    <div className="rounded-lg border bg-muted/35 p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
            capability.installed
              ? "bg-emerald-500/15 text-emerald-500"
              : "bg-muted text-muted-foreground",
          )}
        >
          {capability.installed ? (
            capability.name === "Git" ? (
              <GitBranchIcon className="size-3.5" />
            ) : (
              <TerminalIcon className="size-3.5" />
            )
          ) : (
            <InfoIcon className="size-3.5" />
          )}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-sm">{capability.name}</p>
            {capability.installed && capability.version ? (
              <Badge className="font-mono" variant="secondary">
                {capability.version}
              </Badge>
            ) : (
              <Badge variant="outline">未安装</Badge>
            )}
          </div>
          <p className="mt-1 text-muted-foreground text-xs">
            {capability.description}
          </p>
        </div>
      </div>
    </div>
  );
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"
        fillRule="evenodd"
      />
    </svg>
  );
}

export function AboutPage() {
  const [currentVersion, setCurrentVersion] = useState(appPackage.version);
  const autoCheckForUpdates = useAppSettingsStore(
    (state) => state.autoCheckForUpdates,
  );
  const updateChannel = useAppSettingsStore((state) => state.updateChannel);
  const setAppSetting = useAppSettingsStore((state) => state.setSetting);
  const [updateState, setUpdateState] = useState<UpdateCheckState>({
    status: "idle",
  });
  const [repositoryError, setRepositoryError] = useState<string>();
  const [releaseHistory, setReleaseHistory] = useState<AppReleaseHistoryItem[]>(
    fallbackReleaseHistory,
  );
  const [releaseHistoryState, setReleaseHistoryState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [environmentCapabilities, setEnvironmentCapabilities] = useState<
    EnvironmentCapability[]
  >([]);
  const [environmentState, setEnvironmentState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");

  const isBusy =
    updateState.status === "checking" || updateState.status === "installing";
  const updateCheckDescription =
    updateChannel === "beta"
      ? "优先检查测试版；没有更高测试版时也会检查正式版的签名更新。"
      : "检查正式版渠道的签名更新。";

  const refreshReleaseHistory = useCallback(async () => {
    setReleaseHistoryState("loading");
    try {
      const releases = await getAppReleaseHistory();
      setReleaseHistory(
        releases.length > 0 ? releases : fallbackReleaseHistory,
      );
      setReleaseHistoryState("ready");
    } catch {
      setReleaseHistory(fallbackReleaseHistory);
      setReleaseHistoryState("error");
    }
  }, []);

  const refreshEnvironmentCapabilities = useCallback(async () => {
    setEnvironmentState("loading");
    try {
      setEnvironmentCapabilities(await getEnvironmentCapabilities());
      setEnvironmentState("ready");
    } catch {
      setEnvironmentCapabilities([]);
      setEnvironmentState("error");
    }
  }, []);

  const checkForUpdate = async () => {
    const channel = updateChannel;
    setUpdateState({ status: "checking" });
    try {
      const result = await checkAppUpdate(channel);
      if (channel !== useAppSettingsStore.getState().updateChannel) {
        return;
      }
      if (!result.configured) {
        setUpdateState({ status: "not-configured" });
      } else if (result.available && result.version) {
        setUpdateState({
          status: "available",
          channel: result.channel,
          version: result.version,
          notes: result.notes,
        });
      } else {
        setUpdateState({ status: "up-to-date" });
      }
    } catch (reason) {
      setUpdateState({
        status: "error",
        message: toUserMessage(reason, "检查更新失败，请稍后重试。"),
      });
    }
  };

  const installUpdate = async () => {
    if (updateState.status !== "available") {
      return;
    }
    const channel = updateState.channel;
    setUpdateState({ status: "installing", channel });
    try {
      await checkAppUpdate(channel, true);
      setUpdateState({ status: "installed" });
      await relaunch();
    } catch (reason) {
      setUpdateState({
        status: "error",
        message: toUserMessage(reason, "安装更新失败，请稍后重试。"),
      });
    }
  };

  const openRepository = async () => {
    setRepositoryError(undefined);
    try {
      await openExternalUrl(GITHUB_REPO_URL);
    } catch (reason) {
      setRepositoryError(
        toUserMessage(reason, "无法打开 GitHub 仓库，请稍后重试。"),
      );
    }
  };

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let active = true;
    void getVersion()
      .then((version) => {
        if (active) {
          setCurrentVersion(version);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void refreshReleaseHistory();
    void refreshEnvironmentCapabilities();
  }, [refreshEnvironmentCapabilities, refreshReleaseHistory]);

  useEffect(() => {
    setUpdateState({ status: "idle" });
  }, [updateChannel]);

  return (
    <div className="mx-auto w-full max-w-3xl p-6 md:p-8">
      <div className="flex flex-col items-center text-center">
        <img
          alt="MelodyWork"
          className="size-20 rounded-2xl object-cover ring-1 ring-foreground/10"
          src={appIcon}
        />
        <h2 className="mt-5 font-semibold text-2xl">MelodyWork</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          对话优先的 Melody Build 桌面客户端
        </p>
        <Badge className="mt-4 font-mono" variant="secondary">
          v{currentVersion}
        </Badge>
      </div>

      <div className="mt-8 space-y-4">
        <section
          aria-labelledby="about-details-title"
          className="overflow-hidden rounded-xl border bg-card"
        >
          <h3 className="sr-only" id="about-details-title">
            应用信息
          </h3>
          <div className="divide-y">
            <InfoRow label="版本">
              <span className="font-mono text-foreground">
                v{currentVersion}
              </span>
            </InfoRow>
            <InfoRow label="运行时">
              <span className="inline-flex items-center gap-2 text-foreground">
                <MonitorIcon className="size-4 text-muted-foreground" />
                {isTauriRuntime() ? "Tauri + React" : "浏览器预览 + React"}
              </span>
            </InfoRow>
            <InfoRow
              description="MelodyWork 以 MIT License 发布。"
              label="开源协议"
            >
              <span className="inline-flex items-center gap-2 text-foreground">
                <ScaleIcon className="size-4 text-muted-foreground" />
                MIT License
              </span>
            </InfoRow>
            <InfoRow label="项目地址">
              <Button
                className="h-auto max-w-full justify-end px-0 text-right text-foreground"
                onClick={() => void openRepository()}
                size="sm"
                variant="link"
              >
                <GithubMark className="size-4" />
                <span className="truncate">github.com/Lhy723/MelodyWork</span>
                <ExternalLinkIcon className="size-3 text-muted-foreground" />
              </Button>
            </InfoRow>
          </div>
        </section>

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
                <Button
                  disabled={isBusy}
                  onClick={() => void checkForUpdate()}
                  size="sm"
                  variant="secondary"
                >
                  <RefreshCwIcon className={cn(isBusy && "animate-spin")} />
                  {updateState.status === "checking"
                    ? "检查中…"
                    : `检查${updateChannelLabel[updateChannel]}更新`}
                </Button>
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
                onCheckedChange={(next) =>
                  setAppSetting("autoCheckForUpdates", next)
                }
              />
            </div>
            <div className="flex min-h-14 items-center gap-5 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm">检测更新渠道</p>
                <p className="mt-0.5 text-muted-foreground text-xs leading-4">
                  正式版更稳定；测试版会更早提供新功能，可能包含未解决的问题。
                </p>
              </div>
              <Select
                onValueChange={(next) =>
                  setAppSetting("updateChannel", next as UpdateChannel)
                }
                value={updateChannel}
              >
                <SelectTrigger aria-label="检测更新渠道" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stable">正式版</SelectItem>
                  <SelectItem value="beta">测试版</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
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
                      : ""}
                  </p>
                </div>
                {updateState.status === "available" && updateState.notes ? (
                  <p className="mt-2 whitespace-pre-wrap text-muted-foreground text-xs">
                    {updateState.notes}
                  </p>
                ) : null}
                <Button
                  className="mt-3"
                  disabled={updateState.status === "installing"}
                  onClick={() => void installUpdate()}
                  size="sm"
                >
                  {updateState.status === "installing" ? (
                    <>
                      <RefreshCwIcon className="animate-spin" />
                      正在下载并安装…
                    </>
                  ) : (
                    "安装更新并重启"
                  )}
                </Button>
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
              <p className="text-muted-foreground text-xs">
                更新服务未配置，开发环境下不支持自动更新。
              </p>
            ) : null}
            {updateState.status === "idle" ||
            updateState.status === "checking" ||
            updateState.status === "up-to-date" ? (
              <p className="text-muted-foreground text-xs">
                {updateState.status === "checking"
                  ? "正在读取更新清单…"
                  : `MelodyWork ${updateCheckDescription}`}
              </p>
            ) : null}
          </div>
          {repositoryError ? (
            <p
              aria-live="assertive"
              className="border-t px-5 py-3 text-destructive text-xs"
              role="alert"
            >
              无法打开 GitHub 仓库：{repositoryError}
            </p>
          ) : null}
        </section>

        <section
          aria-labelledby="about-history-title"
          className="overflow-hidden rounded-xl border bg-card"
        >
          <PanelHeader
            action={
              <Button
                disabled={releaseHistoryState === "loading"}
                onClick={() => void refreshReleaseHistory()}
                size="sm"
                variant="secondary"
              >
                <RefreshCwIcon
                  className={cn(
                    releaseHistoryState === "loading" && "animate-spin",
                  )}
                />
                刷新
              </Button>
            }
            description="查看已发布版本和对应的更新说明。"
            title={
              <>
                <HistoryIcon className="size-4 text-muted-foreground" />
                <span id="about-history-title">版本历史</span>
              </>
            }
          />
          <div className="divide-y">
            {releaseHistory.map((release) => {
              const version = releaseVersion(release.tagName);
              const isCurrent = version === currentVersion;
              return (
                <details className="group" key={release.tagName}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">
                          {release.tagName}
                        </span>
                        {isCurrent ? <Badge>当前</Badge> : null}
                        {release.isPrerelease ? (
                          <Badge variant="outline">测试版</Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-muted-foreground text-xs">
                        {release.name}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
                      <span>{formatReleaseDate(release.publishedAt)}</span>
                      <ChevronDownIcon className="size-4 transition-transform group-open:rotate-180" />
                    </div>
                  </summary>
                  <div className="border-t bg-muted/20 px-5 py-4">
                    <p className="whitespace-pre-wrap text-muted-foreground text-xs">
                      {release.body?.trim() || "此版本未提供更新说明。"}
                    </p>
                    <Button
                      className="mt-3"
                      onClick={(event) => {
                        event.preventDefault();
                        void openExternalUrl(release.url);
                      }}
                      size="xs"
                      variant="ghost"
                    >
                      查看发布详情
                      <ExternalLinkIcon />
                    </Button>
                  </div>
                </details>
              );
            })}
          </div>
          {releaseHistoryState === "error" ? (
            <p className="border-t px-5 py-3 text-muted-foreground text-xs">
              无法读取在线版本历史，当前显示内置记录。
            </p>
          ) : null}
        </section>

        <section
          aria-labelledby="about-environment-title"
          className="overflow-hidden rounded-xl border bg-card"
        >
          <PanelHeader
            action={
              <Button
                disabled={environmentState === "loading"}
                onClick={() => void refreshEnvironmentCapabilities()}
                size="sm"
                variant="secondary"
              >
                <RefreshCwIcon
                  className={cn(
                    environmentState === "loading" && "animate-spin",
                  )}
                />
                重新检查
              </Button>
            }
            description="基础 Agent 无需 Node.js 或 Git；按需安装后可启用 MCP、Git 变更视图等能力。"
            title={
              <>
                <MonitorIcon className="size-4 text-muted-foreground" />
                <span id="about-environment-title">可选环境能力</span>
              </>
            }
          />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {environmentCapabilities.map((capability) => (
              <CapabilityCard capability={capability} key={capability.name} />
            ))}
            {!isTauriRuntime() ? (
              <p className="sm:col-span-2 rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-xs">
                浏览器预览不会读取本机环境；在桌面版中可以检查 Node.js 和 Git
                的实际安装状态。
              </p>
            ) : null}
            {isTauriRuntime() && environmentState === "loading" ? (
              <p className="sm:col-span-2 text-muted-foreground text-xs">
                正在检查本机环境…
              </p>
            ) : null}
            {isTauriRuntime() &&
            environmentState === "ready" &&
            environmentCapabilities.length === 0 ? (
              <p className="sm:col-span-2 text-muted-foreground text-xs">
                暂未检测到可选环境能力。
              </p>
            ) : null}
            {environmentState === "error" ? (
              <p className="sm:col-span-2 text-destructive text-xs">
                环境检查失败，请点击“重新检查”再试。
              </p>
            ) : null}
          </div>
        </section>
      </div>

      <p className="mt-8 text-center text-muted-foreground text-xs">
        © {new Date().getFullYear()} Lhy723. All rights reserved.
      </p>
    </div>
  );
}
