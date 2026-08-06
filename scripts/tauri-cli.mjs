import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

if (args[0] === "dev") {
  const prepareStatus = run(process.execPath, [
    "scripts/prepare-sidecar.mjs",
    "--dev",
  ]);
  if (prepareStatus !== 0) {
    process.exit(prepareStatus);
  }
}

const tauriCommand = resolve(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);

process.exit(run(tauriCommand, args));
