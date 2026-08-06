import assert from "node:assert/strict";
import test from "node:test";

import { extractToolActivity } from "./tool-activity.ts";

test("extracts an ACP file diff without discarding line metadata", () => {
  const activity = extractToolActivity({
    title: "Edit `src/agent-store.ts`",
    kind: "edit",
    content: [{
      type: "diff",
      path: "src/agent-store.ts",
      oldText: "const oldValue = 1;\n",
      newText: "const newValue = 2;\n",
      _meta: { old_line: 42, new_line: 42 },
    }],
  });

  assert.deepEqual(activity, {
    operation: "edit",
    path: "src/agent-store.ts",
    query: undefined,
    glob: undefined,
    files: [{
      path: "src/agent-store.ts",
      operation: "edit",
      oldText: "const oldValue = 1;\n",
      newText: "const newValue = 2;\n",
      additions: 1,
      deletions: 1,
      oldStartLine: 42,
      newStartLine: 42,
      hunks: undefined,
    }],
  });
});

test("uses Melody edit details for accurate whole-file change counts", () => {
  const activity = extractToolActivity({
    title: "Apply patch",
    kind: "edit",
    content: [{
      type: "diff",
      path: "/project/src/app.ts",
      oldText: "unchanged\nold\nstill unchanged\n",
      newText: "unchanged\nnew\nstill unchanged\n",
      _meta: {
        details: [{
          old_string: "old",
          new_string: "new",
          old_line: 2,
          new_line: 2,
          context_before: "unchanged",
          context_after: "still unchanged",
        }],
      },
    }],
  });

  assert.equal(activity.files?.[0]?.additions, 1);
  assert.equal(activity.files?.[0]?.deletions, 1);
  assert.equal(activity.files?.[0]?.hunks?.[0]?.oldStartLine, 2);
});

test("recognizes Melody grep metadata", () => {
  const activity = extractToolActivity({
    title: "function upsertTool",
    kind: "search",
    rawInput: {
      variant: "Grep",
      pattern: "function upsertTool",
      path: "src",
      glob: "*.ts",
    },
  });

  assert.equal(activity.operation, "search");
  assert.equal(activity.query, "function upsertTool");
  assert.equal(activity.path, "src");
  assert.equal(activity.glob, "*.ts");
});

test("preserves every ACP location for multi-file tool calls", () => {
  const activity = extractToolActivity({
    title: "Read project files",
    kind: "read",
    locations: [
      { path: "/project/src/one.ts" },
      { path: "/project/src/two.ts" },
      { path: "/project/src/one.ts" },
    ],
  });

  assert.deepEqual(activity.paths, [
    "/project/src/one.ts",
    "/project/src/two.ts",
  ]);
  assert.equal(activity.path, "/project/src/one.ts");
});

test("retains ACP locations when a later update only changes status", () => {
  const previous = extractToolActivity({
    title: "Read project files",
    kind: "read",
    locations: [
      { path: "/project/src/one.ts" },
      { path: "/project/src/two.ts" },
    ],
  });
  const completed = extractToolActivity(
    { status: "completed" },
    previous,
  );

  assert.deepEqual(completed.paths, previous.paths);
});

test("retains the start diff when a completion update omits content", () => {
  const previous = extractToolActivity({
    title: "Write `src/new.ts`",
    kind: "edit",
    content: [{
      type: "diff",
      path: "src/new.ts",
      newText: "export const value = 1;\n",
    }],
  });
  const completed = extractToolActivity(
    { status: "completed", rawOutput: { success: true } },
    previous,
  );

  assert.equal(completed.operation, "create");
  assert.equal(completed.files?.[0]?.additions, 1);
});
