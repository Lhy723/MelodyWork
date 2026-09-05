import { MonitorIcon, NetworkIcon, Settings2Icon } from "lucide-react";

import type { MelodyConfigScope } from "@/domain/config";

import { configurationUserSections } from "./configuration-user-sections";
import type { SettingSection } from "./configuration-types";

export interface ConfigurationNavigationItem {
  id: string;
  label: string;
  icon: typeof Settings2Icon;
}

export const compatibilityGroups = [
  {
    id: "agents",
    label: "Agents",
    description: "控制跨智能体工具共享的 .agents 通用技能目录。",
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "兼容 ~/.claude 与项目 .claude 中的约定和资源。",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "兼容 ~/.cursor 与项目 .cursor 中的约定和资源。",
  },
  {
    id: "codex",
    label: "Codex",
    description: "仅显示 MelodyBuild 当前提供的 Codex 兼容能力。",
  },
] as const;

export const configurationSections = (
  scope: MelodyConfigScope,
): SettingSection[] =>
  scope === "project"
    ? [
        {
          id: "mcp",
          label: "MCP",
          description: "仅为当前项目提供的工具服务器。",
          icon: NetworkIcon,
          settings: [],
        },
      ]
    : [
        {
          id: "general",
          label: "常规",
          description: "应用权限、编辑器、窗口与通知偏好。",
          icon: Settings2Icon,
          settings: [],
        },
        {
          id: "appearance",
          label: "外观",
          description: "主题、颜色、字体和视觉偏好。",
          icon: MonitorIcon,
          settings: [],
        },
        ...configurationUserSections.slice(0, 7),
        {
          id: "mcp",
          label: "MCP",
          description: "连接本地或远程工具服务器。",
          icon: NetworkIcon,
          settings: [],
        },
        ...configurationUserSections.slice(7),
      ];

export const getConfigurationNavigation = (
  scope: MelodyConfigScope,
): ConfigurationNavigationItem[] =>
  configurationSections(scope).map(({ id, label, icon }) => ({
    id,
    label,
    icon,
  }));
