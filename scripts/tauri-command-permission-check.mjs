import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Compare renderer invoke calls with Tauri's registered handlers and the main
 * window permission allowlist. The caller owns the aggregate gate/reporting;
 * this module owns this one cross-file command contract.
 */
export const checkTauriCommandPermissions = (root) => {
  const failures = [];
  const rustMainPath = resolve(root, "src-tauri/src/lib.rs");
  const tauriPermissionPath = resolve(
    root,
    "src-tauri/permissions/default.toml",
  );

  try {
    const rustMain = readFileSync(rustMainPath, "utf8");
    const handlerMatch = rustMain.match(
      /tauri::generate_handler!\s*\[([\s\S]*?)\]/u,
    );
    const permissionSource = readFileSync(tauriPermissionPath, "utf8");
    const permissionMatch = permissionSource.match(
      /commands\.allow\s*=\s*\[([\s\S]*?)\]/u,
    );
    if (!handlerMatch) {
      failures.push("Tauri invoke_handler 注册清单无法读取。");
    } else if (!permissionMatch) {
      failures.push("Tauri 主窗口 command allowlist 无法读取。");
    } else {
      const registeredCommands = new Set(
        handlerMatch[1]
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .replace(/\/\/.*$/gmu, "")
          .split(",")
          .map((entry) => entry.trim().split("::").at(-1))
          .filter(Boolean),
      );
      const allowedCommands = new Set(
        [...permissionMatch[1].matchAll(/"([^"]+)"/gu)].map(
          (match) => match[1],
        ),
      );
      const frontendFiles = [];
      const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (/\.(?:ts|tsx)$/u.test(entry.name)) frontendFiles.push(path);
        }
      };
      visit(resolve(root, "src"));

      const invokedCommands = new Set();
      for (const path of frontendFiles) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(
          /\binvoke(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/gu,
        )) {
          invokedCommands.add(match[1]);
        }
      }

      for (const command of [...invokedCommands].sort()) {
        if (registeredCommands.has(command) && !allowedCommands.has(command)) {
          failures.push(
            `前端调用的 Tauri 命令 ${command} 未加入主窗口权限白名单。`,
          );
        }
      }
    }
  } catch (error) {
    failures.push(`Tauri command permissions: ${error.message}`);
  }

  return failures;
};
