import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPiSessionImportPlan,
  buildPiSessionImportPlanForSession,
} from "./pi-session-import.ts";

const source = (timeline, overrides = {}) => ({
  sessionId: "session-1",
  acpSessionId: "acp-1",
  acpCursor: "cursor-1",
  timelineComplete: true,
  timeline,
  ...overrides,
});

test("creates deterministic native candidates for a simple user-only source", () => {
  const timeline = [
    { id: "user-1", kind: "message", role: "user", content: "检查状态" },
  ];
  const first = buildPiSessionImportPlan(source(timeline));
  const second = buildPiSessionImportPlan(source(timeline));

  assert.equal(first.readiness, "native-ready");
  assert.equal(first.nativeCandidateCount, 1);
  assert.equal(first.displayOnlyCount, 0);
  assert.deepEqual(first.records[0], {
    recordId: first.records[0].recordId,
    sourceIndex: 0,
    sourceEntryId: "user-1",
    target: "native-message",
    kind: "message",
    role: "user",
    content: "检查状态",
    attachments: [],
  });
  assert.equal(first.sourceDigest, second.sourceDigest);
  assert.deepEqual(first.mapping, second.mapping);
});

test("keeps assistant messages and thoughts out of Pi context", () => {
  const plan = buildPiSessionImportPlan(
    source([
      { id: "u", kind: "message", role: "user", content: "你好" },
      { id: "a", kind: "message", role: "assistant", content: "你好！" },
      { id: "t", kind: "thought", content: "先读取配置。" },
    ]),
  );

  assert.equal(plan.readiness, "display-only");
  assert.equal(plan.nativeCandidateCount, 1);
  assert.equal(plan.displayOnlyCount, 2);
  assert.equal(plan.records[1].target, "custom-entry");
  assert.equal(plan.records[1].displayOnlyReason, "assistant-metadata-missing");
  assert.ok(
    plan.warnings.some((value) => value.includes("provider/api/usage")),
  );
  assert.equal(plan.mapping[2].target, "custom-entry");
});

test("allows Pi assistant rows with complete native metadata into context", () => {
  const plan = buildPiSessionImportPlan(
    source([
      { id: "u", kind: "message", role: "user", content: "你好" },
      {
        id: "a",
        kind: "message",
        role: "assistant",
        content: "你好！",
        assistantMetadata: {
          provider: "openai",
          api: "openai-completions",
          model: "gpt-test",
          responseId: "response-1",
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
  );
  assert.equal(plan.readiness, "native-ready");
  assert.equal(plan.nativeCandidateCount, 2);
  assert.equal(plan.displayOnlyCount, 0);
  assert.equal(plan.records[1].target, "native-message");
  assert.equal(plan.records[1].assistantMetadata.provider, "openai");
  assert.equal(plan.records[1].assistantMetadata.usage.totalTokens, 23);
});

test("defers valid image materialization and blocks external or malformed attachments", () => {
  const plan = buildPiSessionImportPlan(
    source([
      {
        id: "image-message",
        kind: "message",
        role: "user",
        content: "看图",
        attachments: [
          {
            id: "image-1",
            type: "file",
            filename: "pixel.png",
            mediaType: "image/png",
            url: "data:image/png;base64,aGk=",
          },
          {
            id: "external-1",
            type: "file",
            filename: "outside.txt",
            mediaType: "text/plain",
            url: "file:///tmp/outside.txt",
          },
        ],
      },
    ]),
  );

  assert.equal(plan.readiness, "blocked");
  assert.equal(plan.records[0].target, "custom-entry");
  assert.equal(
    plan.records[0].displayOnlyReason,
    "attachment-materialization-deferred",
  );
  assert.deepEqual(plan.records[0].attachments[0], {
    id: "image-1",
    filename: "pixel.png",
    mediaType: "image/png",
    kind: "image",
    byteLength: 2,
    materialization: "deferred",
  });
  assert.equal(plan.records[0].attachments[1].materialization, "unavailable");
  assert.ok(plan.blockers.some((value) => value.includes("不是 data URL")));
});

test("turns malformed archive rows and duplicate IDs into blockers instead of throwing", () => {
  const plan = buildPiSessionImportPlan(
    source([
      { id: "duplicate", kind: "message", role: "user", content: "一" },
      { id: "duplicate", kind: "message", role: "user", content: "二" },
      {
        id: "bad-attachment",
        kind: "message",
        role: "user",
        content: "附件",
        attachments: [{ id: "", mediaType: "", url: null }],
      },
      { id: "future-entry", kind: "new-future-kind", content: "未知" },
    ]),
  );

  assert.equal(plan.readiness, "blocked");
  assert.ok(plan.blockers.some((value) => value.includes("重复")));
  assert.ok(plan.blockers.some((value) => value.includes("字段不完整")));
  assert.ok(plan.blockers.some((value) => value.includes("暂不支持")));
  assert.equal(plan.records.length, 3);
  assert.equal(plan.records[2].attachments[0].materialization, "unavailable");
});

test("blocks active interactions and tool execution while preserving display records", () => {
  const plan = buildPiSessionImportPlan(
    source([
      {
        id: "tool-1",
        kind: "tool",
        title: "写文件",
        command: "write",
        output: "",
        status: "running",
        permission: "pending",
        activity: { operation: "edit", path: "README.md" },
      },
      {
        id: "plan-1",
        kind: "plan",
        toolCallId: "tool-1",
        content: "等待确认",
        status: "awaiting-approval",
      },
    ]),
  );

  assert.equal(plan.readiness, "blocked");
  assert.equal(plan.records.length, 2);
  assert.equal(plan.records[0].target, "custom-entry");
  assert.equal(plan.records[0].hasPendingPermission, true);
  assert.ok(plan.blockers.some((value) => value.includes("未决审批")));
  assert.ok(plan.blockers.some((value) => value.includes("仍在运行")));
  assert.ok(plan.blockers.some((value) => value.includes("未结束交互")));
});

test("uses an explicit bounded plan for incomplete or oversized sources", () => {
  const oversized = Array.from({ length: 4097 }, (_, index) => ({
    id: `entry-${index}`,
    kind: "message",
    role: "user",
    content: "x",
  }));
  const plan = buildPiSessionImportPlan(
    source(oversized, { timelineComplete: false }),
  );

  assert.equal(plan.sourceEntryCount, 4097);
  assert.equal(plan.records.length, 4096);
  assert.equal(plan.sourceDigestComplete, false);
  assert.equal(plan.readiness, "blocked");
  assert.ok(plan.blockers.some((value) => value.includes("不是完整投影")));
  assert.ok(plan.blockers.some((value) => value.includes("4096")));
});

test("builds a plan from a complete persisted archive and blocks archive failures", () => {
  const complete = buildPiSessionImportPlanForSession({
    id: "archived",
    acpSessionId: "acp-1",
    acpCursor: "cursor-1",
    timelineJson: "[]",
    timelineVersion: 0,
    timelineArchiveJson: JSON.stringify([
      { id: "u", kind: "message", role: "user", content: "归档" },
    ]),
  });
  assert.equal(complete.sourceTimelineComplete, true);
  assert.equal(complete.readiness, "native-ready");

  const failed = buildPiSessionImportPlanForSession({
    id: "failed",
    timelineJson: "[]",
    timelineVersion: 3,
    acpCursor: "cursor-1",
    timelineArchiveReadFailed: true,
  });
  assert.equal(failed.sourceTimelineComplete, false);
  assert.equal(failed.readiness, "blocked");
});
