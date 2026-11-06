import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  MAX_PI_SKILL_PATHS,
  canonicalPathForBoundary,
  isIgnoredPath,
  isWithinRoot,
  parseExplicitPaths,
  readSkillRootSpecs,
  trustedSkillRootsFor,
  type PiSkillRootSpec,
} from "./resource-discovery.ts";

const PI_SKILL_PATHS_ENV = "MELODY_PI_SKILL_PATHS_JSON";
export const MAX_PI_SKILL_DEPTH = 6;
export const MAX_PI_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_PI_SKILL_TOTAL_BYTES = 64 * 1024 * 1024;

const addSkillCandidate = (
  candidate: string,
  matchingRoot: string,
  disabled: Set<string>,
  ignorePaths: string[],
  allowed: string[],
  seen: Set<string>,
  totalBytes: { value: number },
): void => {
  if (allowed.length >= MAX_PI_SKILL_PATHS || seen.has(candidate)) return;
  if (isIgnoredPath(candidate, ignorePaths)) return;
  const relativePath = relative(matchingRoot, candidate);
  const depth = relativePath ? relativePath.split(sep).length : 0;
  if (depth > MAX_PI_SKILL_DEPTH) return;
  const name = candidate.slice(candidate.lastIndexOf(sep) + 1);
  if (name.startsWith(".") || disabled.has(name)) return;
  try {
    const skillFileMetadata = lstatSync(join(candidate, "SKILL.md"));
    if (
      skillFileMetadata.isSymbolicLink() ||
      !skillFileMetadata.isFile() ||
      skillFileMetadata.size > MAX_PI_SKILL_FILE_BYTES ||
      totalBytes.value + skillFileMetadata.size > MAX_PI_SKILL_TOTAL_BYTES
    )
      return;
    seen.add(candidate);
    allowed.push(candidate);
    totalBytes.value += skillFileMetadata.size;
  } catch {
    // A stale path is a compatibility diagnostic, not a session failure.
  }
};

const scanSkillRoot = (root: PiSkillRootSpec): string[] => {
  const candidates: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [
    { path: root.path, depth: 0 },
  ];
  while (stack.length > 0 && candidates.length < MAX_PI_SKILL_PATHS) {
    const current = stack.pop();
    if (!current || current.depth > MAX_PI_SKILL_DEPTH) continue;
    let metadata;
    try {
      metadata = lstatSync(current.path);
    } catch {
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    // An ignored subtree is skipped before it is walked, so a hidden Skill also
    // cannot resurface as a candidate below it.
    if (
      root.ignorePaths.length > 0 &&
      isIgnoredPath(canonicalPathForBoundary(current.path), root.ignorePaths)
    ) {
      continue;
    }
    if (current.depth > 0 || root.path === current.path) {
      try {
        const skillFile = lstatSync(join(current.path, "SKILL.md"));
        if (
          !skillFile.isSymbolicLink() &&
          skillFile.isFile() &&
          skillFile.size <= MAX_PI_SKILL_FILE_BYTES
        ) {
          const canonical = realpathSync(current.path);
          // A declared plugin Skill directory is the Skill itself, while a
          // container root still only contributes its descendants.
          if (
            isWithinRoot(canonical, root.path) ||
            canonical === canonicalPathForBoundary(root.path)
          ) {
            candidates.push(canonical);
          }
          // A directory with SKILL.md is a leaf, matching Pi discovery.
          continue;
        }
      } catch {
        // Continue walking when the marker is absent or stale.
      }
    }
    if (current.depth >= MAX_PI_SKILL_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
    } catch {
      continue;
    }
    for (const entry of entries.reverse()) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        continue;
      stack.push({
        path: join(current.path, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return candidates;
};

/**
 * Parse the Host's allow-listed Skill directories. The concrete path list is
 * retained for backwards-compatible direct workers; a Host-provided root
 * manifest additionally permits safe discovery of new/removed Skills on the
 * next prompt without enabling Pi's ambient scanner.
 */
export const piSkillPathsFor = (
  cwd: string,
  rootSpecsOverride?: PiSkillRootSpec[],
): string[] => {
  const explicit = parseExplicitPaths(process.env[PI_SKILL_PATHS_ENV]);
  const rootSpecs = rootSpecsOverride ?? readSkillRootSpecs(cwd);
  const trustedRoots = trustedSkillRootsFor(cwd, rootSpecs);
  const allowed: string[] = [];
  const seen = new Set<string>();
  const totalBytes = { value: 0 };
  const explicitByRoot = new Map<string, string[]>();
  for (const value of explicit.slice(0, MAX_PI_SKILL_PATHS * 2)) {
    try {
      const metadata = lstatSync(resolve(value));
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      const canonical = realpathSync(resolve(value));
      const matchingRoot = trustedRoots.find((root) =>
        isWithinRoot(canonical, root),
      );
      if (matchingRoot) {
        const values = explicitByRoot.get(matchingRoot) ?? [];
        values.push(canonical);
        explicitByRoot.set(matchingRoot, values);
      }
    } catch {
      // A stale path is a compatibility diagnostic, not a session failure.
    }
  }
  if (rootSpecs) {
    for (const root of rootSpecs) {
      for (const candidate of explicitByRoot.get(root.path) ??
        // A spec may be a declared Skill directory below a trusted root, so the
        // concrete path is keyed by the root that actually contains it.
        [...explicitByRoot.entries()]
          .filter(([trusted]) => isWithinRoot(root.path, trusted))
          .flatMap(([, values]) =>
            values.filter((value) => isWithinRoot(value, root.path)),
          )) {
        addSkillCandidate(
          candidate,
          root.path,
          root.disabled,
          root.ignorePaths,
          allowed,
          seen,
          totalBytes,
        );
      }
      for (const candidate of scanSkillRoot(root)) {
        addSkillCandidate(
          candidate,
          root.path,
          root.disabled,
          root.ignorePaths,
          allowed,
          seen,
          totalBytes,
        );
      }
    }
  } else {
    // Direct worker compatibility: no root manifest means only the concrete
    // Host paths are accepted, preserving the previous non-widening contract.
    for (const candidate of explicit) {
      try {
        const canonical = realpathSync(resolve(candidate));
        const matchingRoot = trustedRoots.find((root) =>
          isWithinRoot(canonical, root),
        );
        if (matchingRoot) {
          addSkillCandidate(
            canonical,
            matchingRoot,
            new Set(),
            [],
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
  return allowed.slice(0, MAX_PI_SKILL_PATHS);
};
