import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  AgentPromptResourceRoot,
  AgentSkillResourceRoot,
} from "@melody/agent-contract";

const PI_SKILL_ROOTS_ENV = "MELODY_PI_SKILL_ROOTS_JSON";
const PI_PROMPT_ROOTS_ENV = "MELODY_PI_PROMPT_ROOTS_JSON";
type PiResourceRootEnvironment = Record<string, string | undefined>;
export const MAX_PI_SKILL_PATHS = 256;
/** Mirrors the Host's `MAX_PI_SKILL_IGNORE_PATHS` bound. */
export const MAX_PI_SKILL_IGNORE_PATHS = 64;
export const isWithinRoot = (path: string, root: string): boolean => {
  const relativePath = relative(root, path);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${sep}`) &&
    relativePath !== ".." &&
    !relativePath.startsWith(sep)
  );
};

export const isDirectChild = (path: string, root: string): boolean => {
  const relativePath = relative(root, path);
  return (
    isWithinRoot(path, root) &&
    !relativePath.includes(sep) &&
    dirname(path) === root
  );
};

const skillProjectRootNames = [
  ".melody",
  ".agents",
  ".claude",
  ".cursor",
] as const;

const externalSkillRootNames = [".agents", ".claude", ".cursor"] as const;

const pluginMarkerFiles = [
  "plugin.json",
  join(".melody-plugin", "plugin.json"),
  join(".claude-plugin", "plugin.json"),
] as const;
const pluginMarkerDirectories = [
  "skills",
  "commands",
  "agents",
  "hooks",
  ".mcp.json",
  ".lsp.json",
] as const;

const isPluginRoot = (path: string): boolean => {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
    return [...pluginMarkerFiles, ...pluginMarkerDirectories].some((name) => {
      try {
        return !lstatSync(join(path, name)).isSymbolicLink();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

const discoverPluginRoots = (containers: string[]): string[] => {
  const roots: string[] = [];
  const stack = containers.map((path) => ({ path: resolve(path), depth: 0 }));
  let visited = 0;
  while (stack.length > 0 && roots.length < 128 && visited < 4096) {
    const current = stack.pop();
    if (!current || current.depth > 5) continue;
    if (isPluginRoot(current.path)) {
      roots.push(current.path);
      continue;
    }
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
    } catch {
      continue;
    }
    for (const entry of entries.reverse()) {
      visited += 1;
      if (
        visited >= 4096 ||
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "target" ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        continue;
      }
      stack.push({
        path: join(current.path, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return [...new Set(roots)];
};

const projectPluginContainersFor = (cwd: string): string[] => {
  const containers: string[] = [];
  let current = resolve(cwd);
  let foundRepositoryMarker = false;
  while (true) {
    containers.push(resolve(current, ".melody", "plugins"));
    containers.push(resolve(current, ".claude", "plugins"));
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false })) {
      foundRepositoryMarker = true;
      break;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return foundRepositoryMarker ? containers : containers.slice(0, 2);
};

const pluginRootsFor = (
  cwd: string,
  additionalRoots: string[] = [],
  environment: PiResourceRootEnvironment = process.env,
): string[] => {
  const configuredRoot = environment.MELODY_HOME?.trim();
  const melodyRoot = resolve(configuredRoot || join(tmpdir(), "melody"));
  const homeRoot =
    environment.HOME?.trim() || environment.USERPROFILE?.trim() || undefined;
  const containers = [
    ...projectPluginContainersFor(cwd),
    resolve(melodyRoot, "installed-plugins"),
    resolve(melodyRoot, "plugins"),
    ...(homeRoot ? [resolve(homeRoot, ".claude", "plugins")] : []),
  ];
  return [
    ...new Set([
      ...discoverPluginRoots(containers),
      ...additionalRoots.filter(isPluginRoot).map((root) => resolve(root)),
    ]),
  ].slice(0, 128);
};

const pluginRootsFromResourceSpecs = (
  specs: Array<{ path: string }> | undefined,
): string[] =>
  (specs ?? [])
    .map((spec) => resolve(spec.path))
    .filter((path) => ["skills", "commands"].includes(basename(path)))
    .map((path) => dirname(path));

const skillRootsFor = (
  cwd: string,
  additionalPluginRoots: string[] = [],
  environment: PiResourceRootEnvironment = process.env,
): string[] => {
  const projectRoot = resolve(cwd);
  const projectRoots: string[] = [];
  let current = projectRoot;
  let foundRepositoryMarker = false;
  while (true) {
    for (const name of skillProjectRootNames) {
      projectRoots.push(resolve(current, name, "skills"));
    }
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false })) {
      foundRepositoryMarker = true;
      break;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  if (!foundRepositoryMarker) {
    projectRoots.splice(skillProjectRootNames.length);
  }

  const configuredRoot = environment.MELODY_HOME?.trim();
  const melodyRoot = resolve(
    configuredRoot || join(tmpdir(), "melody"),
    "skills",
  );
  const homeRoot =
    environment.HOME?.trim() || environment.USERPROFILE?.trim() || undefined;
  const roots = [
    ...projectRoots,
    melodyRoot,
    ...(homeRoot
      ? externalSkillRootNames.map((name) => resolve(homeRoot, name, "skills"))
      : []),
    ...pluginRootsFor(cwd, additionalPluginRoots, environment).map((root) =>
      resolve(root, "skills"),
    ),
  ];
  return [...new Set(roots)];
};

const promptRootsFor = (
  cwd: string,
  additionalPluginRoots: string[] = [],
  environment: PiResourceRootEnvironment = process.env,
): string[] => {
  const projectRoot = resolve(cwd);
  const projectRoots: string[] = [];
  let current = projectRoot;
  let foundRepositoryMarker = false;
  while (true) {
    for (const name of skillProjectRootNames) {
      projectRoots.push(resolve(current, name, "commands"));
    }
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false })) {
      foundRepositoryMarker = true;
      break;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  if (!foundRepositoryMarker) {
    projectRoots.splice(skillProjectRootNames.length);
  }

  const configuredRoot = environment.MELODY_HOME?.trim();
  const homeRoot =
    environment.HOME?.trim() || environment.USERPROFILE?.trim() || undefined;
  return [
    ...projectRoots,
    ...(configuredRoot
      ? [resolve(configuredRoot, "commands")]
      : [resolve(tmpdir(), "melody", "commands")]),
    ...(homeRoot
      ? externalSkillRootNames.map((name) =>
          resolve(homeRoot, name, "commands"),
        )
      : []),
    ...pluginRootsFor(cwd, additionalPluginRoots, environment).map((root) =>
      resolve(root, "commands"),
    ),
  ];
};

export interface PiSkillRootSpec {
  path: string;
  disabled: Set<string>;
  /**
   * Canonical path prefixes Melody's `[skills].ignore` hides, already resolved
   * by the Host. They apply to native roots only, matching the engine, which
   * filters `ignore` before plugin skills are merged.
   */
  ignorePaths: string[];
}

export interface PiPromptRootSpec {
  path: string;
  disabled: Set<string>;
  /** Prompt templates have no ignore list; kept for a uniform spec shape. */
  ignorePaths: string[];
}

const parseRootSpecs = <T extends { path: string; disabled: Set<string> }>(
  raw: string | undefined,
  parse: (value: Record<string, unknown>) => T | undefined,
): T[] | undefined => {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return undefined;
    return value.slice(0, MAX_PI_SKILL_PATHS).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const parsed = parse(entry as Record<string, unknown>);
      return parsed ? [parsed] : [];
    });
  } catch {
    return undefined;
  }
};

const parseDisabledNames = (value: unknown): Set<string> => {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .slice(0, MAX_PI_SKILL_PATHS)
      .filter(
        (name): name is string =>
          typeof name === "string" && name.length > 0 && name.length <= 255,
      ),
  );
};

/**
 * Ignore prefixes are Host-resolved absolute paths. A relative or traversing
 * entry is dropped rather than resolved against the worker's cwd, because a
 * prefix that escapes its intended root would hide unrelated Skills.
 */
const parseIgnorePaths = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const prefixes = new Set<string>();
  for (const entry of value.slice(0, MAX_PI_SKILL_IGNORE_PATHS)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 4096 || !isAbsolute(trimmed)) continue;
    const resolved = resolve(trimmed);
    if (resolved.split(sep).includes("..")) continue;
    prefixes.add(canonicalPathForBoundary(resolved));
  }
  return [...prefixes].sort();
};

/** True when a canonical path is one of the ignore prefixes or below it. */
export const isIgnoredPath = (candidate: string, prefixes: string[]): boolean =>
  prefixes.some(
    (prefix) => candidate === prefix || isWithinRoot(candidate, prefix),
  );

const canonicalRootPaths = (roots: string[]): string[] =>
  roots.flatMap((root) => {
    try {
      const metadata = lstatSync(root);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return [];
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });

const boundaryRootPaths = (roots: string[]): string[] =>
  roots.map((root) => canonicalPathForBoundary(root));

export const trustedSkillRootsFor = (
  cwd: string,
  specs: Array<{ path: string }> | undefined,
  environment: PiResourceRootEnvironment = process.env,
): string[] =>
  canonicalRootPaths(
    skillRootsFor(cwd, pluginRootsFromResourceSpecs(specs), environment),
  );

export const trustedPromptRootsFor = (
  cwd: string,
  specs: Array<{ path: string }> | undefined,
  environment: PiResourceRootEnvironment = process.env,
): string[] =>
  boundaryRootPaths(
    promptRootsFor(cwd, pluginRootsFromResourceSpecs(specs), environment),
  );

const rootSpecFor = <
  T extends { path: string; disabled: Set<string>; ignorePaths?: string[] },
>(
  spec: T,
  trustedRoots: Set<string>,
):
  | { path: string; disabled: Set<string>; ignorePaths: string[] }
  | undefined => {
  if (!spec.path || spec.path.length > 4096) return undefined;
  try {
    const resolved = resolve(spec.path);
    const canonical = canonicalPathForBoundary(resolved);
    // A Host-projected root is trusted when it is a known root or a directory
    // inside one. Plugin manifests name concrete skill directories
    // (`skills/<group>/<name>`), which the Host already validated against the
    // plugin package; requiring exact equality would reject them.
    const trusted =
      trustedRoots.has(canonical) ||
      [...trustedRoots].some((root) => isWithinRoot(canonical, root));
    if (!trusted) return undefined;
    // A root may not exist when the worker starts and be created later. If it
    // does exist, reject symlinks/non-directories now; scanSkillRoot repeats
    // this check on every refresh to close a replacement race.
    try {
      const metadata = lstatSync(resolved);
      if (metadata.isSymbolicLink() || !metadata.isDirectory())
        return undefined;
    } catch {
      // Missing roots are retained so a newly-created standard root can be
      // discovered by the next prompt refresh.
    }
    const ignorePaths = spec.ignorePaths ?? [];
    if (lstatSync(resolved, { throwIfNoEntry: false })) {
      try {
        return {
          path: realpathSync(resolved),
          disabled: spec.disabled,
          ignorePaths,
        };
      } catch {
        return undefined;
      }
    }
    return { path: resolved, disabled: spec.disabled, ignorePaths };
  } catch {
    return undefined;
  }
};

export const readSkillRootSpecs = (
  cwd: string,
): PiSkillRootSpec[] | undefined => {
  const parsed = parseRootSpecs(process.env[PI_SKILL_ROOTS_ENV], (entry) => {
    if (typeof entry.path !== "string") return undefined;
    return {
      path: entry.path,
      disabled: parseDisabledNames(entry.disabled),
      ignorePaths: parseIgnorePaths(entry.ignorePaths),
    };
  });
  if (!parsed) return undefined;
  const trustedRoots = new Set(
    boundaryRootPaths(skillRootsFor(cwd, pluginRootsFromResourceSpecs(parsed))),
  );
  return parsed.flatMap((spec) => {
    const trusted = rootSpecFor(spec, trustedRoots);
    return trusted ? [trusted] : [];
  });
};

export const readPromptRootSpecs = (
  cwd: string,
): PiPromptRootSpec[] | undefined => {
  const parsed = parseRootSpecs(process.env[PI_PROMPT_ROOTS_ENV], (entry) => {
    if (typeof entry.path !== "string") return undefined;
    return {
      path: entry.path,
      disabled: parseDisabledNames(entry.disabled),
    };
  });
  if (!parsed) return undefined;
  const trustedRoots = new Set(
    boundaryRootPaths(
      promptRootsFor(cwd, pluginRootsFromResourceSpecs(parsed)),
    ),
  );
  return parsed.flatMap((spec) => {
    const trusted = rootSpecFor(spec, trustedRoots);
    return trusted ? [trusted] : [];
  });
};

/**
 * Normalize a manifest sent by the Host before it is used to refresh a live
 * resource loader. The command is structurally validated at the protocol
 * boundary, but root membership and symlink checks must happen here as well
 * because this is the last process boundary before Pi sees the paths.
 */
export type PiResourceRootsResult =
  | {
      ok: true;
      skillRoots: PiSkillRootSpec[];
      promptRoots: PiPromptRootSpec[];
    }
  | { ok: false; kind: "skill" | "prompt" };

/**
 * Normalize Host-projected resource roots only after rechecking each root
 * against the workspace and plugin locations trusted by this worker.
 */
export const normalizePiResourceRoots = (
  cwd: string,
  skillEntries: AgentSkillResourceRoot[],
  promptEntries: AgentPromptResourceRoot[],
  environment: PiResourceRootEnvironment = process.env,
): PiResourceRootsResult => {
  const pluginRoots = [
    ...pluginRootsFromResourceSpecs(skillEntries),
    ...pluginRootsFromResourceSpecs(promptEntries),
  ];
  const trustedSkillRoots = new Set(
    boundaryRootPaths(skillRootsFor(cwd, pluginRoots, environment)),
  );
  const skillRoots = skillEntries.flatMap((entry) => {
    const normalized = rootSpecFor(
      {
        path: entry.path,
        disabled: new Set(entry.disabled),
        ignorePaths: parseIgnorePaths(entry.ignorePaths),
      },
      trustedSkillRoots,
    );
    return normalized ? [normalized] : [];
  });
  if (skillRoots.length !== skillEntries.length) {
    return { ok: false, kind: "skill" };
  }

  const trustedPromptRoots = new Set(
    boundaryRootPaths(promptRootsFor(cwd, pluginRoots, environment)),
  );
  const promptRoots = promptEntries.flatMap((entry) => {
    const normalized = rootSpecFor(
      {
        path: entry.path,
        disabled: new Set(entry.disabled),
      },
      trustedPromptRoots,
    );
    return normalized ? [normalized] : [];
  });
  if (promptRoots.length !== promptEntries.length) {
    return { ok: false, kind: "prompt" };
  }

  return { ok: true, skillRoots, promptRoots };
};

export const parseExplicitPaths = (raw: string | undefined): string[] => {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is string =>
            typeof entry === "string" &&
            entry.length > 0 &&
            entry.length <= 4096,
        )
      : [];
  } catch {
    return [];
  }
};

export const canonicalPathForBoundary = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
