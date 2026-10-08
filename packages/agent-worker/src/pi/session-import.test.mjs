import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializePiSessionImport } from "./session-import.ts";

const plan = (records) => ({
  planVersion: 1,
  targetFormat: "pi-coding-agent-v3",
  sourceSessionId: "session-1",
  records,
});

test("materializes native messages and display-only records atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "melody-pi-import-"));
  const path = join(root, "session.jsonl");
  const result = materializePiSessionImport(
    plan([
      {
        recordId: "u1",
        sourceEntryId: "u1",
        target: "native-message",
        kind: "message",
        role: "user",
        content: "你好",
      },
      {
        recordId: "a1",
        sourceEntryId: "a1",
        target: "custom-entry",
        kind: "thought",
        content: "先检查配置",
      },
    ]),
    { path, cwd: "/workspace/demo", backup: true },
  );
  const entries = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(result.records, 2);
  assert.equal(result.nativeMessages, 1);
  assert.equal(result.displayEntries, 1);
  assert.equal(entries[0].type, "session");
  assert.equal(entries[1].type, "message");
  assert.equal(entries[1].message.role, "user");
  assert.equal(entries[2].type, "custom");
  assert.equal(entries[2].customType, "melody.import");
});

test("materializes a complete Pi assistant message without inventing metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "melody-pi-import-"));
  const path = join(root, "session.jsonl");
  materializePiSessionImport(
    plan([
      {
        recordId: "u1",
        sourceEntryId: "u1",
        target: "native-message",
        kind: "message",
        role: "user",
        content: "你好",
      },
      {
        recordId: "a1",
        sourceEntryId: "a1",
        target: "native-message",
        kind: "message",
        role: "assistant",
        content: "你好！",
        assistantMetadata: {
          provider: "openai",
          api: "openai-completions",
          model: "gpt-test",
          stopReason: "stop",
          usage: {
            input: 11,
            output: 7,
            cacheRead: 3,
            cacheWrite: 2,
            totalTokens: 23,
            cost: {
              input: 0.001,
              output: 0.002,
              cacheRead: 0.0001,
              cacheWrite: 0.0002,
              total: 0.0033,
            },
          },
        },
      },
    ]),
    { path, cwd: "/workspace/demo" },
  );
  const entries = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries[1].message.timestamp > 0, true);
  assert.equal(entries[2].message.role, "assistant");
  assert.deepEqual(entries[2].message.content, [
    { type: "text", text: "你好！" },
  ]);
  assert.equal(entries[2].message.provider, "openai");
  assert.equal(entries[2].message.api, "openai-completions");
  assert.equal(entries[2].message.model, "gpt-test");
  assert.equal(entries[2].message.usage.totalTokens, 23);
  assert.equal(entries[2].message.stopReason, "stop");
});

test("rejects a native assistant record without complete Pi metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "melody-pi-import-"));
  assert.throws(
    () =>
      materializePiSessionImport(
        plan([
          {
            recordId: "a1",
            sourceEntryId: "a1",
            target: "native-message",
            kind: "message",
            role: "assistant",
            content: "不完整",
          },
        ]),
        { path: join(root, "session.jsonl"), cwd: "/workspace/demo" },
      ),
    /must include Pi metadata/u,
  );
});

test("backs up an existing native session before replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "melody-pi-import-"));
  const path = join(root, "session.jsonl");
  writeFileSync(path, "old\n");
  const result = materializePiSessionImport(plan([]), {
    path,
    cwd: "/workspace/demo",
    backup: true,
  });
  assert.ok(result.backupPath);
  assert.equal(readFileSync(result.backupPath, "utf8"), "old\n");
});

test("rejects duplicate records and disabled backups", () => {
  const root = mkdtempSync(join(tmpdir(), "melody-pi-import-"));
  const path = join(root, "session.jsonl");
  assert.throws(
    () =>
      materializePiSessionImport(
        plan([
          { recordId: "same", kind: "thought", content: "a" },
          { recordId: "same", kind: "thought", content: "b" },
        ]),
        { path, cwd: "/workspace/demo" },
      ),
    /duplicate import record id/u,
  );
  writeFileSync(path, "old\n");
  assert.throws(
    () =>
      materializePiSessionImport(plan([]), { path, cwd: "/workspace/demo" }),
    /enable backup/u,
  );
});
