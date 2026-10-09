import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = process.argv.includes("--required");
const development = process.argv.includes("--dev");

const hostTarget = (() => {
  try {
    return execFileSync("rustc", ["--print", "host-tuple"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    if (process.platform === "darwin") return `${arch}-apple-darwin`;
    if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
    return `${arch}-unknown-linux-gnu`;
  }
})();

const target =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  process.env.TAURI_TARGET_TRIPLE ??
  hostTarget;

const targetSuffix = target.includes("windows") ? ".exe" : "";
const destination = resolve(
  projectRoot,
  "src-tauri",
  "binaries",
  `melody-agent-worker-${target}${targetSuffix}`,
);
const entrypoint = resolve(
  projectRoot,
  "packages",
  "agent-worker",
  "src",
  "main.ts",
);
const explicitSource = process.env.MELODY_PI_WORKER_SOURCE?.trim();

const bunTargetFor = (rustTarget) => {
  if (rustTarget === "aarch64-apple-darwin") return "bun-darwin-arm64";
  if (rustTarget === "x86_64-apple-darwin") return "bun-darwin-x64";
  if (rustTarget === "aarch64-pc-windows-msvc") return "bun-windows-arm64";
  if (rustTarget === "x86_64-pc-windows-msvc") return "bun-windows-x64";
  if (rustTarget === "aarch64-unknown-linux-gnu") return "bun-linux-arm64";
  if (rustTarget === "x86_64-unknown-linux-gnu") return "bun-linux-x64";
  if (rustTarget === "aarch64-unknown-linux-musl")
    return "bun-linux-arm64-musl";
  if (rustTarget === "x86_64-unknown-linux-musl") return "bun-linux-x64-musl";
  throw new Error(
    `Pi worker 暂不支持 Bun 目标 ${rustTarget}；请设置 MELODY_PI_WORKER_SOURCE 提供已编译 sidecar。`,
  );
};

const findBun = () => {
  const candidates = [
    process.env.MELODY_BUN_PATH,
    process.env.BUN_BINARY,
    process.platform === "win32" ? "bun.exe" : "bun",
    process.platform === "win32" ? undefined : "/Users/lhy/.bun/bin/bun",
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], {
        cwd: projectRoot,
        stdio: "ignore",
      });
      return candidate;
    } catch {
      // Try the next configured/runtime location.
    }
  }
  return undefined;
};

const reportMissing = (message) => {
  if (required) throw new Error(message);
  console.warn(`Pi worker skipped: ${message}`);
};

mkdirSync(dirname(destination), { recursive: true });

if (explicitSource) {
  const source = resolve(projectRoot, explicitSource);
  if (!existsSync(source) || !statSync(source).isFile()) {
    reportMissing(`MELODY_PI_WORKER_SOURCE 不存在：${source}`);
  } else {
    copyFileSync(realpathSync(source), destination);
    if (!target.includes("windows")) chmodSync(destination, 0o755);
    console.log(`Prepared ${basename(destination)} from ${source}`);
  }
  process.exit(0);
}

if (!existsSync(entrypoint)) {
  reportMissing(`Pi worker 入口不存在：${entrypoint}`);
  process.exit(0);
}

const bun = findBun();
if (!bun) {
  reportMissing(
    "找不到 Bun。正式构建请安装 Bun 1.3+，或设置 MELODY_BUN_PATH / MELODY_PI_WORKER_SOURCE。",
  );
  process.exit(0);
}

const bunTarget = bunTargetFor(target);
const args = [
  "build",
  entrypoint,
  "--compile",
  `--target=${bunTarget}`,
  "--outfile",
  destination,
];
if (development) args.push("--sourcemap=none");

console.log(`Preparing Pi worker ${target} (${bunTarget})…`);
const result = spawnSync(bun, args, {
  cwd: projectRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) {
  throw new Error(`Bun 编译 Pi worker 失败：${result.error.message}`);
}
if (result.status !== 0) {
  throw new Error(`Bun 编译 Pi worker 失败（退出码 ${result.status}）。`);
}
if (!existsSync(destination)) {
  throw new Error(`Bun 编译完成但没有生成 ${destination}。`);
}
if (!target.includes("windows")) chmodSync(destination, 0o755);
console.log(`Prepared ${destination}`);
