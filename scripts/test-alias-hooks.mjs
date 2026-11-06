import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Resolve the renderer's `@/` alias and extensionless relative imports under
 * `node --test`.
 *
 * Vite and `tsc` each own their own alias resolution; this hook exists only so
 * store and lib tests can import the same specifiers the application uses.
 * Extensionless specifiers are tried as `.ts`, `.tsx`, then `index.ts`, which
 * mirrors the bundler's order for this repository.
 */
const projectRoot = resolvePath(import.meta.dirname, "..");

const withExtension = (target) => {
  if (/\.[cm]?[jt]sx?$/u.test(target)) return target;
  for (const candidate of [
    `${target}.ts`,
    `${target}.tsx`,
    `${target}/index.ts`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return target;
};

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const target = resolvePath(projectRoot, "src", specifier.slice(2));
    return next(pathToFileURL(withExtension(target)).href, context);
  }
  // The barrel modules use extensionless relative imports, which the bundler
  // accepts and plain ESM does not.
  if (
    specifier.startsWith(".") &&
    context.parentURL?.startsWith("file:") &&
    !/\.[cm]?[jt]sx?$/u.test(specifier)
  ) {
    const base = dirname(fileURLToPath(context.parentURL));
    const target = withExtension(resolvePath(base, specifier));
    if (existsSync(target)) {
      return next(pathToFileURL(target).href, context);
    }
  }
  return next(specifier, context);
}
