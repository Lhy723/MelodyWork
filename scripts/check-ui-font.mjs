import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const projectRoot = process.cwd();
const sourceRoot = join(projectRoot, "src");
const baseStylesheet = join(sourceRoot, "styles", "base.css");
const sourceExtensions = new Set([".css", ".scss", ".ts", ".tsx"]);
const allowMarker = /ui-font-check:\s*allow/iu;
const allowedFontVariables = [
  "var(--font-sans)",
  "var(--font-mono)",
  "var(--app-code-font",
];
const allowedFontShorthandValues =
  /^(inherit|initial|unset|revert|revert-layer|var\()/iu;

const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(extname(path)) ? [path] : [];
  });

const isCommentOnlyLine = (line) => /^\s*(?:\/\/|\/\*|\*|\*\/)/u.test(line);

const hasAllowMarker = (lines, index) =>
  lines
    .slice(Math.max(0, index - 3), index + 1)
    .some((line) => allowMarker.test(line));

const containsAllowedFontVariable = (value) =>
  allowedFontVariables.some((variable) => value.includes(variable));

const violations = [];

for (const path of sourceFiles(sourceRoot)) {
  const content = readFileSync(path, "utf8");
  const lines = content.split(/\r?\n/u);
  const isStylesheet = [".css", ".scss"].includes(extname(path));
  const isBaseStylesheet = path === baseStylesheet;

  const locationFor = (offset) => {
    const line = content.slice(0, offset).split(/\r?\n/u).length;
    return `${relative(projectRoot, path)}:${line}`;
  };

  if (isStylesheet) {
    const searchableContent = content.replace(/\/\*[\s\S]*?\*\//gu, (comment) =>
      comment.replace(/[^\r\n]/gu, " "),
    );
    for (const match of searchableContent.matchAll(
      /(?:^|[;{])\s*font-family\s*:\s*([^;{}]+)/gimu,
    )) {
      const value = match[1].trim();
      const line =
        content.slice(0, match.index ?? 0).split(/\r?\n/u).length - 1;
      if (
        !hasAllowMarker(lines, line) &&
        !containsAllowedFontVariable(value) &&
        !/^(?:inherit|initial|unset|revert|revert-layer)$/iu.test(value)
      ) {
        violations.push(
          `${locationFor(match.index ?? 0)} hard-codes a font family; use --font-sans or an explicit ui-font-check: allow marker`,
        );
      }
    }

    for (const match of searchableContent.matchAll(
      /(?:^|[;{])\s*font\s*:\s*([^;{}]+)/gimu,
    )) {
      const value = match[1].trim();
      const line =
        content.slice(0, match.index ?? 0).split(/\r?\n/u).length - 1;
      if (
        !hasAllowMarker(lines, line) &&
        !allowedFontShorthandValues.test(value)
      ) {
        violations.push(
          `${locationFor(match.index ?? 0)} uses a font shorthand that can reset the UI font; use font: inherit or an explicit ui-font-check: allow marker`,
        );
      }
    }

    for (const match of searchableContent.matchAll(
      /(?:^|[;{])\s*(--font-(?:sans|heading|mono))\s*:\s*([^;{}]+)/gimu,
    )) {
      const value = match[2].trim();
      const line =
        content.slice(0, match.index ?? 0).split(/\r?\n/u).length - 1;
      if (
        !isBaseStylesheet &&
        !hasAllowMarker(lines, line) &&
        !value.includes("var(")
      ) {
        violations.push(
          `${locationFor(match.index ?? 0)} overrides ${match[1]} outside base.css; keep UI font variables centralized or add an explicit ui-font-check: allow marker`,
        );
      }
    }
  } else {
    for (const match of content.matchAll(
      /\bfontFamily\s*:\s*(["'`])([^"'`]*?)\1/gu,
    )) {
      const value = match[2];
      const line =
        content.slice(0, match.index ?? 0).split(/\r?\n/u).length - 1;
      if (
        !hasAllowMarker(lines, line) &&
        !containsAllowedFontVariable(value) &&
        !isCommentOnlyLine(lines[line] ?? "")
      ) {
        violations.push(
          `${locationFor(match.index ?? 0)} hard-codes a font family; use the resolved UI/code font or an explicit ui-font-check: allow marker`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("UI font override checks failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("UI font override checks passed.");
}
