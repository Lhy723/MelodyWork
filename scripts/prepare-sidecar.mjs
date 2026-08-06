import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const developmentMode = process.argv.includes("--dev");
const hostTarget = execFileSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).trim();
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  process.env.TAURI_TARGET_TRIPLE ??
  hostTarget;
const windowsTarget = target.includes("windows");
const extension = windowsTarget ? ".exe" : "";
const destination = resolve(
  "src-tauri",
  "binaries",
  `melody-pager-${target}${extension}`,
);
const embeddedManifest = resolve("vendor", "melody-build", "Cargo.toml");
const embeddedTargetRoot = resolve(
  "vendor",
  "melody-build",
  "target",
  ...(target === hostTarget ? [] : [target]),
);

const melodySource = join(
  homedir(),
  ".melody",
  "bin",
  windowsTarget ? "melody.exe" : "melody",
);
const legacyGrokSource = join(
  homedir(),
  ".grok",
  "bin",
  windowsTarget ? "grok.exe" : "grok",
);
const embeddedReleaseSource = resolve(
  embeddedTargetRoot,
  "release",
  windowsTarget ? "melody-pager.exe" : "melody-pager",
);
const embeddedDebugSource = resolve(
  embeddedTargetRoot,
  "debug",
  windowsTarget ? "melody-pager.exe" : "melody-pager",
);
const siblingReleaseSource = resolve(
  "..",
  "melody-build",
  "target",
  "release",
  windowsTarget ? "melody-pager.exe" : "melody-pager",
);
const siblingDebugSource = resolve(
  "..",
  "melody-build",
  "target",
  "debug",
  windowsTarget ? "melody-pager.exe" : "melody-pager",
);
const explicitSource = process.env.MELODY_PAGER_SOURCE;

function filesEqual(leftPath, rightPath) {
  const leftStats = statSync(leftPath);
  const rightStats = statSync(rightPath);
  if (leftStats.size !== rightStats.size) {
    return false;
  }

  const leftFd = openSync(leftPath, "r");
  const rightFd = openSync(rightPath, "r");
  const leftBuffer = Buffer.allocUnsafe(1024 * 1024);
  const rightBuffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    while (true) {
      const leftBytes = readSync(
        leftFd,
        leftBuffer,
        0,
        leftBuffer.length,
        null,
      );
      const rightBytes = readSync(
        rightFd,
        rightBuffer,
        0,
        rightBuffer.length,
        null,
      );
      if (leftBytes !== rightBytes) {
        return false;
      }
      if (leftBytes === 0) {
        return true;
      }
      if (
        !leftBuffer
          .subarray(0, leftBytes)
          .equals(rightBuffer.subarray(0, rightBytes))
      ) {
        return false;
      }
    }
  } finally {
    closeSync(leftFd);
    closeSync(rightFd);
  }
}

if (developmentMode && !explicitSource && existsSync(embeddedManifest)) {
  const cargoArgs = [
    "build",
    "--manifest-path",
    embeddedManifest,
    "--package",
    "melody-pager-bin",
    "--bin",
    "melody-pager",
    ...(target === hostTarget ? [] : ["--target", target]),
  ];
  console.log("Preparing current Melody Build debug sidecar…");
  execFileSync("cargo", cargoArgs, { stdio: "inherit" });
}

const embeddedSources = developmentMode
  ? [embeddedDebugSource, embeddedReleaseSource]
  : [embeddedReleaseSource, embeddedDebugSource];
const siblingSources = developmentMode
  ? [siblingDebugSource, siblingReleaseSource]
  : [siblingReleaseSource, siblingDebugSource];
const source = explicitSource
  ? resolve(explicitSource)
  : embeddedSources.find(existsSync) ??
    siblingSources.find(existsSync) ??
    (existsSync(melodySource)
      ? melodySource
      : existsSync(legacyGrokSource)
        ? legacyGrokSource
        : undefined);

if (!source) {
  if (existsSync(destination)) {
    console.log(`Sidecar ready: ${basename(destination)}`);
    process.exit(0);
  }
  throw new Error(
    [
      `Missing melody-pager for ${target}.`,
      `Expected ${destination}.`,
      `Expected embedded Melody build at ${embeddedReleaseSource} or ${embeddedDebugSource}.`,
      `Expected sibling Melody build at ${siblingReleaseSource} or ${siblingDebugSource}.`,
      `Expected installed Melody binary at ${melodySource}.`,
      "Initialize vendor/melody-build, run this script with --dev, or set MELODY_PAGER_SOURCE.",
    ].join(" "),
  );
}

mkdirSync(resolve("src-tauri", "binaries"), { recursive: true });
const resolvedSource = realpathSync(source);
const destinationExists = existsSync(destination);
const unchanged = destinationExists && filesEqual(resolvedSource, destination);

if (!unchanged) {
  copyFileSync(resolvedSource, destination);
}
if (!windowsTarget && (statSync(destination).mode & 0o777) !== 0o755) {
  chmodSync(destination, 0o755);
}
console.log(
  unchanged
    ? `Sidecar unchanged: ${destination}`
    : `Prepared ${destination} from ${source}`,
);
