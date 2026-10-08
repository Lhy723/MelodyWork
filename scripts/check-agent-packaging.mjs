import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const failures = [];

const readJson = (relativePath) => {
  const path = resolve(root, relativePath);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${relativePath}: 无法读取 JSON（${error.message}）`);
    return undefined;
  }
};

const workerPackage = readJson("packages/agent-worker/package.json");
const piManifest = readJson(
  "docs/architecture/pi-migration/pi-compatibility-manifest.json",
);
const rootPackage = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const expectedPiVersion = piManifest?.pi?.version;
const workerEntryPath = resolve(root, "packages/agent-worker/src/main.ts");
const workerSmokePath = resolve(
  root,
  "packages/agent-worker/src/worker-smoke.test.mjs",
);
const adapterPath = resolve(
  root,
  "packages/agent-worker/src/pi/session-adapter.ts",
);

if (!workerPackage) {
  failures.push("packages/agent-worker/package.json 不存在。");
} else {
  for (const packageName of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-server",
  ]) {
    if (workerPackage.dependencies?.[packageName] !== expectedPiVersion) {
      failures.push(
        `packages/agent-worker/package.json 必须精确锁定 ${packageName}@${expectedPiVersion ?? "manifest Pi version"}。`,
      );
    }
  }
  if (
    workerPackage.scripts?.start !==
    "node --experimental-strip-types src/main.ts"
  ) {
    failures.push(
      "Pi worker 的开发启动脚本必须使用受控的 Node TypeScript 入口。",
    );
  }
}

if (!existsSync(workerEntryPath)) {
  failures.push("packages/agent-worker/src/main.ts 不存在。");
}

if (!existsSync(workerSmokePath)) {
  failures.push("packages/agent-worker/src/worker-smoke.test.mjs 不存在。");
}

if (
  workerPackage &&
  !workerPackage.scripts?.test?.includes("src/worker-smoke.test.mjs")
) {
  failures.push("Pi worker 的 test 脚本必须包含独立健康握手 smoke test。");
}

if (
  rootPackage &&
  rootPackage.scripts?.["test:pi-worker-smoke"] !==
    "node --experimental-strip-types --test packages/agent-worker/src/worker-smoke.test.mjs"
) {
  failures.push("根项目必须提供 test:pi-worker-smoke 门禁脚本。");
}

if (existsSync(adapterPath)) {
  const adapter = readFileSync(adapterPath, "utf8");
  if (!adapter.includes('from "@earendil-works/pi-coding-agent"')) {
    failures.push(
      "PiSessionAdapter 必须保留静态 @earendil-works/pi-coding-agent 入口，以支持 Bun 自包含编译。",
    );
  }
} else {
  failures.push("PiSessionAdapter 入口不存在。");
}

const beforeBuild = tauriConfig?.build?.beforeBuildCommand ?? "";
if (!beforeBuild.includes("prepare-agent-worker.mjs --required")) {
  failures.push("Tauri beforeBuildCommand 未包含必需的 Pi worker 打包步骤。");
}
const externalBins = tauriConfig?.bundle?.externalBin ?? [];
if (!externalBins.includes("binaries/melody-agent-worker")) {
  failures.push("Tauri bundle.externalBin 未声明 melody-agent-worker。");
}

if (failures.length > 0) {
  console.error("Agent packaging checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Agent packaging configuration is ready.");
}
