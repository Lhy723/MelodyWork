import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

const packageRoot = resolve(import.meta.dirname, "..");

const envelope = (requestId, command) =>
  `${JSON.stringify({ protocolVersion: 1, requestId, command })}\n`;

const runWorker = async (input) => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/main.ts"],
    {
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);

  const close = once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    stdout,
    stderr,
  }));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Pi worker did not exit within the test timeout."));
    }, 5_000);
    timer.unref();
  });
  try {
    return await Promise.race([close, timeout]);
  } finally {
    globalThis.clearTimeout(timer);
  }
};

test("runtime.shutdown stops stdin before later commands are admitted", async () => {
  const result = await runWorker(
    envelope("shutdown", { type: "runtime.shutdown", reason: "stop" }) +
      envelope("health-after-shutdown", { type: "runtime.health" }),
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.trim(), "");
});
