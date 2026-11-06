import { lstatSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  canonicalPathForBoundary,
  isDirectChild,
  parseExplicitPaths,
  readPromptRootSpecs,
  trustedPromptRootsFor,
  type PiPromptRootSpec,
} from "./resource-discovery.ts";

const PI_PROMPT_PATHS_ENV = "MELODY_PI_PROMPT_PATHS_JSON";
export const MAX_PI_PROMPT_PATHS = 512;
export const MAX_PI_PROMPT_FILE_BYTES = 1024 * 1024;
export const MAX_PI_PROMPT_TOTAL_BYTES = 64 * 1024 * 1024;

const addPromptCandidate = (
  candidate: string,
  root: PiPromptRootSpec,
  allowed: string[],
  seen: Set<string>,
  totalBytes: { value: number },
): void => {
  if (allowed.length >= MAX_PI_PROMPT_PATHS || seen.has(candidate)) return;
  if (!isDirectChild(candidate, root.path)) return;
  const name = candidate.slice(candidate.lastIndexOf(sep) + 1);
  const stem = name.slice(0, -3);
  if (!name.toLowerCase().endsWith(".md") || root.disabled.has(stem)) return;
  try {
    const metadata = lstatSync(candidate);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_PI_PROMPT_FILE_BYTES ||
      totalBytes.value + metadata.size > MAX_PI_PROMPT_TOTAL_BYTES
    )
      return;
    seen.add(candidate);
    allowed.push(candidate);
    totalBytes.value += metadata.size;
  } catch {
    // A stale path is a compatibility diagnostic, not a session failure.
  }
};

const scanPromptRoot = (
  root: PiPromptRootSpec,
  allowed: string[],
  seen: Set<string>,
  totalBytes: { value: number },
): void => {
  let entries;
  try {
    entries = readdirSync(root.path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch {
    return;
  }
  for (const entry of entries) {
    if (allowed.length >= MAX_PI_PROMPT_PATHS) break;
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    addPromptCandidate(
      join(root.path, entry.name),
      root,
      allowed,
      seen,
      totalBytes,
    );
  }
};

/**
 * Parse Host-provided Markdown command paths. The concrete path list remains
 * accepted for direct workers; a Host-provided root manifest additionally
 * permits safe discovery of new/removed flat command templates on refresh.
 */
export const piPromptPathsFor = (
  cwd: string,
  rootSpecsOverride?: PiPromptRootSpec[],
): string[] => {
  const explicit = parseExplicitPaths(process.env[PI_PROMPT_PATHS_ENV]);
  const rootSpecs = rootSpecsOverride ?? readPromptRootSpecs(cwd);
  const trustedRoots = trustedPromptRootsFor(cwd, rootSpecs);
  const allowed: string[] = [];
  const seen = new Set<string>();
  const totalBytes = { value: 0 };
  const explicitByRoot = new Map<string, string[]>();
  for (const value of explicit.slice(0, MAX_PI_PROMPT_PATHS * 2)) {
    try {
      const candidate = resolve(value);
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
      const canonical = canonicalPathForBoundary(candidate);
      const matchingRoot = trustedRoots.find((root) =>
        isDirectChild(canonical, root),
      );
      if (!matchingRoot) continue;
      const values = explicitByRoot.get(matchingRoot) ?? [];
      values.push(canonical);
      explicitByRoot.set(matchingRoot, values);
    } catch {
      // Ignore stale entries.
    }
  }
  if (rootSpecs) {
    for (const root of rootSpecs) {
      for (const candidate of explicitByRoot.get(
        canonicalPathForBoundary(root.path),
      ) ?? []) {
        addPromptCandidate(candidate, root, allowed, seen, totalBytes);
      }
      scanPromptRoot(root, allowed, seen, totalBytes);
    }
  } else {
    // Direct worker compatibility: no root manifest means concrete paths only.
    for (const candidate of explicit) {
      try {
        const canonical = canonicalPathForBoundary(resolve(candidate));
        const matchingRoot = trustedRoots.find((root) =>
          isDirectChild(canonical, root),
        );
        if (matchingRoot) {
          addPromptCandidate(
            canonical,
            { path: matchingRoot, disabled: new Set(), ignorePaths: [] },
            allowed,
            seen,
            totalBytes,
          );
        }
      } catch {
        // Ignore stale entries.
      }
    }
  }
  return allowed.slice(0, MAX_PI_PROMPT_PATHS);
};
