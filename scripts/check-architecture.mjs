import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceExtensions = new Set([".ts", ".tsx", ".mjs"]);
const forbiddenDomainImports = [
  /^@\/(?:components|features|stores|lib)(?:\/|$)/,
  /^(?:react|react-dom)(?:\/|$)/,
  /^@tauri-apps\//,
];
const piSdkImport =
  /^@earendil-works\/pi-(?:coding-agent|agent-core|ai|server)(?:\/|$)/;

const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(path.slice(path.lastIndexOf(".")))
      ? [path]
      : [];
  });

const scriptKindFor = (path) => {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
};

export const moduleSpecifiers = (path, content) => {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path),
  );
  const specifiers = [];
  const addStringLiteral = (node) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      addStringLiteral(node.argument.literal);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) {
        addStringLiteral(reference.expression);
      }
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isImport || isRequire) && node.arguments.length > 0) {
        addStringLiteral(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
};

export const runtimeModuleSpecifiers = (path, content) => {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path),
  );
  const specifiers = [];
  const addStringLiteral = (node) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      if (!node.importClause?.isTypeOnly)
        addStringLiteral(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!node.isTypeOnly) addStringLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (!node.isTypeOnly && ts.isExternalModuleReference(reference)) {
        addStringLiteral(reference.expression);
      }
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isImport || isRequire) && node.arguments.length > 0) {
        addStringLiteral(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
};

const isTestOnlySource = (path) => {
  const normalized = path.replaceAll("\\", "/");
  return (
    /(?:^|\/)__(?:tests)__\//u.test(normalized) ||
    /(?:^|\/)(?:test|tests)\//u.test(normalized) ||
    /\.(?:test|spec)\.[^.]+$/u.test(normalized) ||
    normalized.endsWith(".d.ts")
  );
};

const canonicalPath = (path) => {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
};

const compilerOptionsFor = (filePath, cache) => {
  const configPath = ts.findConfigFile(dirname(filePath), ts.sys.fileExists);
  if (!configPath) return {};
  if (cache.has(configPath)) return cache.get(configPath);

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    cache.set(configPath, {});
    return {};
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  cache.set(configPath, parsed.options);
  return parsed.options;
};

export const findRuntimeModuleCycles = (graph) => {
  const entries = graph instanceof Map ? graph : new Map(Object.entries(graph));
  const nodes = new Set(entries.keys());
  for (const targets of entries.values()) {
    for (const target of targets) nodes.add(target);
  }

  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  const connect = (node) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of entries.get(node) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);

    if (component.length > 1 || (entries.get(node) ?? new Set()).has(node)) {
      cycles.push(component.sort());
    }
  };

  for (const node of [...nodes].sort()) {
    if (!indices.has(node)) connect(node);
  }
  return cycles.sort((left, right) => left[0].localeCompare(right[0]));
};

export const collectRuntimeModuleCycles = (projectRoot = process.cwd()) => {
  const sourceRoots = [join(projectRoot, "src"), join(projectRoot, "packages")];
  const sourcePaths = sourceRoots.flatMap((root) => sourceFiles(root));
  const modulePaths = sourcePaths
    .filter((path) => !isTestOnlySource(relative(projectRoot, path)))
    .map((path) => ({
      absolute: canonicalPath(path),
      relative: relative(projectRoot, path),
    }));
  const relativeByAbsolute = new Map(
    modulePaths.map(({ absolute, relative: relativePath }) => [
      absolute,
      relativePath,
    ]),
  );
  const compilerOptionsCache = new Map();
  const graph = new Map(
    modulePaths.map(({ relative: relativePath }) => [relativePath, new Set()]),
  );

  for (const { absolute, relative: relativePath } of modulePaths) {
    const content = readFileSync(absolute, "utf8");
    for (const specifier of runtimeModuleSpecifiers(relativePath, content)) {
      const resolved = ts.resolveModuleName(
        specifier,
        absolute,
        compilerOptionsFor(absolute, compilerOptionsCache),
        ts.sys,
      ).resolvedModule;
      if (!resolved) continue;
      const target = relativeByAbsolute.get(
        canonicalPath(resolved.resolvedFileName),
      );
      if (target) graph.get(relativePath).add(target);
    }
  }

  return findRuntimeModuleCycles(graph);
};

export const domainBoundaryViolations = (relativePath, content) =>
  moduleSpecifiers(relativePath, content)
    .filter((specifier) =>
      forbiddenDomainImports.some((pattern) => pattern.test(specifier)),
    )
    .map(
      (specifier) =>
        `${relativePath} imports forbidden dependency ${specifier}`,
    );

export const workerBoundaryViolations = (relativePath, content) => {
  if (relativePath.split(/[\\/]/u)[0] === "pi") return [];
  return moduleSpecifiers(relativePath, content)
    .filter((specifier) => piSdkImport.test(specifier))
    .map(
      (specifier) =>
        `${relativePath} imports ${specifier}; Pi SDK imports belong under packages/agent-worker/src/pi/`,
    );
};

export const collectArchitectureViolations = (projectRoot = process.cwd()) => {
  const domainRoot = join(projectRoot, "src", "domain");
  const workerRoot = join(projectRoot, "packages", "agent-worker", "src");
  const domainViolations = sourceFiles(domainRoot).flatMap((path) =>
    domainBoundaryViolations(
      relative(projectRoot, path),
      readFileSync(path, "utf8"),
    ),
  );
  const workerViolations = sourceFiles(workerRoot).flatMap((path) =>
    workerBoundaryViolations(
      relative(workerRoot, path),
      readFileSync(path, "utf8"),
    ),
  );
  const runtimeCycleViolations = collectRuntimeModuleCycles(projectRoot).map(
    (cycle) => `runtime module cycle detected among ${cycle.join(", ")}`,
  );
  return [...domainViolations, ...workerViolations, ...runtimeCycleViolations];
};

const run = () => {
  const violations = collectArchitectureViolations();
  if (violations.length > 0) {
    console.error("Architecture boundary violations detected:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log("Architecture boundaries and runtime module graph are intact.");
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run();
}
