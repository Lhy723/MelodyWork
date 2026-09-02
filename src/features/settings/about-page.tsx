import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { ExternalLinkIcon, MonitorIcon, ScaleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import appPackage from "../../../package.json";
import appIcon from "../../../src-tauri/icons/128x128.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/domain/app-error";
import {
  checkAppUpdate,
  getAppReleaseHistory,
  getEnvironmentCapabilities,
  isTauriRuntime,
  openExternalUrl,
  type AppReleaseHistoryItem,
  type EnvironmentCapability,
} from "@/lib/melody-bridge";
import { useAppSettingsStore } from "@/stores/app-settings-store";

import { AboutEnvironmentPanel } from "./about-environment-panel";
import { AboutHistoryPanel } from "./about-history-panel";
import { AboutUpdatePanel } from "./about-update-panel";
import { GithubMark, InfoRow } from "./about-ui";
import {
  fallbackReleaseHistory,
  GITHUB_REPO_URL,
  type UpdateCheckState,
} from "./about-types";

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

  const hasUpdateDetails =
    updateState.status === "available" ||
    updateState.status === "installing" ||
    updateState.status === "error";

  const refreshReleaseHistory = useCallback(async () => {
    setReleaseHistoryState("loading");
    try {
      const releases = await getAppReleaseHistory();
      setReleaseHistory(
        releases.length > 0 ? releases : fallbackReleaseHistory,
      );
      setReleaseHistoryState("ready");
    } catch (reason) {
      setReleaseHistory(fallbackReleaseHistory);
      setReleaseHistoryState("error");
      throw reason;
    }
  }, []);

  const refreshEnvironmentCapabilities = useCallback(async () => {
    setEnvironmentState("loading");
    try {
      const capabilities = await getEnvironmentCapabilities();
      setEnvironmentCapabilities(
        capabilities.filter((capability) => capability.installed),
      );
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
      if (channel !== useAppSettingsStore.getState().updateChannel) return;
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
      throw reason;
    }
  };

  const installUpdate = async () => {
    if (updateState.status !== "available") return;
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
      throw reason;
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
    if (!isTauriRuntime()) return;
    let active = true;
    void getVersion()
      .then((version) => {
        if (active) setCurrentVersion(version);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void refreshReleaseHistory().catch(() => undefined);
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

        <AboutUpdatePanel
          autoCheckForUpdates={autoCheckForUpdates}
          hasUpdateDetails={hasUpdateDetails}
          onCheck={checkForUpdate}
          onInstall={installUpdate}
          onSetAutoCheck={(enabled) =>
            setAppSetting("autoCheckForUpdates", enabled)
          }
          onSetChannel={(channel) => setAppSetting("updateChannel", channel)}
          updateChannel={updateChannel}
          updateState={updateState}
        />
        {repositoryError ? (
          <p
            aria-live="assertive"
            className="border-t px-5 py-3 text-destructive text-xs"
            role="alert"
          >
            无法打开 GitHub 仓库：{repositoryError}
          </p>
        ) : null}

        <AboutHistoryPanel
          currentVersion={currentVersion}
          onOpenRelease={(url) => void openExternalUrl(url)}
          onRefresh={refreshReleaseHistory}
          releaseHistory={releaseHistory}
          state={releaseHistoryState}
        />
        <AboutEnvironmentPanel
          capabilities={environmentCapabilities}
          state={environmentState}
          tauriRuntime={isTauriRuntime()}
        />
      </div>

      <p className="mt-8 text-center text-muted-foreground text-xs">
        © {new Date().getFullYear()} Lhy723. All rights reserved.
      </p>
    </div>
  );
}
