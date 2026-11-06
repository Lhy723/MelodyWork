import type { AgentRunConfig } from "../index.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reject C0 controls and DEL in identifiers, paths, patterns, and prompts.
 *
 * A control character never appears in a legitimate value at this boundary and
 * can smuggle a NUL or newline past a consumer that compares or logs the text.
 * This is one shared predicate so the host, the worker, and the renderer all
 * apply the same rule.
 */
export const containsControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
};

/**
 * Remove C0 controls and DEL from text that will be embedded in a prompt.
 *
 * This is the sanitizing counterpart of `containsControlCharacters`: the
 * predicate rejects hostile input at a validation boundary, while this keeps
 * `\n`/`\t` and drops everything else so terminal escape sequences cannot ride
 * into a model prompt.
 */
export const withoutControlCharacters = (
  value: string,
  keep = "\n\t",
): string => {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint < 0x20 || codePoint === 0x7f) && !keep.includes(character)) {
      continue;
    }
    sanitized += character;
  }
  return sanitized;
};

export const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} 必须是非空字符串。`);
  }
  return value;
};

export const optionalString = (value: unknown, field: string) => {
  if (value !== undefined) requireString(value, field);
};

const permissionModes = new Set<AgentRunConfig["permissionMode"]>([
  "ask",
  "auto",
  "always-approve",
]);

export const isPermissionMode = (
  value: unknown,
): value is AgentRunConfig["permissionMode"] =>
  permissionModes.has(value as AgentRunConfig["permissionMode"]);

export const validatePermissionMode = (value: unknown, field: string) => {
  if (!isPermissionMode(value)) {
    throw new Error(`${field} 不是受支持的权限模式。`);
  }
};
