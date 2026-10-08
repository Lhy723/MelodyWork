import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import test from "node:test";
import assert from "node:assert/strict";

const packageRoot = resolve(import.meta.dirname, "..");
const projectRoot = resolve(packageRoot, "../..");

const envelope = (requestId, command) =>
  `${JSON.stringify({ protocolVersion: 1, requestId, command })}\n`;

const withTimeout = (promise, message, timeoutMs = 5_000) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() =>
    globalThis.clearTimeout(timer),
  );
};

const configuredWorkerPath = () => {
  const value = process.env.MELODY_PI_WORKER_PATH?.trim();
  if (!value) return undefined;
  const path = isAbsolute(value) ? value : resolve(projectRoot, value);
  assert.doesNotThrow(() => {
    assert.equal(statSync(path).isFile(), true);
  }, `MELODY_PI_WORKER_PATH 不是文件：${path}`);
  return path;
};

const spawnWorker = (home) => {
  const configured = configuredWorkerPath();
  const command = configured ? configured : process.execPath;
  const args = configured ? [] : ["--experimental-strip-types", "src/main.ts"];
  return spawn(command, args, {
    cwd: packageRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      // A smoke test must never touch a developer's real Pi credentials or
      // session history, including when a packaged worker is under test.
      MELODY_HOME: home,
      MELODY_PI_SESSION_ROOT: join(home, "sessions"),
      MELODY_PI_AUTH_PATH: join(home, "auth.json"),
      MELODY_PI_MODELS_PATH: join(home, "models.json"),
    },
  });
};

const nextFrame = (readline) =>
  new Promise((resolveFrame, reject) => {
    const onLine = (line) => {
      if (line.trim().length === 0) return;
      cleanup();
      try {
        resolveFrame(JSON.parse(line));
      } catch (error) {
        reject(
          new Error(
            `Pi worker 输出了无效 JSON：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Pi worker 在返回预期 frame 前关闭了 stdout。"));
    };
    const cleanup = () => {
      readline.off("line", onLine);
      readline.off("close", onClose);
    };
    readline.on("line", onLine);
    readline.once("close", onClose);
  });

const waitForClose = (child) =>
  once(child, "close").then(([code, signal]) => ({ code, signal }));

test("Pi worker health handshake works with source and packaged entrypoints", async () => {
  const home = mkdtempSync(join(tmpdir(), "melody-pi-worker-smoke-"));
  const child = spawnWorker(home);
  const readline = createInterface({ input: child.stdout });
  let stderr = "";
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    child.stdin.write(envelope("health", { type: "runtime.health" }));
    const frame = await withTimeout(
      nextFrame(readline),
      "Pi worker 健康握手超时。",
    );
    assert.equal(frame.protocolVersion, 1);
    assert.equal(frame.requestId, "health");
    assert.equal(frame.replay, false);
    assert.equal(frame.event?.type, "runtime.ready");
    assert.equal(frame.event.capabilities.engine, "pi");
    assert.equal(frame.event.capabilities.engineVersion, "1.0.1");
    assert.equal(frame.event.capabilities.protocolVersion, 1);
    assert.equal(frame.event.capabilities.mcp, true);
    assert.equal(
      frame.event.capabilities.tools.includes("workspace_read_tool_output"),
      true,
    );
    assert.deepEqual(frame.event.capabilities.sessionModes, [
      "default",
      "plan",
      "ask",
    ]);

    child.stdin.end(
      envelope("shutdown", { type: "runtime.shutdown", reason: "stop" }),
    );
    const result = await withTimeout(
      waitForClose(child),
      "Pi worker 优雅关闭超时。",
    );
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null);
  } finally {
    readline.close();
    if (!closed && child.exitCode === null) child.kill("SIGKILL");
    if (!closed) {
      await withTimeout(
        once(child, "close").catch(() => undefined),
        "Pi worker 强制回收超时。",
      ).catch(() => undefined);
    }
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * A local OpenAI-compatible provider so a real turn can run without network
 * access. The first request asks for the `scheduler_create` tool; once a tool
 * result is present the second request answers with plain text.
 */
const startStubProvider = async () => {
  const requests = [];
  const delta = (payload, finishReason = null) => ({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [{ index: 0, delta: payload, finish_reason: finishReason }],
  });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = (() => {
        try {
          return JSON.parse(body);
        } catch {
          return {};
        }
      })();
      requests.push(payload);
      const hasToolResult = (payload.messages ?? []).some(
        (message) => message.role === "tool",
      );
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const chunks = hasToolResult
        ? [
            delta({ role: "assistant", content: "" }),
            delta({ content: "调度已创建。" }),
            delta({}, "stop"),
          ]
        : [
            delta({ role: "assistant", content: "" }),
            delta({
              tool_calls: [
                {
                  index: 0,
                  id: "call-stub-1",
                  type: "function",
                  function: {
                    name: "scheduler_create",
                    arguments: JSON.stringify({
                      interval: "5m",
                      prompt: "stub prompt",
                    }),
                  },
                },
              ],
            }),
            delta({}, "tool_calls"),
          ];
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    port: server.address().port,
    requests,
    close: () =>
      new Promise((closed) => {
        server.close(closed);
      }),
  };
};

test("one model tool call produces exactly one gateway request and finishes the turn", async () => {
  const provider = await startStubProvider();
  const home = mkdtempSync(join(tmpdir(), "melody-pi-round-trip-"));
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({
      providers: {
        "melody-stub": {
          name: "Stub",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          api: "openai-completions",
          apiKey: "stub-key",
          authHeader: true,
          models: [
            {
              id: "stub-model",
              name: "Stub Model",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(join(home, "auth.json"), "{}");

  const child = spawnWorker(home);
  const readline = createInterface({ input: child.stdout });
  const frames = [];
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const events = () => frames.map((frame) => frame.event).filter(Boolean);
  // A persistent listener: a one-shot reader drops frames that arrive between
  // two awaits, and a turn emits several in a burst.
  readline.on("line", (line) => {
    if (!line.trim()) return;
    try {
      frames.push(JSON.parse(line));
    } catch {
      // Surfaces as a timeout with the assertion message below.
    }
  });
  const waitFor = (predicate, message, timeoutMs = 30_000) =>
    withTimeout(
      (async () => {
        for (;;) {
          const found = frames.find(predicate);
          if (found) return found;
          await new Promise((tick) => setTimeout(tick, 25));
        }
      })(),
      message,
      timeoutMs,
    );

  try {
    child.stdin.write(envelope("health", { type: "runtime.health" }));
    const ready = await waitFor(
      (frame) => frame.event?.type === "runtime.ready",
      "Pi worker 健康握手超时。",
    );
    // The announcement is derived from the gateway's name list; a tool that is
    // registered but missing from it would be absent here.
    for (const tool of [
      "monitor",
      "scheduler_create",
      "scheduler_list",
      "scheduler_delete",
    ]) {
      assert.equal(
        ready.event.capabilities.tools.includes(tool),
        true,
        `${tool} 必须在运行时能力清单里`,
      );
    }

    child.stdin.write(
      envelope("open", {
        type: "session.open",
        sessionId: "round-trip",
        productSessionId: "round-trip",
        cwd: workspace,
        modelId: "stub-model",
        permissionMode: "always-approve",
        sessionModeId: "default",
      }),
    );
    const opened = await waitFor(
      (frame) => frame.event?.type === "session.opened",
      "session.open 超时。",
    );
    const revision = opened.event.revision ?? 0;

    // A stale optimistic-concurrency token must be refused, not applied.
    child.stdin.write(
      envelope("stale", {
        type: "turn.submit",
        sessionId: "round-trip",
        promptId: "stale-prompt",
        content: "stale",
        attachments: [],
        config: {
          modelId: "stub-model",
          sessionModeId: "default",
          permissionMode: "always-approve",
          configRevision: revision + 5,
        },
      }),
    );
    await waitFor(
      (frame) => frame.event?.error?.code === "pi.config_revision_conflict",
      "过期 configRevision 没有被拒绝。",
    );

    child.stdin.write(
      envelope("turn", {
        type: "turn.submit",
        sessionId: "round-trip",
        promptId: "round-trip-prompt",
        content: "创建一个定期调度",
        attachments: [],
        config: {
          modelId: "stub-model",
          sessionModeId: "default",
          permissionMode: "always-approve",
          configRevision: revision,
        },
      }),
    );
    const requested = await waitFor(
      (frame) => frame.event?.type === "tool.requested",
      "工具请求超时。",
      45_000,
    );
    const request = requested.event;
    assert.equal(request.toolName, "scheduler_create");
    // The gateway attaches `activity`; the provider-level duplicate that used to
    // appear did not, and carried the model's raw arguments.
    assert.equal(request.activity?.gateway, "melody");
    assert.equal(request.activity?.arguments?.interval, "5m");

    // Give the worker a chance to emit any duplicate request before asserting.
    await new Promise((settle) => setTimeout(settle, 1_000));
    const duplicates = events().filter(
      (event) =>
        event.type === "tool.requested" &&
        event.toolName === "scheduler_create",
    );
    assert.equal(duplicates.length, 1, "一次工具调用只能产生一个权威请求");

    child.stdin.write(
      envelope("resolve", {
        type: "tool.resolve",
        sessionId: "round-trip",
        toolCallId: request.toolCallId,
        resolution: { status: "completed", output: '{"id":"stub"}' },
      }),
    );
    const finished = await waitFor(
      (frame) => frame.event?.type === "run.finished",
      "回合未能结束。",
      45_000,
    );
    assert.equal(finished.event.status ?? finished.event.outcome, "completed");
    const finalMessage = events()
      .filter(
        (event) =>
          event.type === "message.completed" && event.role === "assistant",
      )
      .map((event) => event.content ?? "")
      .join(" ");
    assert.match(finalMessage, /调度已创建/);
    assert.equal(
      provider.requests.length,
      2,
      "provider 应收到工具调用与收尾两次请求",
    );

    child.stdin.end(
      envelope("shutdown", { type: "runtime.shutdown", reason: "stop" }),
    );
    const result = await withTimeout(
      waitForClose(child),
      "Pi worker 优雅关闭超时。",
    );
    assert.equal(result.code, 0, stderr);
  } finally {
    readline.close();
    if (!closed && child.exitCode === null) child.kill("SIGKILL");
    if (!closed) {
      await withTimeout(
        once(child, "close").catch(() => undefined),
        "Pi worker 强制回收超时。",
      ).catch(() => undefined);
    }
    await provider.close();
    rmSync(home, { recursive: true, force: true });
  }
});
