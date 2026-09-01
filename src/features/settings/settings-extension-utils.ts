import type { MelodyExtension } from "@/domain/config";

export const skillSourceLabel = (skill: MelodyExtension) => {
  if (skill.pluginName) {
    return `插件 · ${skill.pluginName}`;
  }
  if (skill.source === "bundled") {
    return "内置";
  }
  if (skill.source === "server") {
    return "服务端";
  }
  return (
    {
      agents: "Agents",
      claude: "Claude",
      cursor: "Cursor",
      melody: "Melody",
      plugin: "插件",
    }[skill.provider] ?? skill.provider
  );
};

export const skillSourceGroups = [
  {
    id: "melody",
    label: "Melody",
    description: "来自 Melody 用户目录或当前项目的技能。",
  },
  {
    id: "agents",
    label: "Agents",
    description: "来自通用 .agents 技能目录。",
  },
  {
    id: "plugin",
    label: "插件",
    description: "由当前启用的插件提供的技能。",
  },
  {
    id: "claude",
    label: "Claude",
    description: "通过 Claude Code 兼容层发现的技能。",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "通过 Cursor 兼容层发现的技能。",
  },
  {
    id: "managed",
    label: "内置与服务端",
    description: "由 Melody 内置或服务端同步的技能。",
  },
  {
    id: "other",
    label: "其他来源",
    description: "来自额外技能路径的其他技能。",
  },
] as const;

export type SkillSourceGroupId = (typeof skillSourceGroups)[number]["id"];

export const skillSourceGroupId = (
  skill: MelodyExtension,
): SkillSourceGroupId => {
  if (skill.source === "bundled" || skill.source === "server") {
    return "managed";
  }
  if (skill.source === "plugin" || skill.pluginName) {
    return "plugin";
  }
  if (
    skill.provider === "melody" ||
    skill.path.includes("/.melody/") ||
    skill.path.includes("\\.melody\\")
  ) {
    return "melody";
  }
  if (skill.provider === "agents") {
    return "agents";
  }
  if (skill.provider === "claude") {
    return "claude";
  }
  if (skill.provider === "cursor") {
    return "cursor";
  }
  return "other";
};
