import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  containsControlCharacters,
  withoutControlCharacters,
} from "@melody/agent-contract";

export interface PiScopedInstructionFile {
  path: string;
  content: string;
}

const MAX_SCOPED_INSTRUCTION_FILES = 32;
const MAX_SCOPED_INSTRUCTION_FILE_CHARS = 32_768;
const MAX_SCOPED_INSTRUCTION_TOTAL_CHARS = 65_536;
const MAX_HOST_RESPONSE_CHARS = 80_000;

const boundedInstruction = (value: unknown): PiScopedInstructionFile => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Host returned a malformed scoped instruction file.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.path !== "string" ||
    !candidate.path.trim() ||
    candidate.path.length > 4096 ||
    containsControlCharacters(candidate.path) ||
    typeof candidate.content !== "string" ||
    candidate.content.length > MAX_SCOPED_INSTRUCTION_FILE_CHARS
  ) {
    throw new Error(
      "Host returned an invalid or oversized project instruction file.",
    );
  }
  return { path: candidate.path, content: candidate.content };
};

const safePromptContent = (content: string): string =>
  withoutControlCharacters(content).replace(
    /<\/project_instructions\s*>/giu,
    "[project_instructions end]",
  );

const promptPath = (path: string): string =>
  path
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export interface PiInstructionScope {
  /** Add Host-validated files and report whether the next prompt must refresh. */
  activate(files: readonly unknown[]): number;
  /** Seed instructions already present in Pi's initial context without a retry. */
  seed(files: readonly unknown[]): void;
  /** The Pi extension that adds activated files to the next system prompt. */
  extensionFactory: ExtensionFactory;
}

export const parsePiInstructionScopeOutput = (
  output: string,
): PiScopedInstructionFile[] => {
  if (output.length > MAX_HOST_RESPONSE_CHARS) {
    throw new Error("Host scoped-instruction response is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Host returned an invalid scoped-instruction response.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray((value as Record<string, unknown>).files)
  ) {
    throw new Error("Host returned an invalid scoped-instruction response.");
  }
  const files = (value as { files: unknown[] }).files;
  if (files.length > MAX_SCOPED_INSTRUCTION_FILES) {
    throw new Error("Host returned too many scoped project instruction files.");
  }
  return files.map(boundedInstruction);
};

/**
 * Holds only paths/content returned by the authenticated Host's scoped-file
 * lookup. The Pi hook places them in its native project-instructions section
 * before the next model request; merely probing a path never authorizes I/O.
 */
export const createPiInstructionScope = (): PiInstructionScope => {
  const files = new Map<string, string>();
  let pendingPromptRefresh = false;

  const merge = (values: readonly unknown[]): number => {
    if (values.length > MAX_SCOPED_INSTRUCTION_FILES) {
      throw new Error(
        "Host returned too many scoped project instruction files.",
      );
    }
    const normalized = values.map(boundedInstruction);
    const projected = new Map(files);
    let changed = 0;
    for (const file of normalized) {
      if (projected.get(file.path) === file.content) continue;
      projected.set(file.path, file.content);
      changed += 1;
    }
    const nextTotal = [...projected.values()].reduce(
      (sum, content) => sum + content.length,
      0,
    );
    if (projected.size > MAX_SCOPED_INSTRUCTION_FILES) {
      throw new Error("Scoped project instructions exceeded their file limit.");
    }
    if (nextTotal > MAX_SCOPED_INSTRUCTION_TOTAL_CHARS) {
      throw new Error("Scoped project instructions exceeded their text limit.");
    }
    files.clear();
    for (const [path, content] of projected) files.set(path, content);
    return changed;
  };

  const activate = (values: readonly unknown[]): number => {
    if (merge(values) > 0) pendingPromptRefresh = true;
    // A second concurrent tool call must not escape the preflight while a
    // newly discovered instruction is waiting for before_agent_start.
    return pendingPromptRefresh ? 1 : 0;
  };

  const seed = (values: readonly unknown[]): void => {
    merge(values);
    pendingPromptRefresh = false;
  };

  const extensionFactory: ExtensionFactory = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
      if (files.size === 0) return;
      const contextFiles = event.systemPromptOptions.contextFiles;
      const indexes = new Map(
        contextFiles.map((file, index) => [file.path, index] as const),
      );
      for (const [path, content] of files) {
        const file = {
          path: promptPath(path),
          content: safePromptContent(content),
        };
        const index = indexes.get(file.path);
        if (index === undefined) {
          indexes.set(file.path, contextFiles.length);
          contextFiles.push(file);
        } else {
          contextFiles[index] = file;
        }
      }
      pendingPromptRefresh = false;
    });
  };

  return {
    activate,
    seed,
    extensionFactory,
  };
};
