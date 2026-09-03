export type MelodyConfigScope = "user" | "project";
export type MelodyExtensionKind = "skills" | "plugins" | "hooks";
export type MelodyConfigValue =
  | string
  | number
  | boolean
  | null
  | MelodyConfigValue[]
  | { [key: string]: MelodyConfigValue };

export interface MelodyConfigPatch {
  path: string[];
  value: MelodyConfigValue;
}

export interface MelodyConfigDocument {
  scope: MelodyConfigScope;
  path: string;
  exists: boolean;
  content: string;
  values: Record<string, MelodyConfigValue>;
  parseError?: string;
}

export interface MelodyExtension {
  kind: MelodyExtensionKind;
  name: string;
  path: string;
  scope: MelodyConfigScope;
  provider: "melody" | "agents" | "claude" | "cursor" | "plugin" | string;
  managed: boolean;
  enabled: boolean;
  description?: string;
  source?: string;
  pluginName?: string;
  userInvocable?: boolean;
  compatibilityStatus?: string;
  deletable?: boolean;
}

export interface MarketplaceSource {
  name: string;
  kind: "git" | "local";
  location: string;
  branch?: string;
}

export interface MarketplacePlugin {
  name: string;
  marketplace: string;
  status: "installed" | "available";
  version?: string;
  installedVersion?: string;
  description?: string;
  updateAvailable: boolean;
  skillCount: number;
  hasHooks: boolean;
  hasAgents: boolean;
  hasMcp: boolean;
}

export interface PluginComponentGroup {
  kind: "skills" | "commands" | "agents" | "hooks" | "mcps" | "lsps";
  items: string[];
}

export interface PluginDetails {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  path: string;
  manifestPath?: string;
  components: PluginComponentGroup[];
}

export interface SkillDetails {
  name: string;
  description?: string;
  license?: string;
  compatibility?: string;
  path: string;
  skillPath: string;
  files: string[];
  content: string;
}
