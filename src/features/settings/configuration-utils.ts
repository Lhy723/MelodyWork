import type { MelodyConfigValue } from "@/domain/config";

import type { ConfigObject, ConfigValues } from "./configuration-types";
import { valueAt } from "./configuration-controls";

export function objectEntries(
  values: ConfigValues,
  path: string[],
): [string, MelodyConfigValue][] {
  const value = valueAt(values, path);
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

export function configObject(
  value: MelodyConfigValue | undefined,
): ConfigObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

export function stringConfigValue(object: ConfigObject, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value : "";
}
