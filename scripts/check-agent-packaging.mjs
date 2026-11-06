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
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const expectedPiVersion = piManifest?.pi?.version;
const workerEntryPath = resolve(root, "packages/agent-worker/src/main.ts");
const adapterPath = resolve(
  root,
  "packages/agent-worker/src/pi/session-adapter.ts",
);
const runtimeTypesPath = resolve(
  root,
  "packages/agent-worker/src/pi/session-runtime-types.ts",
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

if (existsSync(adapterPath)) {
  if (!existsSync(runtimeTypesPath)) {
    failures.push("Pi SDK 静态入口模块不存在。");
  } else {
    const runtimeTypes = readFileSync(runtimeTypesPath, "utf8");
    if (!runtimeTypes.includes('from "@earendil-works/pi-coding-agent"')) {
      failures.push(
        "Pi SDK 运行时类型模块必须保留静态 @earendil-works/pi-coding-agent 入口，以支持 Bun 自包含编译。",
      );
    }
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
