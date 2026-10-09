import { PuzzleIcon, SparklesIcon, WebhookIcon } from "lucide-react";

import type { MelodyExtensionKind } from "@/domain/config";

export type SettingsPage =
  | "configuration"
  | "statistics"
  | "skills"
  | "plugins"
  | "hooks"
  | "permissions"
  | "about";

export const kindLabel: Record<MelodyExtensionKind, string> = {
  skills: "技能",
  plugins: "插件",
  hooks: "钩子",
};

export const kindDescription: Record<MelodyExtensionKind, string> = {
  skills: "查看 Pi 会话实际加载的技能，以及当前停用的技能。",
  plugins: "管理 Melody 插件以及兼容的 Claude Code 插件。",
  hooks: "查看在 Melody 生命周期事件中运行的钩子。",
};

export const kindIcon = {
  skills: SparklesIcon,
  plugins: PuzzleIcon,
  hooks: WebhookIcon,
} satisfies Record<MelodyExtensionKind, typeof SparklesIcon>;
