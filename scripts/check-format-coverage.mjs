import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import prettier from "prettier";

const projectRoot = process.cwd();
const packageJsonPath = join(projectRoot, "package.json");
const baselinePath = join(
  projectRoot,
  "scripts",
  "format-coverage-baseline.txt",
);
const writeBaseline = process.argv.includes("--write-baseline");

const sourceExtensions = new Set([".ts", ".tsx", ".mjs"]);
const sourceRoots = ["src", "packages", "scripts"];
const rootConfigFiles = [
  "package.json",
  "index.html",
  "vite.config.ts",
  "eslint.config.js",
  ".github/workflows/check.yml",
];
const excludedDirectories = new Set([
  "node_modules",
  "dist",
  "vendor",
  "plugins",
  "src-tauri",
]);
const excludedSuffixes = [".d.ts"];
const formatCheckPrefix = "prettier --check";

const toPosix = (path) => path.split("\\").join("/");

const ignorePaths = [".prettierignore", ".gitignore"]
  .map((name) => join(projectRoot, name))
  .filter((path) => existsSync(path));

// Prettier is the single source of truth for the files it formats: it honours
// `.prettierignore` and `.gitignore`, and skips files it has no parser for.
// Asking Prettier avoids a second, hand-rolled implementation of ignore rules.
const prettierFormats = async (path) => {
  const info = await prettier.getFileInfo(join(projectRoot, path), {
    ignorePath: ignorePaths,
  });
  return !info.ignored && info.inferredParser !== null;
};

const prettierConfigCache = new Map();
const prettierConfigFor = async (path) => {
  if (!prettierConfigCache.has(path)) {
    prettierConfigCache.set(
      path,
      await prettier.resolveConfig(join(projectRoot, path)),
    );
  }
  return prettierConfigCache.get(path);
};

const isFormatted = async (path) => {
  const config = await prettierConfigFor(path);
  return prettier.check(readFileSync(join(projectRoot, path), "utf8"), {
    ...config,
    filepath: join(projectRoot, path),
  });
};

const collectSourceFiles = (directory, collected) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) continue;
      collectSourceFiles(join(directory, entry.name), collected);
      continue;
    }
    if (!sourceExtensions.has(`.${entry.name.split(".").pop()}`)) continue;
    collected.add(toPosix(relative(projectRoot, join(directory, entry.name))));
  }
};

const discovered = new Set();
for (const root of sourceRoots) {
  const directory = join(projectRoot, root);
  if (existsSync(directory)) collectSourceFiles(directory, discovered);
}
for (const path of rootConfigFiles) {
  if (existsSync(join(projectRoot, path))) discovered.add(path);
}

const formatCheckArguments = () => {
  const script = JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts[
    "format:check"
  ];
  if (!script || !script.startsWith(formatCheckPrefix)) {
    throw new Error(
      `package.json script "format:check" must start with "${formatCheckPrefix}".`,
    );
  }
  return script
    .slice(formatCheckPrefix.length)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Only a trailing `*` inside a single path segment is expanded, e.g.
// `src/domain/*.test.mjs`. Full glob semantics are deliberately not supported.
const expandArgument = (argument) => {
  const separator = argument.lastIndexOf("/");
  const segment = argument.slice(separator + 1);
  if (!segment.includes("*")) return [argument];
  const directory = separator === -1 ? "" : argument.slice(0, separator);
  const pattern = new RegExp(
    `^${escapeRegExp(segment).replaceAll("\\*", "[^/]*")}$`,
    "u",
  );
  const absoluteDirectory = join(projectRoot, directory);
  if (!existsSync(absoluteDirectory)) return [];
  return readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => (directory ? `${directory}/${entry.name}` : entry.name));
};

// A directory argument such as `.` covers every file beneath it, which is how
// `prettier --check .` reaches the whole repository.
const argumentCoversPath = (argument, path) => {
  if (argument.includes("*")) return expandArgument(argument).includes(path);
  const absoluteArgument = join(projectRoot, argument);
  if (!existsSync(absoluteArgument)) return false;
  if (!statSync(absoluteArgument).isDirectory()) {
    return toPosix(relative(projectRoot, absoluteArgument)) === path;
  }
  const relativePath = relative(absoluteArgument, join(projectRoot, path));
  return !relativePath.startsWith("..") && !isAbsolute(relativePath);
};

const argumentsList = formatCheckArguments();
const isCovered = (path) =>
  argumentsList.some((argument) => argumentCoversPath(argument, path));

// A file only counts when Prettier would actually format it; ignored files and
// files without a parser are outside `format:check` by design, not gaps.
const candidates = [];
for (const path of [...discovered].sort()) {
  if (excludedSuffixes.some((suffix) => path.endsWith(suffix))) continue;
  if (!(await prettierFormats(path))) continue;
  candidates.push(path);
}

// A candidate is uncovered when `format:check` does not reach it, or when it
// reaches it but the file is not formatted yet. Either way `format:check` is
// red, so the ratchet must name the file instead of passing silently.
const uncovered = [];
for (const path of candidates) {
  if (!isCovered(path) || !(await isFormatted(path))) uncovered.push(path);
}

const readBaseline = () => {
  if (!existsSync(baselinePath)) return [];
  return readFileSync(baselinePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
};

if (writeBaseline) {
  const header = [
    "# Files that `prettier --check` does not cover or does not accept yet.",
    "# Generated by `node scripts/check-format-coverage.mjs --write-baseline`.",
    "# Remove entries as files are formatted; this file must never grow.",
    "# An empty list means every source file is covered and formatted.",
  ].join("\n");
  writeFileSync(
    baselinePath,
    uncovered.length > 0
      ? `${header}\n${uncovered.join("\n")}\n`
      : `${header}\n`,
  );
  console.log(
    `Wrote ${uncovered.length} baseline entries to ${toPosix(
      relative(projectRoot, baselinePath),
    )}.`,
  );
  process.exit(0);
}

const baseline = new Set(readBaseline());
const newFiles = uncovered.filter((path) => !baseline.has(path));
const staleEntries = [...baseline].filter(
  (path) => !uncovered.includes(path) && existsSync(join(projectRoot, path)),
);

console.log(
  `uncovered=${uncovered.length} (baseline=${baseline.size}, new=${newFiles.length})`,
);

if (staleEntries.length > 0) {
  console.log(
    `Baseline entries that are now covered or gone: ${staleEntries.length}`,
  );
}

if (newFiles.length > 0) {
  console.error(
    "Source files that `format:check` does not cover or does not accept:",
  );
  for (const path of newFiles) console.error(`- ${path}`);
  console.error("Run `pnpm format` to format them, or record them in");
  console.error(
    `${toPosix(relative(projectRoot, baselinePath))} with --write-baseline.`,
  );
  process.exit(1);
}

console.log(
  "No source file is missing from `format:check` beyond the recorded baseline.",
);
