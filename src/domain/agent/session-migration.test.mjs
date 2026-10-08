import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  buildPiMigrationReport,
  buildPiMigrationReportForSession,
} from "./session-migration.ts";

const source = (timeline, overrides = {}) => ({
  sessionId: "session-1",
  acpSessionId: "acp-1",
  acpCursor: "cursor-1",
  timelineComplete: true,
  timeline,
  ...overrides,
});

test("marks a complete text-only conversation as a lossless candidate", () => {
  const report = buildPiMigrationReport(
    source([
      { id: "u", kind: "message", role: "user", content: "你好" },
      { id: "a", kind: "message", role: "assistant", content: "你好！" },
      { id: "t", kind: "thought", content: "先确认上下文。" },
    ]),
  );
  assert.equal(report.classification, "lossless-candidate");
  assert.deepEqual(report.counts, {
    entries: 3,
    messages: 2,
    thoughts: 1,
    plans: 0,
    tools: 0,
    questions: 0,
    permissions: 0,
    attachments: 0,
  });
});

test("keeps completed unsupported tools displayable without calling them", () => {
  const report = buildPiMigrationReport(
    source([
      {
        id: "tool",
        kind: "tool",
        title: "写文件",
        command: "write",
        output: "done",
        status: "completed",
        activity: { operation: "edit", path: "README.md" },
      },
    ]),
  );
  assert.equal(report.classification, "display-only");
  assert.equal(report.blockers.length, 0);
  assert.match(report.warnings[0], /写文件.*edit.*受控 ToolGateway.*重新审批/u);
});

test("blocks incomplete projections, pending interactions, and oversized data URLs", () => {
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
  const report = buildPiMigrationReport(
    source(
      [
        {
          id: "tool",
          kind: "tool",
          title: "执行命令",
          command: "rm",
          output: "",
          status: "pending",
          permission: "pending",
          activity: { operation: "execute" },
        },
        {
          id: "u",
          kind: "message",
          role: "user",
          content: "附件",
          attachments: [
            {
              id: "large",
              type: "file",
              filename: "large.bin",
              mediaType: "application/octet-stream",
              url: `data:application/octet-stream;base64,${oversized}`,
            },
          ],
        },
      ],
      { timelineComplete: false },
    ),
  );
  assert.equal(report.classification, "blocked");
  assert.ok(report.blockers.some((item) => /不是完整投影/u.test(item)));
  assert.ok(report.blockers.some((item) => /未决审批/u.test(item)));
  assert.ok(report.blockers.some((item) => /10 MiB/u.test(item)));
});

test("treats active plans as a hard migration boundary", () => {
  const report = buildPiMigrationReport(
    source([
      {
        id: "plan",
        kind: "plan",
        toolCallId: "plan-1",
        content: "先检查",
        status: "awaiting-approval",
      },
    ]),
  );
  assert.equal(report.classification, "blocked");
  assert.equal(report.counts.plans, 1);
});

test("uses a complete archived projection for a stored-session report", () => {
  const report = buildPiMigrationReportForSession({
    id: "session-archive",
    acpSessionId: "acp-1",
    acpCursor: "cursor-1",
    timelineJson: "[]",
    timelineVersion: 0,
    timelineArchiveJson: JSON.stringify([
      { id: "u", kind: "message", role: "user", content: "archived prompt" },
      {
        id: "a",
        kind: "message",
        role: "assistant",
        content: "archived answer",
      },
    ]),
  });

  assert.equal(report.classification, "lossless-candidate");
  assert.equal(report.counts.messages, 2);
  assert.equal(report.source.timelineComplete, true);
});

test("blocks a stored-session report when the archive cannot be read", () => {
  const report = buildPiMigrationReportForSession({
    id: "session-corrupt",
    timelineJson: JSON.stringify([
      { id: "a", kind: "message", role: "assistant", content: "partial" },
    ]),
    timelineVersion: 3,
    acpCursor: "cursor-1",
    timelineArchiveReadFailed: true,
  });

  assert.equal(report.classification, "blocked");
  assert.equal(report.source.timelineComplete, false);
  assert.ok(report.blockers.some((value) => value.includes("完整投影")));
});
