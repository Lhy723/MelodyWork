import { relaunch } from "@tauri-apps/plugin-process";
import {
  CheckCircleIcon,
  ExternalLinkIcon,
  InfoIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import appPackage from "../../../package.json";
import { Button } from "@/components/ui/button";
import { checkAppUpdate } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

type UpdateCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date" }
  | {
      status: "available";
      version: string;
      notes?: string;
    }
  | { status: "installing" }
  | { status: "installed" }
  | { status: "error"; message: string }
  | { status: "not-configured" };

const GITHUB_REPO_URL = "https://github.com/Lhy723/MelodyWork";

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
  const [updateState, setUpdateState] = useState<UpdateCheckState>({
    status: "idle",
  });

  const isBusy =
    updateState.status === "checking" || updateState.status === "installing";

  const checkForUpdate = async () => {
    setUpdateState({ status: "checking" });
    try {
      const result = await checkAppUpdate(false);
      if (!result.configured) {
        setUpdateState({ status: "not-configured" });
      } else if (result.available && result.version) {
        setUpdateState({
          status: "available",
          version: result.version,
          notes: result.notes,
        });
      } else {
        setUpdateState({ status: "up-to-date" });
      }
    } catch (reason) {
      setUpdateState({
        status: "error",
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };

  const installUpdate = async () => {
    setUpdateState({ status: "installing" });
    try {
      await checkAppUpdate(true);
      setUpdateState({ status: "installed" });
      await relaunch();
    } catch (reason) {
      setUpdateState({
        status: "error",
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };

  useEffect(() => {
    void checkForUpdate();
  }, []);

  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="flex flex-col items-center text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10">
          <span className="font-bold text-primary text-3xl">M</span>
        </div>
        <h2 className="mt-5 font-semibold text-2xl">MelodyWork</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          对话优先的 Melody Build 桌面客户端
        </p>

        <div className="mt-4 flex items-center gap-2">
          <span className="rounded-full bg-muted px-3 py-1 font-mono text-muted-foreground text-xs">
            v{appPackage.version}
          </span>
        </div>

        <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
          <Button
            className="w-full"
            disabled={isBusy}
            onClick={() => void checkForUpdate()}
            variant="outline"
          >
            <RefreshCwIcon
              className={cn("mr-2 size-4", isBusy && "animate-spin")}
            />
            {updateState.status === "checking"
              ? "正在检查更新…"
              : "检查更新"}
          </Button>

          <a
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border bg-background px-4 py-2 font-medium text-sm shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            href={GITHUB_REPO_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GithubMark className="size-4" />
            GitHub 仓库
            <ExternalLinkIcon className="size-3 text-muted-foreground" />
          </a>
        </div>

        <div className="mt-8 w-full">
          {updateState.status === "up-to-date" ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border bg-green-50 px-4 py-3 text-green-700 text-sm dark:bg-green-950/30 dark:text-green-400">
              <CheckCircleIcon className="size-4" />
              当前已是最新版本
            </div>
          ) : null}

          {updateState.status === "available" ||
          updateState.status === "installing" ? (
            <div className="rounded-lg border p-4 text-left">
              <div className="flex items-center gap-2">
                <InfoIcon className="size-4 text-blue-500" />
                <p className="font-medium text-sm">
                  发现新版本 v{updateState.status === "available" ? updateState.version : ""}
                </p>
              </div>
              {updateState.status === "available" && updateState.notes ? (
                <p className="mt-2 whitespace-pre-wrap text-muted-foreground text-xs">
                  {updateState.notes}
                </p>
              ) : null}
              <Button
                className="mt-3 w-full"
                disabled={updateState.status === "installing"}
                onClick={() => void installUpdate()}
              >
                {updateState.status === "installing" ? (
                  <>
                    <RefreshCwIcon className="mr-2 size-4 animate-spin" />
                    正在下载并安装…
                  </>
                ) : (
                  "安装更新并重启"
                )}
              </Button>
            </div>
          ) : null}

          {updateState.status === "error" ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive text-sm">
              检查更新失败：{updateState.message}
            </div>
          ) : null}

          {updateState.status === "not-configured" ? (
            <p className="text-muted-foreground text-xs">
              更新服务未配置，开发环境下不支持自动更新。
            </p>
          ) : null}
        </div>

        <p className="mt-10 text-muted-foreground text-xs">
          © {new Date().getFullYear()} Lhy723. All rights reserved.
        </p>
      </div>
    </div>
  );
}
