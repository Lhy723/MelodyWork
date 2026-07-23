export type MelodyConfigScope = "user" | "project";
export type MelodyExtensionKind = "skills" | "plugins" | "hooks";

export interface MelodyConfigDocument {
  scope: MelodyConfigScope;
  path: string;
  exists: boolean;
  content: string;
}

export interface MelodyExtension {
  kind: MelodyExtensionKind;
  name: string;
  path: string;
  scope: MelodyConfigScope;
}
