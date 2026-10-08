import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_STATUS_NOTICE,
  isComposerReadOnly,
  isLegacyArchiveSession,
  shouldImportPiSession,
} from "./session-archive.ts";

const legacyAcpBinding = { piBindingEngine: "melody-acp" };
const piBinding = { piBindingEngine: "pi" };
const noBinding = { piBindingEngine: undefined };

test("never archives a session durably bound to Pi", () => {
  // A Pi-migrated session keeps its legacy acpSessionId on the record and its
  // persisted timeline; only the binding says it now runs on Pi.
  assert.equal(
    isLegacyArchiveSession({
      ...piBinding,
      acpSessionId: "acp-legacy",
      hasPersistedTimeline: true,
    }),
    false,
  );
  assert.equal(
    isLegacyArchiveSession({ ...piBinding, hasPersistedTimeline: true }),
    false,
  );
  assert.equal(
    isLegacyArchiveSession({
      ...piBinding,
      acpSessionId: "acp-legacy",
      hasPersistedTimeline: false,
    }),
    false,
  );
});

test("archives a session that only has a legacy ACP session id", () => {
  assert.equal(
    isLegacyArchiveSession({
      ...noBinding,
      acpSessionId: "acp-legacy",
      hasPersistedTimeline: false,
    }),
    true,
  );
});

test("archives a session that only has a persisted timeline", () => {
  assert.equal(
    isLegacyArchiveSession({
      ...noBinding,
      acpSessionId: undefined,
      hasPersistedTimeline: true,
    }),
    true,
  );
});

test("keeps a session with no binding and no history on the normal open path", () => {
  // A brand-new session has no engine binding yet and no history of either
  // kind; it must not be locked into read-only mode.
  assert.equal(
    isLegacyArchiveSession({
      ...noBinding,
      acpSessionId: null,
      hasPersistedTimeline: false,
    }),
    false,
  );
});

test("does not import a new session whose optional ACP id is null", () => {
  assert.equal(
    shouldImportPiSession({
      piBindingEngine: undefined,
      acpSessionId: null,
    }),
    false,
  );
});

test("imports legacy ACP sessions but never imports Pi-bound sessions", () => {
  assert.equal(
    shouldImportPiSession({
      piBindingEngine: undefined,
      acpSessionId: "acp-legacy",
    }),
    true,
  );
  assert.equal(
    shouldImportPiSession({
      piBindingEngine: "melody-acp",
      acpSessionId: null,
    }),
    true,
  );
  assert.equal(
    shouldImportPiSession({
      piBindingEngine: "pi",
      acpSessionId: "acp-legacy",
    }),
    false,
  );
  assert.equal(
    shouldImportPiSession({
      piBindingEngine: undefined,
      acpSessionId: "   ",
    }),
    false,
  );
});

test("archives a melody-acp-bound session with history", () => {
  assert.equal(
    isLegacyArchiveSession({
      ...legacyAcpBinding,
      acpSessionId: "acp-legacy",
      hasPersistedTimeline: true,
    }),
    true,
  );
  assert.equal(
    isLegacyArchiveSession({
      ...legacyAcpBinding,
      acpSessionId: "acp-legacy",
      hasPersistedTimeline: false,
    }),
    true,
  );
});

test("archives a melody-acp-bound session even without persisted history", () => {
  // Chosen deliberately: the melody-acp binding alone proves the session was
  // created by the legacy engine, so it must reopen as an archive instead of
  // silently restarting that engine when its history has not been persisted.
  assert.equal(
    isLegacyArchiveSession({
      ...legacyAcpBinding,
      acpSessionId: undefined,
      hasPersistedTimeline: false,
    }),
    true,
  );
});

test("ignores blank ACP session ids and unknown binding engines", () => {
  assert.equal(
    isLegacyArchiveSession({
      ...noBinding,
      acpSessionId: "   ",
      hasPersistedTimeline: false,
    }),
    false,
  );
  // An unreadable binding (read failure) is reported as an unknown engine;
  // with real history present the session still archives instead of starting
  // an engine, which is the safe direction for a legacy-looking session.
  assert.equal(
    isLegacyArchiveSession({
      piBindingEngine: "",
      acpSessionId: "acp-legacy",
      hasPersistedTimeline: false,
    }),
    true,
  );
});

test("exposes the archive status notice for the composer gate", () => {
  assert.equal(
    ARCHIVE_STATUS_NOTICE,
    "该会话由旧引擎创建，已归档为只读；历史记录仍可查看，新工作请新建会话。",
  );
});

test("keeps the new-task composer editable when an archived session is selected", () => {
  assert.equal(
    isComposerReadOnly({
      archivedReadOnly: true,
      creatingNewTask: true,
    }),
    false,
  );
});

test("keeps the selected legacy archive composer read-only", () => {
  assert.equal(
    isComposerReadOnly({
      archivedReadOnly: true,
      creatingNewTask: false,
    }),
    true,
  );
});
