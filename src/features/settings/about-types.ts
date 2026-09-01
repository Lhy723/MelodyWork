import type { ReactNode } from "react";

import type { AppReleaseHistoryItem } from "@/lib/melody-bridge";
import type { UpdateChannel } from "@/stores/app-settings-store";

export type UpdateCheckState =
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

export const GITHUB_REPO_URL = "https://github.com/Lhy723/MelodyWork";

export const updateChannelLabel: Record<UpdateChannel, string> = {
  stable: "正式版",
  beta: "测试版",
};

export const fallbackReleaseHistory: AppReleaseHistoryItem[] = [
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

export const formatReleaseDate = (value?: string) => {
  if (!value) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
};

export const releaseVersion = (tagName: string) =>
  tagName.startsWith("v") ? tagName.slice(1) : tagName;

export interface AboutInfoRowProps {
  label: string;
  description?: string;
  children: ReactNode;
}
