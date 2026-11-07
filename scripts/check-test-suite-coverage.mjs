import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = process.cwd();
const rootPackagePath = join(projectRoot, "package.json");
const workerPackagePath = join(
  projectRoot,
  "packages",
  "agent-worker",
  "package.json",
);
const workerRoot = join(projectRoot, "packages", "agent-worker");

const testSuffix = ".test.mjs";
const sourceRoots = ["src", "packages"];
const excludedDirectories = new Set([
  "node_modules",
  "dist",
  ".trellis",
  "src-tauri",
]);

const toPosix = (path) => path.split("\\").join("/");

const readPackageScript = (packagePath, scriptName) => {
  const script = JSON.parse(readFileSync(packagePath, "utf8")).scripts?.[
    scriptName
  ];
  if (typeof script !== "string" || script.length === 0) {
    throw new Error(
      `${toPosix(relative(projectRoot, packagePath))} has no "${scriptName}" script.`,
    );
  }
  return script;
};

// The suite definitions are read from the packages that own them, so a new
// test file only has to be added to one real command line. Node receives its
// file arguments after the `--test` flag; anything else there is a flag.
const testArguments = (command, source) => {
  const tokens = command.split(/\s+/u).filter(Boolean);
  const index = tokens.indexOf("--test");
  if (index === -1) {
    throw new Error(
      `The ${source} test script must pass files after "--test".`,
    );
  }
  return tokens.slice(index + 1).filter((token) => !token.startsWith("-"));
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Only a trailing `*` inside a single path segment is expanded, e.g.
// `src/domain/*.test.mjs`. Full glob semantics are deliberately not supported.
const expandArgument = (argument, baseDirectory) => {
  const separator = argument.lastIndexOf("/");
  const segment = argument.slice(separator + 1);
  if (!segment.includes("*")) return [resolve(baseDirectory, argument)];
  const directory = separator === -1 ? "" : argument.slice(0, separator);
  const pattern = new RegExp(
    `^${escapeRegExp(segment).replaceAll("\\*", "[^/]*")}$`,
    "u",
  );
  const absoluteDirectory = resolve(baseDirectory, directory);
  if (!existsSync(absoluteDirectory)) return [];
  return readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(absoluteDirectory, entry.name));
};

// Paths are compared relative to the project root, so the worker package's
// own-relative arguments line up with the files discovered on disk.
const suitePaths = (suite) => {
  const absolutePaths = testArguments(suite.command, suite.source).flatMap(
    (argument) => expandArgument(argument, suite.baseDirectory),
  );
  if (absolutePaths.length === 0) {
    throw new Error(`The ${suite.name} test script resolves to no files.`);
  }
  return absolutePaths.map((path) => toPosix(relative(projectRoot, path)));
};

const coversPath = (entry, path) =>
  entry === "" || entry === path || path.startsWith(`${entry}/`);

const suites = [
  {
    name: "unit",
    source: "package.json",
    baseDirectory: projectRoot,
    command: readPackageScript(rootPackagePath, "test:unit"),
  },
  {
    name: "worker",
    source: "packages/agent-worker/package.json",
    baseDirectory: workerRoot,
    command: readPackageScript(workerPackagePath, "test"),
  },
  {
    name: "smoke",
    source: "package.json",
    baseDirectory: projectRoot,
    command: readPackageScript(rootPackagePath, "test:smoke"),
  },
].map((suite) => ({ ...suite, paths: suitePaths(suite) }));

const collectTestFiles = (directory, collected) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) continue;
      collectTestFiles(join(directory, entry.name), collected);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(testSuffix)) continue;
    collected.add(toPosix(relative(projectRoot, join(directory, entry.name))));
  }
};

const discovered = new Set();
for (const root of sourceRoots) {
  const directory = join(projectRoot, root);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
  collectTestFiles(directory, discovered);
}
const files = [...discovered].sort();

const counts = new Map(suites.map((suite) => [suite.name, 0]));
const orphans = [];
const duplicates = [];
for (const path of files) {
  const owning = suites.filter((suite) =>
    suite.paths.some((entry) => coversPath(entry, path)),
  );
  for (const suite of owning)
    counts.set(suite.name, counts.get(suite.name) + 1);
  if (owning.length === 0) orphans.push(path);
  if (owning.length > 1) {
    duplicates.push(
      `${path} (${owning.map((suite) => suite.name).join(", ")})`,
    );
  }
}

const covered = files.length - orphans.length;
const summary = suites
  .map((suite) => `${suite.name}=${counts.get(suite.name)}`)
  .join(", ");
console.log(
  `covered=${covered} (${summary}, orphan=${orphans.length}, duplicate=${duplicates.length})`,
);

if (orphans.length > 0 || duplicates.length > 0) {
  if (orphans.length > 0) {
    console.error("Test files that no suite runs:");
    for (const path of orphans) console.error(`- ${path}`);
  }
  if (duplicates.length > 0) {
    console.error("Test files that more than one suite runs:");
    for (const path of duplicates) console.error(`- ${path}`);
  }
  console.error(
    "Keep every test file in exactly one script: package.json (test:unit, test:smoke) or packages/agent-worker/package.json (test).",
  );
  process.exit(1);
}

console.log("Every test file belongs to exactly one suite.");
