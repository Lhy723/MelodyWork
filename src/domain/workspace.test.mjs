import assert from "node:assert/strict";
import test from "node:test";

import {
  UNTITLED_SESSION_TITLES,
  isUntitledSessionTitle,
} from "./workspace.ts";

test("treats both placeholder titles as untitled", () => {
  assert.equal(isUntitledSessionTitle("New session"), true);
  assert.equal(isUntitledSessionTitle("新会话"), true);
  assert.deepEqual([...UNTITLED_SESSION_TITLES], ["New session", "新会话"]);
});

test("ignores surrounding whitespace on placeholder titles", () => {
  assert.equal(isUntitledSessionTitle("  New session\t"), true);
  assert.equal(isUntitledSessionTitle("\n新会话 "), true);
});

test("keeps an ordinary title", () => {
  assert.equal(isUntitledSessionTitle("Fix the sidebar"), false);
});

test("keeps a localized ordinary title", () => {
  assert.equal(isUntitledSessionTitle("修复侧边栏"), false);
});

test("treats an empty or whitespace-only title as untitled", () => {
  assert.equal(isUntitledSessionTitle(""), true);
  assert.equal(isUntitledSessionTitle("   "), true);
});
