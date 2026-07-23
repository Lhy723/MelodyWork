import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const target =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  process.env.TAURI_TARGET_TRIPLE ??
  execFileSync("rustc", ["--print", "host-tuple"], {
    encoding: "utf8",
  }).trim();
const windowsTarget = target.includes("windows");
const extension = windowsTarget ? ".exe" : "";
const destination = resolve(
  "src-tauri",
  "binaries",
  `melody-pager-${target}${extension}`,
);

if (existsSync(destination)) {
  console.log(`Sidecar ready: ${basename(destination)}`);
  process.exit(0);
}

const defaultSource = join(
  homedir(),
  ".grok",
  "bin",
  windowsTarget ? "grok.exe" : "grok",
);
const source = process.env.MELODY_PAGER_SOURCE ?? defaultSource;
if (!existsSync(source)) {
  throw new Error(
    [
      `Missing melody-pager for ${target}.`,
      `Expected ${destination}.`,
      "Build melody-pager-bin from Lhy723/melody-build or set MELODY_PAGER_SOURCE.",
    ].join(" "),
  );
}

mkdirSync(resolve("src-tauri", "binaries"), { recursive: true });
copyFileSync(realpathSync(source), destination);
if (!windowsTarget) {
  chmodSync(destination, 0o755);
}
console.log(`Prepared ${destination} from ${source}`);
