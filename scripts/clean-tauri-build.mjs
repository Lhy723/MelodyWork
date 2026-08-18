import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = [
  resolve(projectRoot, "src-tauri", "Cargo.toml"),
  resolve(projectRoot, "vendor", "melody-build", "Cargo.toml"),
];

export function cleanTauriBuildTargets() {
  let exitStatus = 0;

  for (const manifest of manifests) {
    if (!existsSync(manifest)) {
      continue;
    }

    console.log(`Cleaning Rust build target for ${manifest}`);
    const result = spawnSync("cargo", ["clean", "--manifest-path", manifest], {
      cwd: projectRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    if (result.error) {
      console.error(`Failed to clean ${manifest}: ${result.error.message}`);
      exitStatus = 1;
      continue;
    }

    if ((result.status ?? 1) !== 0) {
      exitStatus = result.status ?? 1;
    }
  }

  return exitStatus;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(cleanTauriBuildTargets());
}
