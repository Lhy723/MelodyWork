import { invoke } from "@tauri-apps/api/core";

import type {
  MelodyConfigDocument,
  MelodyConfigPatch,
  MelodyConfigScope,
  MelodyConfigValue,
  MelodyExtension,
  MarketplaceSource,
  MarketplacePlugin,
  PluginDetails,
  SkillDetails,
} from "@/domain/config";
import type { PermissionDecision, PermissionRule } from "@/domain/permission";
import { isTauriRuntime } from "./melody-bridge-runtime";

export const readMelodyConfig = async (
  scope: MelodyConfigScope,
  cwd: string,
): Promise<MelodyConfigDocument> => {
  if (!isTauriRuntime()) {
    return {
      scope,
      path:
        scope === "user"
          ? "~/.melody/config.toml"
          : `${cwd}/.melody/config.toml`,
      exists: scope === "user",
      content:
        scope === "user"
          ? '[models]\ndefault = "grok-4.5"\n\n[mcp_servers.filesystem]\ncommand = "mcp-server-filesystem"\n'
          : "# Project-specific Melody configuration\n",
      values:
        scope === "user"
          ? {
              models: { default: "grok-4.5" },
              mcp_servers: {
                filesystem: { command: "mcp-server-filesystem" },
              },
            }
          : {},
    };
  }
  return invoke<MelodyConfigDocument>("read_melody_config", { scope, cwd });
};

const applyPreviewPatch = (
  target: Record<string, MelodyConfigValue>,
  patch: MelodyConfigPatch,
) => {
  const [leaf] = patch.path.slice(-1);
  if (!leaf) {
    return;
  }
  let table = target;
  for (const key of patch.path.slice(0, -1)) {
    const current = table[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      table[key] = {};
    }
    table = table[key] as Record<string, MelodyConfigValue>;
  }
  if (patch.value === null) {
    delete table[leaf];
  } else {
    table[leaf] = patch.value;
  }
};

export const updateMelodyConfig = async (
  scope: MelodyConfigScope,
  cwd: string,
  patches: MelodyConfigPatch[],
): Promise<MelodyConfigDocument> => {
  if (isTauriRuntime()) {
    return invoke<MelodyConfigDocument>("update_melody_config", {
      scope,
      cwd,
      patches,
    });
  }
  const document = await readMelodyConfig(scope, cwd);
  const values = structuredClone(document.values);
  patches.forEach((patch) => applyPreviewPatch(values, patch));
  return { ...document, exists: true, values };
};

export const listMelodyExtensions = async (
  cwd: string,
): Promise<MelodyExtension[]> =>
  isTauriRuntime()
    ? invoke<MelodyExtension[]>("list_melody_extensions", { cwd })
    : [
        {
          kind: "skills",
          name: "code-review",
          path: "~/.melody/skills/code-review",
          scope: "user",
          provider: "melody",
          managed: false,
          enabled: true,
        },
        {
          kind: "plugins",
          name: "git-tools",
          path: `${cwd}/.melody/plugins/git-tools`,
          scope: "project",
          provider: "melody",
          managed: false,
          enabled: true,
        },
        {
          kind: "hooks",
          name: "after-tool.sh",
          path: `${cwd}/.melody/hooks/after-tool.sh`,
          scope: "project",
          provider: "melody",
          managed: false,
          enabled: true,
        },
      ];

export const listMelodySkills = async (
  cwd: string,
): Promise<MelodyExtension[]> =>
  isTauriRuntime()
    ? invoke<MelodyExtension[]>("list_melody_skills", { cwd })
    : [
        {
          kind: "skills",
          name: "code-review",
          description: "检查代码质量、风险与测试覆盖。",
          path: "~/.melody/skills/code-review",
          scope: "user",
          provider: "melody",
          source: "user",
          managed: false,
          enabled: true,
          userInvocable: true,
          deletable: true,
        },
        {
          kind: "skills",
          name: "ai-elements",
          description: "构建 AI 对话界面和工具调用体验。",
          path: "~/.agents/skills/ai-elements",
          scope: "user",
          provider: "agents",
          source: "user",
          managed: false,
          enabled: true,
          userInvocable: true,
          deletable: false,
        },
        {
          kind: "skills",
          name: "swiftui-patterns",
          description: "使用成熟的 SwiftUI 模式构建 macOS 界面。",
          path: "~/.claude/skills/swiftui-patterns",
          scope: "user",
          provider: "claude",
          source: "user",
          managed: false,
          enabled: false,
          compatibilityStatus: "disabled",
          userInvocable: true,
          deletable: false,
        },
        {
          kind: "skills",
          name: "mattpocock-skills:implement",
          description: "按照既定方案实现经过验证的代码变更。",
          path: "~/.melody/installed-plugins/mattpocock-skills/skills/implement",
          scope: "user",
          provider: "plugin",
          source: "plugin",
          pluginName: "mattpocock-skills",
          managed: true,
          enabled: true,
          userInvocable: true,
          deletable: false,
        },
      ];

export const listMarketplaceSources = async (): Promise<MarketplaceSource[]> =>
  isTauriRuntime()
    ? invoke<MarketplaceSource[]>("list_marketplace_sources")
    : [
        {
          name: "xAI Official",
          kind: "git",
          location: "https://github.com/melody-org/plugin-marketplace.git",
        },
      ];

export const addMarketplaceSource = async (
  input: string,
): Promise<MarketplaceSource[]> =>
  isTauriRuntime()
    ? invoke<MarketplaceSource[]>("add_marketplace_source", { input })
    : [
        {
          name:
            input
              .split("/")
              .at(-1)
              ?.replace(/\.git$/, "") || "plugins",
          kind:
            input.startsWith(".") || input.startsWith("/") ? "local" : "git",
          location: input,
        },
      ];

export const saveMarketplaceSource = async (
  originalName: string | undefined,
  source: MarketplaceSource,
): Promise<MarketplaceSource[]> =>
  isTauriRuntime()
    ? invoke<MarketplaceSource[]>("save_marketplace_source", {
        originalName,
        source,
      })
    : [source];

export const deleteMarketplaceSource = async (
  name: string,
): Promise<MarketplaceSource[]> =>
  isTauriRuntime()
    ? invoke<MarketplaceSource[]>("delete_marketplace_source", { name })
    : [];

export interface PluginInstallResult {
  source: string;
  message: string;
}

export const installMelodyPlugin = async (
  cwd: string,
  source: string,
): Promise<PluginInstallResult> =>
  isTauriRuntime()
    ? invoke<PluginInstallResult>("install_melody_plugin", { cwd, source })
    : {
        source,
        message: `已从 ${source} 安装插件。`,
      };

export const scanMarketplacePlugins = async (
  cwd: string,
  refresh = false,
): Promise<MarketplacePlugin[]> =>
  isTauriRuntime()
    ? invoke<MarketplacePlugin[]>("scan_marketplace_plugins", {
        cwd,
        refresh,
      })
    : [
        {
          name: "code-review",
          marketplace: "xAI Official",
          status: "installed",
          installedVersion: "1.2.0",
          skillCount: 1,
          hasHooks: false,
          hasAgents: true,
          hasMcp: false,
        },
        {
          name: "web-tools",
          marketplace: "xAI Official",
          status: "available",
          version: "0.8.1",
          description: "网页搜索与内容提取工具。",
          skillCount: 2,
          hasHooks: false,
          hasAgents: false,
          hasMcp: true,
        },
      ];

export const updateMelodyPlugin = async (
  cwd: string,
  name: string,
): Promise<PluginInstallResult> =>
  isTauriRuntime()
    ? invoke<PluginInstallResult>("update_melody_plugin", { cwd, name })
    : {
        source: name,
        message: `${name} 已是最新版本。`,
      };

export const listInstalledMelodyPlugins = async (
  cwd: string,
): Promise<MelodyExtension[]> =>
  isTauriRuntime()
    ? invoke<MelodyExtension[]>("list_installed_melody_plugins", { cwd })
    : [];

export const setMelodyExtensionEnabled = async (
  cwd: string,
  extension: MelodyExtension,
  enabled: boolean,
): Promise<void> => {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("set_melody_extension_enabled", {
    scope: extension.scope,
    cwd,
    kind: extension.kind,
    name: extension.name,
    enabled,
  });
};

export const uninstallMelodyPlugin = async (
  cwd: string,
  name: string,
  keepData = false,
): Promise<string> =>
  isTauriRuntime()
    ? invoke<string>("uninstall_melody_plugin", { cwd, name, keepData })
    : `已删除插件 ${name}。`;

export const getMelodyPluginDetails = async (
  cwd: string,
  plugin: MelodyExtension,
): Promise<PluginDetails> =>
  isTauriRuntime()
    ? invoke<PluginDetails>("get_melody_plugin_details", {
        cwd,
        name: plugin.name,
        path: plugin.path,
      })
    : {
        name: plugin.name,
        version: "1.0.0",
        description: "为 Melody 提供额外的开发能力。",
        path: plugin.path,
        manifestPath: `${plugin.path}/plugin.json`,
        components: [
          { kind: "skills", items: ["code-review"] },
          { kind: "commands", items: ["review"] },
          { kind: "agents", items: ["reviewer"] },
          { kind: "hooks", items: ["PreToolUse"] },
          { kind: "mcps", items: ["github"] },
          { kind: "lsps", items: [] },
        ],
      };

export const getMelodySkillDetails = async (
  cwd: string,
  skill: MelodyExtension,
): Promise<SkillDetails> =>
  isTauriRuntime()
    ? invoke<SkillDetails>("get_melody_skill_details", {
        cwd,
        name: skill.name,
        path: skill.path,
      })
    : {
        name: skill.name,
        description:
          skill.description ?? "查看技能说明、包含的文件和安装位置。",
        license: "MIT",
        compatibility: "Melody 0.0.1+",
        path: skill.path,
        skillPath: `${skill.path}/SKILL.md`,
        files: ["SKILL.md", "references/checklist.md"],
        content: `---\nname: ${skill.name}\ndescription: ${
          skill.description ?? "查看技能说明、包含的文件和安装位置。"
        }\n---\n\n# ${skill.name}\n\n这是浏览器预览中的技能详情。`,
      };

export const deleteMelodySkill = async (
  cwd: string,
  skill: MelodyExtension,
): Promise<string> =>
  isTauriRuntime()
    ? invoke<string>("delete_melody_skill", {
        cwd,
        name: skill.name,
        path: skill.path,
      })
    : `已删除技能 ${skill.name}。`;

export const listPermissionRules = async (
  projectId: string,
): Promise<PermissionRule[]> =>
  isTauriRuntime()
    ? invoke<PermissionRule[]>("list_permission_rules", { projectId })
    : [];

export const findPermissionRule = async (
  projectId: string,
  toolKey: string,
): Promise<PermissionRule | undefined> =>
  isTauriRuntime()
    ? ((await invoke<PermissionRule | null>("find_permission_rule", {
        projectId,
        toolKey,
      })) ?? undefined)
    : undefined;

export const upsertPermissionRule = async (request: {
  projectId: string;
  toolKey: string;
  title: string;
  command: string;
  decision: PermissionDecision;
}): Promise<PermissionRule> =>
  isTauriRuntime()
    ? invoke<PermissionRule>("upsert_permission_rule", request)
    : {
        id: `preview-rule-${Date.now()}`,
        ...request,
        createdAt: Math.floor(Date.now() / 1000),
      };

export const deletePermissionRule = async (
  projectId: string,
  id: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("delete_permission_rule", { projectId, id });
  }
};
