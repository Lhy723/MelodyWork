import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { cleanTauriBuildTargets } from "./clean-tauri-build.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

const tauriCommand = resolve(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);

const isDevCommand = args[0] === "dev";
// Keep Cargo's incremental cache during normal development. Cleaning is an
// explicit maintenance action (`pnpm tauri:clean`) or an opt-in override.
const cleanTauriTarget =
  process.env.MELODY_CLEAN_TAURI_TARGET === "1" &&
  process.env.MELODY_KEEP_TAURI_TARGET !== "1";
let exitStatus = 1;

try {
  if (isDevCommand) {
    const prepareStatus = run(process.execPath, [
      "scripts/prepare-sidecar.mjs",
      "--dev",
    ]);

    if (prepareStatus !== 0) {
      exitStatus = prepareStatus;
    } else {
      exitStatus = run(tauriCommand, args);
    }
  } else {
    exitStatus = run(tauriCommand, args);
  }
} finally {
  if (isDevCommand && cleanTauriTarget) {
    console.log("Development session ended; cleaning Tauri build targets…");
    const cleanupStatus = cleanTauriBuildTargets();
    if (exitStatus === 0 && cleanupStatus !== 0) {
      exitStatus = cleanupStatus;
    }
  }
}

process.exit(exitStatus);
