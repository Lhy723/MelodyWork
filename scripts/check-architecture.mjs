import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const domainRoot = join(process.cwd(), "src", "domain");
const sourceExtensions = new Set([".ts", ".tsx", ".mjs"]);
const forbiddenImports = [
  /from\s+["']@\/(?:components|features|stores|lib)\//,
  /from\s+["'](?:react|react-dom|@tauri-apps\/)/,
];

const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(path.slice(path.lastIndexOf(".")))
      ? [path]
      : [];
  });

const violations = sourceFiles(domainRoot).flatMap((path) => {
  const content = readFileSync(path, "utf8");
  return forbiddenImports
    .filter((pattern) => pattern.test(content))
    .map((pattern) => `${relative(process.cwd(), path)} matches ${pattern}`);
});

if (violations.length > 0) {
  console.error("Architecture boundary violations detected:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Architecture boundaries are intact.");
}
