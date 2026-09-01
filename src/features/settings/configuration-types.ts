import type { AgentModelOption } from "@/domain/acp";
import type { MelodyConfigScope, MelodyConfigValue } from "@/domain/config";
import type { LucideIcon } from "lucide-react";

export type ConfigValues = Record<string, MelodyConfigValue>;
export type ConfigObject = Record<string, MelodyConfigValue>;

export interface ConfigurationFormProps {
  availableModels: AgentModelOption[];
  sectionId: string;
  scope: MelodyConfigScope;
  values: ConfigValues;
  onChange: (path: string[], value: MelodyConfigValue) => void;
  onReload?: () => void;
  reloadDisabled?: boolean;
  reloadLoading?: boolean;
}

export type SettingKind =
  | "agents-skills-source"
  | "boolean"
  | "key-value"
  | "number"
  | "select"
  | "string"
  | "string-list";

export interface SettingDefinition {
  path: string[];
  label: string;
  description: string;
  kind: SettingKind;
  defaultValue?: string | number | boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  clearValue?: string;
  secret?: boolean;
  numberValues?: boolean;
}

export interface SettingSection {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  settings: SettingDefinition[];
}

export interface CompatibilityGroup {
  id: string;
  label: string;
  description: string;
}
