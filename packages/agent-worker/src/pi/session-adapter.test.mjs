import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  applyModelPolicyOverrides,
  decodeAttachment,
  assertModelSupportsAttachments,
  MAX_PI_ATTACHMENT_BYTES,
  PiSessionAdapter,
  assertPiForkTargetMatches,
  piSessionFileFor,
  piSubagentRecordFileFor,
  parsePersistedPiSubagentRecord,
  assertActivePiRun,
  assertPiCancelTarget,
  loadPiModelPolicies,
  modelSupportsInput,
  piSkillPathsFor,
  piPromptPathsFor,
  parseHostTaskSnapshots,
  normalizePiResumeFrom,
  normalizePiSubagentCwd,
  parsePiWorktreeResponse,
  assertPiResumeTarget,
  assertPiInteractiveChildTarget,
  settingsOverridesForModel,
  validateTurnConfigSnapshot,
} from "./session-adapter.ts";

test("normalizes Melody-compatible resume_from values", () => {
  assert.equal(normalizePiResumeFrom(undefined), undefined);
  assert.equal(normalizePiResumeFrom(""), undefined);
  assert.equal(normalizePiResumeFrom("  "), undefined);
  assert.equal(normalizePiResumeFrom("null"), undefined);
  assert.equal(normalizePiResumeFrom(" None "), undefined);
  assert.equal(normalizePiResumeFrom("subagent-42"), "subagent-42");
  assert.throws(
    () => normalizePiResumeFrom("x".repeat(513)),
    (error) => error?.agentError?.code === "pi.resume_id_invalid",
  );
  assert.throws(
    () => normalizePiResumeFrom(42),
    (error) => error?.agentError?.code === "pi.resume_id_invalid",
  );
});

test("Pi's initial project context loader includes a root CLAUDE.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "melody-pi-root-context-"));
  const content = "Use the project's documented validation commands.";
  try {
    await writeFile(join(root, "CLAUDE.md"), content, "utf8");
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, ".pi-agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const files = loader.getAgentsFiles().agentsFiles;
    assert.ok(
      files.some(
        (file) =>
          file.path === join(root, "CLAUDE.md") && file.content === content,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only resumes completed, persisted descendants in the same root", () => {
  const base = {
    taskId: "old-task",
    rootSessionId: "root-1",
    status: "completed",
    sessionFile: "/tmp/pi-sessions/old.jsonl",
  };
  assert.doesNotThrow(() => assertPiResumeTarget("old-task", base, "root-1"));
  for (const [candidate, code] of [
    [{ ...base, status: "running" }, "pi.resume_running"],
    [{ ...base, status: "failed" }, "pi.resume_not_completed"],
    [{ ...base, sessionFile: undefined }, "pi.resume_unavailable"],
    [{ ...base, rootSessionId: "root-2" }, "pi.resume_scope_denied"],
  ]) {
    assert.throws(
      () => assertPiResumeTarget("old-task", candidate, "root-1"),
      (error) => error?.agentError?.code === code,
    );
  }
  assert.throws(
    () => assertPiResumeTarget("missing", undefined, "root-1"),
    (error) => error?.agentError?.code === "pi.resume_not_found",
  );
});

test("interactive child continuation is limited to completed top-level children", () => {
  const child = {
    taskId: "child-task",
    rootSessionId: "root-session",
    parentSessionId: "root-session",
    status: "completed",
    sessionFile: "/tmp/pi-sessions/child.jsonl",
  };
  assert.doesNotThrow(() =>
    assertPiInteractiveChildTarget("child-task", child, "root-session"),
  );
  assert.throws(
    () =>
      assertPiInteractiveChildTarget(
        "nested-task",
        {
          ...child,
          taskId: "nested-task",
          parentSessionId: "child-session",
          parentTaskId: "child-task",
        },
        "root-session",
      ),
    (error) =>
      error?.agentError?.code === "pi.resume_parent_scope_denied" ||
      error?.agentError?.code === "pi.child_continue_scope_denied",
  );
});

test("keeps subagent cwd inside the authenticated workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "melody-pi-cwd-"));
  const child = join(root, "packages", "worker");
  const outside = await mkdtemp(join(tmpdir(), "melody-pi-outside-"));
  try {
    await mkdir(child, { recursive: true });
    assert.equal(
      normalizePiSubagentCwd("packages/worker", root, root),
      await realpath(child),
    );
    assert.equal(normalizePiSubagentCwd(undefined, root, root), undefined);
    assert.throws(
      () => normalizePiSubagentCwd("../melody-pi-outside", root, root),
      (error) => error?.agentError?.code === "pi.subagent_cwd_invalid",
    );
    await symlink(outside, join(root, "outside-link"));
    assert.throws(
      () => normalizePiSubagentCwd("outside-link", root, root),
      (error) => error?.agentError?.code === "pi.subagent_cwd_scope_denied",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("validates the Host-created subagent worktree response", () => {
  assert.equal(
    parsePiWorktreeResponse(JSON.stringify({ worktree_path: "/tmp/demo" })),
    "/tmp/demo",
  );
  assert.equal(
    parsePiWorktreeResponse(JSON.stringify({ worktreePath: "/tmp/demo-2" })),
    "/tmp/demo-2",
  );
  for (const output of [
    "not-json",
    JSON.stringify({ worktree_path: "" }),
    JSON.stringify({ worktree_path: "x\u0000y" }),
    JSON.stringify({ worktree_path: "x".repeat(4_097) }),
    JSON.stringify({ worktree_path: ["/tmp/demo"] }),
  ]) {
    assert.throws(
      () => parsePiWorktreeResponse(output),
      (error) => error?.agentError?.code === "pi.subagent_worktree_invalid",
    );
  }
});

test("parses Host-owned background terminal task snapshots", () => {
  assert.deepEqual(
    parseHostTaskSnapshots(
      JSON.stringify({
        task_id: "pi-terminal-task:abc",
        status: "completed",
        output: "done",
      }),
    ),
    [{ taskId: "pi-terminal-task:abc", status: "completed", output: "done" }],
  );
  assert.deepEqual(
    parseHostTaskSnapshots(
      JSON.stringify([
        { task_id: "pi-terminal-task:a", status: "running" },
        { task_id: "pi-terminal-task:b", status: "cancelled", output: "" },
      ]),
    ),
    [
      { taskId: "pi-terminal-task:a", status: "running" },
      { taskId: "pi-terminal-task:b", status: "cancelled", output: "" },
    ],
  );
  assert.throws(
    () => parseHostTaskSnapshots('{"task_id":"bad"}'),
    /缺少有效 task_id 或 status/u,
  );
});

test("derives deterministic opaque native-session paths", () => {
  const first = piSessionFileFor(
    "/tmp/melody-pi-sessions",
    "/workspace/demo",
    "melody-session-1",
  );
  const same = piSessionFileFor(
    "/tmp/melody-pi-sessions",
    "/workspace/demo",
    "melody-session-1",
  );
  const otherWorkspace = piSessionFileFor(
    "/tmp/melody-pi-sessions",
    "/workspace/other",
    "melody-session-1",
  );

  assert.equal(first, same);
  assert.notEqual(first, otherWorkspace);
  assert.match(first, /\/session-[0-9a-f]{64}\.jsonl$/u);
  assert.doesNotMatch(first, /melody-session-1/u);
});

test("validates a persisted Explorer fork artifact for crash recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "melody-pi-fork-recovery-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const source = SessionManager.create(cwd, root);
  source.appendMessage({ role: "user", content: "question", timestamp: 1 });
  const anchorEntryId = source.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "verified answer" }],
    timestamp: 2,
  });
  const sourcePath = source.getSessionFile();
  const temporaryPath = source.createBranchedSession(anchorEntryId);
  assert.ok(temporaryPath);
  assert.ok(sourcePath);
  const targetPath = join(root, "persisted-target.jsonl");

  try {
    await copyFile(temporaryPath, targetPath);
    const target = SessionManager.open(targetPath, root, cwd);
    assert.doesNotThrow(() =>
      assertPiForkTargetMatches(target, sourcePath, anchorEntryId),
    );
    assert.throws(
      () =>
        assertPiForkTargetMatches(
          target,
          join(root, "other.jsonl"),
          anchorEntryId,
        ),
      (error) => error?.agentError?.code === "pi.fork_target_mismatch",
    );
    assert.throws(
      () => assertPiForkTargetMatches(target, sourcePath, "different-anchor"),
      (error) => error?.agentError?.code === "pi.fork_target_mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates durable subagent records before reopening a transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "melody-pi-subagent-record-"));
  const sessionFile = join(root, "session-child.jsonl");
  const outside = await mkdtemp(join(tmpdir(), "melody-pi-subagent-outside-"));
  const outsideFile = join(outside, "outside.jsonl");
  try {
    await writeFile(sessionFile, "{}\n");
    await writeFile(outsideFile, "{}\n");
    const record = {
      taskId: "root:task:child",
      rootSessionId: "root",
      parentSessionId: "root",
      subagentType: "explore",
      capabilityMode: "read-only",
      isolation: "none",
      sessionFile,
      cwd: root,
      reasoningEffort: "medium",
      status: "completed",
      output: "done",
      updatedAt: Date.now(),
    };
    assert.equal(
      piSubagentRecordFileFor(root, record.taskId),
      piSubagentRecordFileFor(root, record.taskId),
    );
    const parsed = parsePersistedPiSubagentRecord(record, record.taskId, root);
    assert.equal(parsed.sessionFile, await realpath(sessionFile));
    assert.equal(parsed.capabilityMode, "read-only");
    for (const candidate of [
      { ...record, taskId: "other" },
      { ...record, status: "unknown" },
      { ...record, capabilityMode: "shell" },
      { ...record, sessionFile: outsideFile },
      { ...record, updatedAt: Number.NaN },
    ]) {
      assert.throws(() =>
        parsePersistedPiSubagentRecord(candidate, record.taskId, root),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("decodes bounded image and text attachments before a Pi turn is accepted", () => {
  assert.deepEqual(
    decodeAttachment("data:image/png;base64,aGk=", "image/png"),
    {
      byteLength: 2,
      image: { type: "image", data: "aGk=", mimeType: "image/png" },
    },
  );
  assert.deepEqual(
    decodeAttachment("data:text/plain,hello%20world", "text/plain"),
    { byteLength: 11, text: "hello world" },
  );
});

test("rejects attachments larger than the Pi worker limit", () => {
  const payload = Buffer.alloc(MAX_PI_ATTACHMENT_BYTES + 1).toString("base64");
  assert.throws(
    () =>
      decodeAttachment(
        `data:application/octet-stream;base64,${payload}`,
        "application/octet-stream",
      ),
    /不能超过 10 MiB/u,
  );
});

test("rejects image input only when Pi explicitly marks a model text-only", () => {
  assert.equal(modelSupportsInput({ input: ["text"] }, "image"), false);
  assert.equal(modelSupportsInput({ input: ["text", "image"] }, "image"), true);
  // Missing metadata is intentionally treated as unknown for built-in/legacy
  // models; the provider remains responsible for its own capability check.
  assert.equal(modelSupportsInput(undefined, "image"), true);
  assert.equal(modelSupportsInput({}, "image"), true);
  assert.equal(modelSupportsInput({ input: ["text"] }, "text"), true);
});

test("reports unsupported image attachments before decoding a Pi turn", () => {
  assert.throws(
    () =>
      assertModelSupportsAttachments({ input: ["text"] }, [
        { mediaType: "image/png" },
      ]),
    (error) =>
      error?.agentError?.code === "pi.model_input_unsupported" &&
      error?.agentError?.scope === "run",
  );
  assert.doesNotThrow(() =>
    assertModelSupportsAttachments({ input: ["text"] }, [
      { mediaType: "text/plain" },
    ]),
  );
});

test("loads Host model policies and applies them to a Pi settings override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-policy-"));
  const path = join(directory, "policies.json");
  const previous = process.env.MELODY_PI_MODEL_POLICIES_PATH;
  process.env.MELODY_PI_MODEL_POLICIES_PATH = path;
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        models: {
          "melody-demo-abc/demo-v1": {
            maxRetries: 2,
            inferenceIdleTimeoutMs: 90_000,
            autoCompactThresholdPercent: 85,
          },
        },
        default: { maxRetries: 8, inferenceIdleTimeoutMs: 600_000 },
      }),
      "utf8",
    );
    const policies = await loadPiModelPolicies();
    assert.deepEqual(
      settingsOverridesForModel(
        { provider: "melody-demo-abc", id: "demo-v1", contextWindow: 1_000 },
        policies,
      ),
      {
        retry: { provider: { maxRetries: 2 } },
        httpIdleTimeoutMs: 90_000,
        // Pi triggers when contextTokens > contextWindow - reserveTokens.
        // 85% of a 1,000-token window means the first triggering token is 850.
        compaction: { reserveTokens: 151 },
      },
    );
    assert.deepEqual(
      settingsOverridesForModel(
        { provider: "melody-other", id: "other-v1", contextWindow: 1_000 },
        policies,
      ),
      {
        retry: { provider: { maxRetries: 8 } },
        httpIdleTimeoutMs: 600_000,
        compaction: { reserveTokens: 151 },
      },
    );
  } finally {
    if (previous === undefined)
      delete process.env.MELODY_PI_MODEL_POLICIES_PATH;
    else process.env.MELODY_PI_MODEL_POLICIES_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses Melody's 85 percent default when no policy snapshot is present", async () => {
  const previousPath = process.env.MELODY_PI_MODEL_POLICIES_PATH;
  const previousThreshold = process.env.MELODY_AUTO_COMPACT_THRESHOLD_PERCENT;
  delete process.env.MELODY_PI_MODEL_POLICIES_PATH;
  delete process.env.MELODY_AUTO_COMPACT_THRESHOLD_PERCENT;
  try {
    const policies = await loadPiModelPolicies();
    assert.equal(policies.defaultPolicy?.autoCompactThresholdPercent, 85);
    assert.deepEqual(
      settingsOverridesForModel(
        { provider: "melody-demo", id: "demo-v1", contextWindow: 1_000 },
        policies,
      ),
      { compaction: { reserveTokens: 151 } },
    );
  } finally {
    if (previousPath === undefined)
      delete process.env.MELODY_PI_MODEL_POLICIES_PATH;
    else process.env.MELODY_PI_MODEL_POLICIES_PATH = previousPath;
    if (previousThreshold === undefined)
      delete process.env.MELODY_AUTO_COMPACT_THRESHOLD_PERCENT;
    else process.env.MELODY_AUTO_COMPACT_THRESHOLD_PERCENT = previousThreshold;
  }
});

test("rejects malformed Host model policies instead of silently ignoring them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-policy-"));
  const path = join(directory, "policies.json");
  const previous = process.env.MELODY_PI_MODEL_POLICIES_PATH;
  process.env.MELODY_PI_MODEL_POLICIES_PATH = path;
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        models: {
          "melody-demo/demo-v1": { maxRetries: -1 },
        },
      }),
      "utf8",
    );
    await assert.rejects(loadPiModelPolicies(), /maxRetries/u);
  } finally {
    if (previous === undefined)
      delete process.env.MELODY_PI_MODEL_POLICIES_PATH;
    else process.env.MELODY_PI_MODEL_POLICIES_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an out-of-range native compaction threshold", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-policy-"));
  const path = join(directory, "policies.json");
  const previous = process.env.MELODY_PI_MODEL_POLICIES_PATH;
  process.env.MELODY_PI_MODEL_POLICIES_PATH = path;
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        models: {
          "melody-demo/demo-v1": { autoCompactThresholdPercent: 101 },
        },
      }),
      "utf8",
    );
    await assert.rejects(loadPiModelPolicies(), /autoCompactThresholdPercent/u);
  } finally {
    if (previous === undefined)
      delete process.env.MELODY_PI_MODEL_POLICIES_PATH;
    else process.env.MELODY_PI_MODEL_POLICIES_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies the Melody process threshold override to every Pi model policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-policy-"));
  const path = join(directory, "policies.json");
  const previousPath = process.env.MELODY_PI_MODEL_POLICIES_PATH;
  const previousThreshold = process.env.MELODY_AUTO_COMPACT_THRESHOLD_PERCENT;
  process.env.MELODY_PI_MODEL_POLICIES_PATH = path;
  process.env.MELODY_AUTO_COMPACT_THRESHOLD_PERCENT = "70";
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        default: { autoCompactThresholdPercent: 85 },
        models: {
          "melody-demo/demo-v1": { autoCompactThresholdPercent: 90 },
        },
      }),
      "utf8",
    );
    const policies = await loadPiModelPolicies();
    assert.equal(policies.defaultPolicy?.autoCompactThresholdPercent, 70);
    assert.equal(
      policies.models.get("melody-demo/demo-v1")?.autoCompactThresholdPercent,
      70,
    );
  } finally {
    if (previousPath === undefined)
      delete process.env.MELODY_PI_MODEL_POLICIES_PATH;
    else process.env.MELODY_PI_MODEL_POLICIES_PATH = previousPath;
    if (previousThreshold === undefined)
      delete process.env.MELODY_AUTO_COMPACT_THRESHOLD_PERCENT;
    else process.env.MELODY_AUTO_COMPACT_THRESHOLD_PERCENT = previousThreshold;
    await rm(directory, { recursive: true, force: true });
  }
});

test("replaces removed model policy fields instead of retaining stale overrides", () => {
  const defaultTimeout = SettingsManager.inMemory().getHttpIdleTimeoutMs();
  const settingsManager = SettingsManager.inMemory({
    retry: { provider: { maxRetries: 7 } },
    httpIdleTimeoutMs: 1_234,
  });

  applyModelPolicyOverrides(settingsManager, {
    retry: { provider: { maxRetries: 2 } },
  });
  assert.equal(settingsManager.getProviderRetrySettings().maxRetries, 2);
  assert.equal(settingsManager.getHttpIdleTimeoutMs(), defaultTimeout);

  applyModelPolicyOverrides(settingsManager, {});
  assert.equal(
    settingsManager.getProviderRetrySettings().maxRetries,
    undefined,
  );
  assert.equal(settingsManager.getHttpIdleTimeoutMs(), defaultTimeout);
});

test("clears a previous native compaction threshold when the policy is removed", () => {
  const settingsManager = SettingsManager.inMemory({
    compaction: { reserveTokens: 151 },
  });

  applyModelPolicyOverrides(settingsManager, {});

  assert.equal(settingsManager.getCompactionReserveTokens(), 16_384);
});

test("does not synthesize a compaction threshold without a model context window", () => {
  assert.deepEqual(
    settingsOverridesForModel(
      { provider: "melody-demo", id: "demo-v1" },
      {
        models: new Map(),
        defaultPolicy: { autoCompactThresholdPercent: 85 },
      },
    ),
    {},
  );
});

test("accepts only Host-allowlisted direct Markdown prompt paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-prompts-"));
  const project = join(directory, "project");
  const melodyHome = join(directory, "melody");
  const commandRoot = join(project, ".melody", "commands");
  const valid = join(commandRoot, "review.md");
  const nested = join(commandRoot, "nested", "review.md");
  const outside = join(directory, "outside.md");
  const previousHome = process.env.MELODY_HOME;
  const previousPaths = process.env.MELODY_PI_PROMPT_PATHS_JSON;
  await mkdir(join(commandRoot, "nested"), { recursive: true });
  await mkdir(melodyHome, { recursive: true });
  await writeFile(valid, "review");
  await writeFile(nested, "nested");
  await writeFile(outside, "outside");
  const values = [valid, nested, outside];
  if (process.platform !== "win32") {
    const linked = join(commandRoot, "linked.md");
    await symlink(valid, linked);
    values.push(linked);
  }
  process.env.MELODY_HOME = melodyHome;
  process.env.MELODY_PI_PROMPT_PATHS_JSON = JSON.stringify(values);
  try {
    assert.deepEqual(piPromptPathsFor(project), [await realpath(valid)]);
  } finally {
    if (previousHome === undefined) delete process.env.MELODY_HOME;
    else process.env.MELODY_HOME = previousHome;
    if (previousPaths === undefined)
      delete process.env.MELODY_PI_PROMPT_PATHS_JSON;
    else process.env.MELODY_PI_PROMPT_PATHS_JSON = previousPaths;
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts bounded nested Markdown Skill paths from project and user roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-skills-"));
  const project = join(directory, "project");
  const melodyHome = join(directory, "melody");
  const home = join(directory, "home");
  const nested = join(project, ".agents", "skills", "team", "review");
  const skillRoot = join(project, ".agents", "skills");
  const managed = join(melodyHome, "skills", "managed");
  const outside = join(directory, "outside");
  const linked = join(project, ".agents", "skills", "linked");
  const previousHome = process.env.MELODY_HOME;
  const previousUserHome = process.env.HOME;
  const previousPaths = process.env.MELODY_PI_SKILL_PATHS_JSON;
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(managed, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "# Root must not be loaded");
  await writeFile(join(nested, "SKILL.md"), "# Review");
  await writeFile(join(managed, "SKILL.md"), "# Managed");
  await writeFile(join(outside, "SKILL.md"), "# Outside");
  if (process.platform !== "win32") await symlink(outside, linked);
  process.env.MELODY_HOME = melodyHome;
  process.env.HOME = home;
  const values = [
    skillRoot,
    nested,
    managed,
    join(project, ".agents", "skills", "missing"),
  ];
  if (process.platform !== "win32") values.push(linked);
  process.env.MELODY_PI_SKILL_PATHS_JSON = JSON.stringify(values);
  try {
    assert.deepEqual(piSkillPathsFor(project), [
      await realpath(nested),
      await realpath(managed),
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.MELODY_HOME;
    else process.env.MELODY_HOME = previousHome;
    if (previousUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousUserHome;
    if (previousPaths === undefined)
      delete process.env.MELODY_PI_SKILL_PATHS_JSON;
    else process.env.MELODY_PI_SKILL_PATHS_JSON = previousPaths;
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes Host-projected Skill and command roots without ambient discovery", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "melody-pi-resource-refresh-"),
  );
  const project = join(directory, "project");
  const skillRoot = join(project, ".agents", "skills");
  const commandRoot = join(project, ".agents", "commands");
  const firstSkill = join(skillRoot, "first");
  const secondSkill = join(skillRoot, "second");
  const firstCommand = join(commandRoot, "first.md");
  const secondCommand = join(commandRoot, "second.md");
  const previousHome = process.env.MELODY_HOME;
  const previousSkillPaths = process.env.MELODY_PI_SKILL_PATHS_JSON;
  const previousSkillRoots = process.env.MELODY_PI_SKILL_ROOTS_JSON;
  const previousPromptPaths = process.env.MELODY_PI_PROMPT_PATHS_JSON;
  const previousPromptRoots = process.env.MELODY_PI_PROMPT_ROOTS_JSON;
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(firstSkill, { recursive: true });
  await mkdir(commandRoot, { recursive: true });
  await writeFile(join(firstSkill, "SKILL.md"), "first skill");
  await writeFile(firstCommand, "first command");
  process.env.MELODY_HOME = join(directory, "melody");
  process.env.MELODY_PI_SKILL_PATHS_JSON = "[]";
  process.env.MELODY_PI_SKILL_ROOTS_JSON = JSON.stringify([
    { path: skillRoot, disabled: [] },
  ]);
  process.env.MELODY_PI_PROMPT_PATHS_JSON = "[]";
  process.env.MELODY_PI_PROMPT_ROOTS_JSON = JSON.stringify([
    { path: commandRoot, disabled: [] },
  ]);
  try {
    assert.deepEqual(piSkillPathsFor(project), [await realpath(firstSkill)]);
    assert.deepEqual(piPromptPathsFor(project), [await realpath(firstCommand)]);

    await mkdir(secondSkill, { recursive: true });
    await writeFile(join(secondSkill, "SKILL.md"), "second skill");
    await writeFile(secondCommand, "second command");
    assert.deepEqual(piSkillPathsFor(project), [
      await realpath(firstSkill),
      await realpath(secondSkill),
    ]);
    assert.deepEqual(piPromptPathsFor(project), [
      await realpath(firstCommand),
      await realpath(secondCommand),
    ]);

    await rm(firstSkill, { recursive: true, force: true });
    await rm(firstCommand, { force: true });
    assert.deepEqual(piSkillPathsFor(project), [await realpath(secondSkill)]);
    assert.deepEqual(piPromptPathsFor(project), [
      await realpath(secondCommand),
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.MELODY_HOME;
    else process.env.MELODY_HOME = previousHome;
    if (previousSkillPaths === undefined)
      delete process.env.MELODY_PI_SKILL_PATHS_JSON;
    else process.env.MELODY_PI_SKILL_PATHS_JSON = previousSkillPaths;
    if (previousSkillRoots === undefined)
      delete process.env.MELODY_PI_SKILL_ROOTS_JSON;
    else process.env.MELODY_PI_SKILL_ROOTS_JSON = previousSkillRoots;
    if (previousPromptPaths === undefined)
      delete process.env.MELODY_PI_PROMPT_PATHS_JSON;
    else process.env.MELODY_PI_PROMPT_PATHS_JSON = previousPromptPaths;
    if (previousPromptRoots === undefined)
      delete process.env.MELODY_PI_PROMPT_ROOTS_JSON;
    else process.env.MELODY_PI_PROMPT_ROOTS_JSON = previousPromptRoots;
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts Host-projected static plugin Skill and command roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-static-plugin-"));
  const project = join(directory, "project");
  const plugin = join(directory, "melody", "installed-plugins", "static-tools");
  const skillRoot = join(plugin, "skills");
  const commandRoot = join(plugin, "commands");
  const skill = join(skillRoot, "review");
  const command = join(commandRoot, "check.md");
  const previousHome = process.env.MELODY_HOME;
  const previousSkillRoots = process.env.MELODY_PI_SKILL_ROOTS_JSON;
  const previousPromptRoots = process.env.MELODY_PI_PROMPT_ROOTS_JSON;
  try {
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(skill, { recursive: true });
    await mkdir(commandRoot, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Review");
    await writeFile(command, "# Check");
    process.env.MELODY_HOME = join(directory, "melody");
    process.env.MELODY_PI_SKILL_ROOTS_JSON = JSON.stringify([
      { path: await realpath(skillRoot), disabled: [] },
    ]);
    process.env.MELODY_PI_PROMPT_ROOTS_JSON = JSON.stringify([
      { path: await realpath(commandRoot), disabled: [] },
    ]);

    assert.deepEqual(piSkillPathsFor(project), [await realpath(skill)]);
    assert.deepEqual(piPromptPathsFor(project), [await realpath(command)]);
  } finally {
    if (previousHome === undefined) delete process.env.MELODY_HOME;
    else process.env.MELODY_HOME = previousHome;
    if (previousSkillRoots === undefined)
      delete process.env.MELODY_PI_SKILL_ROOTS_JSON;
    else process.env.MELODY_PI_SKILL_ROOTS_JSON = previousSkillRoots;
    if (previousPromptRoots === undefined)
      delete process.env.MELODY_PI_PROMPT_ROOTS_JSON;
    else process.env.MELODY_PI_PROMPT_ROOTS_JSON = previousPromptRoots;
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies a Host resource refresh manifest to live sessions", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "melody-pi-resource-command-"),
  );
  const project = join(directory, "project");
  const skillRoot = join(project, ".agents", "skills");
  const commandRoot = join(project, ".agents", "commands");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await mkdir(commandRoot, { recursive: true });
  const events = [];
  const calls = [];
  const adapter = new PiSessionAdapter(async (event) => {
    events.push(event);
  });
  adapter.sessions.set("session-1", {
    refreshResources: async (manifest) => calls.push(manifest),
    runFinished: true,
  });
  const manifest = {
    cwd: project,
    skillRoots: [
      { path: await realpath(skillRoot), scope: "project", disabled: ["old"] },
    ],
    promptRoots: [{ path: await realpath(commandRoot), disabled: ["old"] }],
  };

  try {
    await adapter.refreshResources(
      { type: "session.resources.refresh", manifest },
      "resources-1",
    );
    assert.deepEqual(calls, [manifest]);
    assert.equal(events.at(-1)?.event?.type, "runtime.warning");
    assert.equal(events.at(-1)?.event?.error?.code, "pi.resources_refreshed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clears a stale question timeout snapshot when a Host refresh omits it", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "melody-pi-question-policy-refresh-"),
  );
  const project = join(directory, "project");
  const skillRoot = join(project, ".agents", "skills");
  const commandRoot = join(project, ".agents", "commands");
  const previousPolicy = process.env.MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON;
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await mkdir(commandRoot, { recursive: true });
  process.env.MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON = JSON.stringify({
    enabled: true,
    timeoutMs: 20_000,
  });
  const adapter = new PiSessionAdapter(async () => undefined);
  const manifest = {
    cwd: project,
    skillRoots: [
      { path: await realpath(skillRoot), scope: "project", disabled: [] },
    ],
    promptRoots: [{ path: await realpath(commandRoot), disabled: [] }],
    questionTimeoutPolicy: { enabled: false, timeoutMs: 12_500 },
  };

  try {
    assert.deepEqual(adapter.questionTimeoutPolicy, {
      enabled: true,
      timeoutMs: 20_000,
    });
    await adapter.refreshResources(
      { type: "session.resources.refresh", manifest },
      "question-policy-1",
    );
    assert.deepEqual(adapter.questionTimeoutPolicy, {
      enabled: false,
      timeoutMs: 12_500,
    });

    const withoutPolicy = { ...manifest };
    delete withoutPolicy.questionTimeoutPolicy;
    await adapter.refreshResources(
      {
        type: "session.resources.refresh",
        manifest: withoutPolicy,
      },
      "question-policy-2",
    );
    assert.equal(adapter.questionTimeoutPolicy, undefined);
  } finally {
    if (previousPolicy === undefined)
      delete process.env.MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON;
    else process.env.MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON = previousPolicy;
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes and clears the Host-projected goal safety policy", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "melody-pi-goal-policy-refresh-"),
  );
  const project = join(directory, "project");
  const skillRoot = join(project, ".agents", "skills");
  const commandRoot = join(project, ".agents", "commands");
  const previousPolicy = process.env.MELODY_PI_GOAL_POLICY_JSON;
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await mkdir(commandRoot, { recursive: true });
  process.env.MELODY_PI_GOAL_POLICY_JSON = JSON.stringify({
    tokenBudget: 1_000,
    stallDetection: true,
    stallTimeoutSecs: 10,
    maxBlockedAttempts: 2,
  });
  const adapter = new PiSessionAdapter(async () => undefined);
  const manifest = {
    cwd: project,
    skillRoots: [
      { path: await realpath(skillRoot), scope: "project", disabled: [] },
    ],
    promptRoots: [{ path: await realpath(commandRoot), disabled: [] }],
    goalPolicy: {
      tokenBudget: 2_000,
      stallDetection: true,
      stallTimeoutSecs: 20,
      maxBlockedAttempts: 4,
    },
  };

  try {
    assert.deepEqual(adapter.goalPolicy, {
      tokenBudget: 1_000,
      stallDetection: true,
      stallTimeoutSecs: 10,
      maxBlockedAttempts: 2,
    });
    await adapter.refreshResources(
      { type: "session.resources.refresh", manifest },
      "goal-policy-1",
    );
    assert.deepEqual(adapter.goalPolicy, manifest.goalPolicy);

    const withoutPolicy = { ...manifest };
    delete withoutPolicy.goalPolicy;
    await adapter.refreshResources(
      {
        type: "session.resources.refresh",
        manifest: withoutPolicy,
      },
      "goal-policy-2",
    );
    assert.equal(adapter.goalPolicy, undefined);
  } finally {
    if (previousPolicy === undefined)
      delete process.env.MELODY_PI_GOAL_POLICY_JSON;
    else process.env.MELODY_PI_GOAL_POLICY_JSON = previousPolicy;
    await rm(directory, { recursive: true, force: true });
  }
});

test("defers resource refresh for a run paused between provider requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-resource-active-"));
  const project = join(directory, "project");
  const skillRoot = join(project, ".agents", "skills");
  const commandRoot = join(project, ".agents", "commands");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await mkdir(commandRoot, { recursive: true });
  let refreshCount = 0;
  const adapter = new PiSessionAdapter(async () => undefined);
  adapter.sessions.set("session-1", {
    runFinished: false,
    refreshResources: async () => {
      refreshCount += 1;
    },
  });
  const manifest = {
    cwd: project,
    skillRoots: [
      { path: await realpath(skillRoot), scope: "project", disabled: [] },
    ],
    promptRoots: [{ path: await realpath(commandRoot), disabled: [] }],
  };

  try {
    await adapter.refreshResources(
      { type: "session.resources.refresh", manifest },
      "resources-active-1",
    );
    assert.equal(refreshCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("synchronizes Host-projected model credentials before reloading Pi", async () => {
  const prefix = "MELODY_PI_MODEL_";
  const previousEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith(prefix)),
  );
  const events = [];
  const removedProviders = [];
  const refreshSnapshots = [];
  const refreshedSettings = [];
  const adapter = new PiSessionAdapter(async (event) => {
    events.push(event);
  });
  adapter.modelCatalog.getModelRuntime = async () => ({
    removeRuntimeApiKey: async (providerId) => {
      removedProviders.push(providerId);
    },
    refresh: async () => {
      refreshSnapshots.push(
        Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            name.startsWith(prefix),
          ),
        ),
      );
      return { errors: new Map() };
    },
    getModels: () => [],
    getAvailable: async () => [],
    getProviders: () => [],
    checkAuth: async () => undefined,
  });
  adapter.sessions.set("session-1", {
    refreshModelSettings: async () => refreshedSettings.push("session-1"),
    runFinished: true,
  });
  process.env.MELODY_PI_MODEL_OLD = "stale";

  try {
    await adapter.syncModels(
      {
        type: "runtime.models.sync",
        providerIds: ["melody-demo-123"],
        credentials: [
          { name: "MELODY_PI_MODEL_KEY_0_0", value: "fresh" },
          { name: "MELODY_PI_MODEL_HEADER_0_1", value: "team" },
        ],
      },
      "models-1",
    );
    assert.deepEqual(removedProviders, ["melody-demo-123"]);
    assert.deepEqual(refreshSnapshots, [
      {
        MELODY_PI_MODEL_KEY_0_0: "fresh",
        MELODY_PI_MODEL_HEADER_0_1: "team",
      },
    ]);
    assert.deepEqual(refreshedSettings, ["session-1"]);
    assert.equal(events.at(-1)?.event?.type, "runtime.models");
  } finally {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith(prefix)) delete process.env[name];
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      process.env[name] = value;
    }
  }
});

test("accepts only a turn configuration snapshot acknowledged by the session", () => {
  const authoritative = {
    modelId: "demo/model-1",
    reasoningEffort: "medium",
    sessionModeId: "default",
    permissionMode: "ask",
  };

  assert.deepEqual(
    validateTurnConfigSnapshot(
      {
        modelId: "demo/model-1",
        reasoningEffort: "medium",
        sessionModeId: "default",
        permissionMode: "ask",
        configRevision: 3,
      },
      authoritative,
    ),
    { sessionModeId: "default" },
  );

  // Optional fields are assertions when present, but omission means the
  // renderer wants to use the worker's current model/mode.
  assert.deepEqual(
    validateTurnConfigSnapshot(
      { permissionMode: "ask", configRevision: 3 },
      authoritative,
    ),
    { sessionModeId: "default" },
  );
});

test("rejects stale model, reasoning, mode, and permission snapshots", () => {
  const authoritative = {
    modelId: "demo/model-1",
    reasoningEffort: "medium",
    sessionModeId: "default",
    permissionMode: "ask",
  };
  const cases = [
    [{ modelId: "demo/model-2" }, "模型"],
    [{ reasoningEffort: "high" }, "思考强度"],
    [{ sessionModeId: "plan" }, "会话模式"],
    [{ permissionMode: "auto" }, "权限模式"],
  ];
  for (const [partial, field] of cases) {
    assert.throws(
      () =>
        validateTurnConfigSnapshot(
          {
            permissionMode: "ask",
            configRevision: 3,
            ...partial,
          },
          authoritative,
        ),
      (error) =>
        error?.agentError?.code === "pi.config_snapshot_mismatch" &&
        error.message.includes(field),
    );
  }
});

test("rejects stale steer targets and non-streaming runs", () => {
  assert.doesNotThrow(() =>
    assertActivePiRun({
      expectedRunId: "run-2",
      activeRunId: "run-2",
      runFinished: false,
      isStreaming: true,
    }),
  );
  assert.throws(
    () =>
      assertActivePiRun({
        expectedRunId: "run-1",
        activeRunId: "run-2",
        runFinished: false,
        isStreaming: true,
      }),
    (error) => error?.agentError?.code === "pi.run_mismatch",
  );
  assert.throws(
    () =>
      assertActivePiRun({
        expectedRunId: "run-2",
        activeRunId: "run-2",
        runFinished: true,
        isStreaming: false,
      }),
    (error) => error?.agentError?.code === "pi.run_not_active",
  );
  assert.throws(
    () =>
      assertActivePiRun({
        expectedRunId: "run-2",
        activeRunId: "run-2",
        runFinished: false,
        isStreaming: false,
      }),
    (error) => error?.agentError?.code === "pi.run_not_streaming",
  );
});

test("cancellation validates optional run and prompt identities", () => {
  assert.doesNotThrow(() =>
    assertPiCancelTarget({
      expectedRunId: "run-2",
      expectedPromptId: "prompt-2",
      activeRunId: "run-2",
      activePromptId: "prompt-2",
    }),
  );
  assert.throws(
    () =>
      assertPiCancelTarget({
        expectedRunId: "run-1",
        activeRunId: "run-2",
      }),
    (error) => error?.agentError?.code === "pi.run_mismatch",
  );
  assert.throws(
    () =>
      assertPiCancelTarget({
        expectedPromptId: "prompt-1",
        activePromptId: "prompt-2",
      }),
    (error) => error?.agentError?.code === "pi.prompt_mismatch",
  );
});

test("validates the complete session configuration before mutating Pi", async () => {
  const events = [];
  const adapter = new PiSessionAdapter(async (event) => {
    events.push(event);
  });
  let setModelCalls = 0;
  const model = { provider: "demo", id: "model-1", name: "Model 1" };
  const handle = {
    session: {
      setModel: async () => {
        setModelCalls += 1;
      },
      setThinkingLevel: () => undefined,
    },
    nativeSessionId: "native-1",
    rootSessionId: "session-1",
    streamSessionId: "session-1",
    runFinished: true,
    nextMessage: 0,
    offsets: new Map(),
    activeMessageIds: new Map(),
    eventTail: Promise.resolve(),
    permissionMode: "ask",
    sessionModeId: "default",
    configRevision: 4,
    unsubscribe: () => undefined,
    idempotency: { clear: () => undefined },
  };

  // The adapter's private fields are intentionally ordinary properties (not
  // JS private slots), which lets this test exercise the transaction boundary
  // with a small fake Pi session instead of opening a provider connection.
  adapter.sessions.set("session-1", handle);
  adapter.modelCatalog.getModelRuntime = async () => ({
    getModels: () => [model],
  });

  await assert.rejects(
    adapter.configure(
      {
        type: "session.configure",
        sessionId: "session-1",
        modelId: "model-1",
        reasoningEffort: "not-a-thinking-level",
        expectedRevision: 4,
      },
      "request-1",
    ),
    /不支持思考强度/u,
  );
  assert.equal(setModelCalls, 0);
  assert.equal(handle.permissionMode, "ask");
  assert.equal(handle.sessionModeId, "default");
  assert.equal(handle.configRevision, 4);
  assert.equal(events.length, 0);

  await assert.rejects(
    adapter.configure(
      {
        type: "session.configure",
        sessionId: "session-1",
        sessionModeId: "not-a-mode",
        expectedRevision: 4,
      },
      "request-2",
    ),
    /不支持会话模式/u,
  );
  assert.equal(handle.sessionModeId, "default");
  assert.equal(handle.configRevision, 4);
  assert.equal(events.length, 0);
});

test("serializes lifecycle operations for one product session", async () => {
  const adapter = new PiSessionAdapter(async () => undefined);
  let active = 0;
  let maximumActive = 0;
  const order = [];
  // Avoid opening a real provider connection; the public open() method still
  // exercises the per-product-session queue around this internal operation.
  adapter.openInternal = async (_command, requestId) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push(requestId);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    active -= 1;
  };
  const command = {
    type: "session.open",
    sessionId: "product-session-1",
    productSessionId: "product-session-1",
    cwd: "/tmp/melody-project",
    permissionMode: "ask",
  };

  await Promise.all([
    adapter.open(command, "open-1"),
    adapter.open(command, "open-2"),
  ]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ["open-1", "open-2"]);
});

test("closeAll reaps orphaned child tasks", async () => {
  const adapter = new PiSessionAdapter(async () => undefined);
  let cancelled = false;
  let settled = false;
  const task = {
    status: "running",
    cancel: async () => {
      cancelled = true;
      task.status = "cancelled";
    },
    promise: Promise.resolve().then(() => {
      settled = true;
      return { output: "" };
    }),
  };
  adapter.subagents.tasks.set("orphan-task", task);

  await adapter.closeAll();

  assert.equal(cancelled, true);
  assert.equal(settled, true);
  assert.equal(adapter.subagents.tasks.size, 0);
});

test("does not acknowledge a steer that becomes stale while Pi is awaiting it", async () => {
  const events = [];
  let release;
  const started = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = new PiSessionAdapter(async (event) => {
    events.push(event);
  });
  const handle = {
    session: {
      isStreaming: true,
      steer: async () => {
        await started;
      },
    },
    nativeSessionId: "native-1",
    rootSessionId: "session-1",
    streamSessionId: "session-1",
    runId: "run-1",
    promptId: "prompt-1",
    runFinished: false,
    nextMessage: 0,
    offsets: new Map(),
    activeMessageIds: new Map(),
    eventTail: Promise.resolve(),
    permissionMode: "ask",
    sessionModeId: "default",
    reasoningEffort: "medium",
    configRevision: 0,
    unsubscribe: () => undefined,
    idempotency: { clear: () => undefined },
  };
  adapter.sessions.set("session-1", handle);

  const pending = adapter.steer(
    {
      type: "turn.steer",
      sessionId: "session-1",
      runId: "run-1",
      content: "stale",
    },
    "request-1",
  );
  await Promise.resolve();
  // A cancellation or replacement may win while the SDK call is pending.
  handle.runFinished = true;
  release();
  await pending;

  assert.deepEqual(events, []);
});

test("waits for cancellation to finish before admitting a replacement prompt", async () => {
  const events = [];
  let releaseAbort;
  const abortFinished = new Promise((resolve) => {
    releaseAbort = resolve;
  });
  let promptStarted = false;
  const adapter = new PiSessionAdapter(async (event) => {
    events.push(event);
  });
  const handle = {
    session: {
      isStreaming: true,
      clearQueue: () => undefined,
      abort: async () => abortFinished,
      prompt: async () => {
        promptStarted = true;
      },
    },
    nativeSessionId: "native-1",
    rootSessionId: "session-1",
    streamSessionId: "session-1",
    runId: "session-1:old",
    promptId: "old",
    runFinished: false,
    nextMessage: 0,
    offsets: new Map(),
    activeMessageIds: new Map(),
    eventTail: Promise.resolve(),
    permissionMode: "ask",
    sessionModeId: "default",
    modelId: "demo/model-1",
    reasoningEffort: "medium",
    configRevision: 0,
    unsubscribe: () => undefined,
    idempotency: { clear: () => undefined },
  };
  adapter.sessions.set("session-1", handle);

  const cancelled = adapter.cancel(
    {
      type: "turn.cancel",
      sessionId: "session-1",
      promptId: "old",
      runId: "session-1:old",
      cancelSubagents: false,
      reason: "user",
    },
    "cancel-1",
  );
  await Promise.resolve();
  const submitted = adapter.submit(
    {
      type: "turn.submit",
      sessionId: "session-1",
      promptId: "new",
      content: "new prompt",
      attachments: [],
      config: {
        modelId: "demo/model-1",
        reasoningEffort: "medium",
        sessionModeId: "default",
        permissionMode: "ask",
        configRevision: 0,
      },
    },
    "submit-1",
  );
  await Promise.resolve();
  assert.equal(promptStarted, false);

  releaseAbort();
  await cancelled;
  await submitted;
  assert.equal(promptStarted, true);
  assert.deepEqual(
    events.map((event) => event.event.type),
    ["run.finished", "run.accepted", "run.finished"],
  );
  assert.equal(events[0].runId, "session-1:old");
  assert.equal(events[1].runId, "session-1:new");
});

test("coalesces concurrent cancellation requests for one run", async () => {
  const events = [];
  let releaseAbort;
  const abortFinished = new Promise((resolve) => {
    releaseAbort = resolve;
  });
  let abortCalls = 0;
  const adapter = new PiSessionAdapter(async (event) => {
    events.push(event);
  });
  const handle = {
    session: {
      isStreaming: true,
      clearQueue: () => undefined,
      abort: async () => {
        abortCalls += 1;
        await abortFinished;
      },
    },
    nativeSessionId: "native-1",
    rootSessionId: "session-1",
    streamSessionId: "session-1",
    runId: "session-1:run",
    promptId: "prompt-1",
    runFinished: false,
    nextMessage: 0,
    offsets: new Map(),
    activeMessageIds: new Map(),
    eventTail: Promise.resolve(),
    permissionMode: "ask",
    sessionModeId: "default",
    reasoningEffort: "medium",
    configRevision: 0,
    unsubscribe: () => undefined,
    idempotency: { clear: () => undefined },
  };
  adapter.sessions.set("session-1", handle);
  const command = {
    type: "turn.cancel",
    sessionId: "session-1",
    promptId: "prompt-1",
    runId: "session-1:run",
    cancelSubagents: false,
    reason: "user",
  };

  const first = adapter.cancel(command, "cancel-1");
  await Promise.resolve();
  const second = adapter.cancel(command, "cancel-2");
  await Promise.resolve();
  assert.equal(abortCalls, 1);

  releaseAbort();
  await Promise.all([first, second]);
  assert.equal(abortCalls, 1);
  assert.deepEqual(
    events.map((event) => [event.event.type, event.requestId]),
    [["run.finished", "cancel-1"]],
  );
});

test("background task controls enforce session ownership and wait semantics", async () => {
  const adapter = new PiSessionAdapter(async () => undefined);
  const rootHandle = {
    rootSessionId: "session-1",
    streamSessionId: "session-1",
    runFinished: true,
  };
  adapter.sessions.set("session-1", rootHandle);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const task = {
    taskId: "session-1:task:one",
    parentSessionId: "session-1",
    childSessionId: "session-1:task:one:session",
    rootSessionId: "session-1",
    parentTaskId: undefined,
    status: "running",
    output: "partial",
    promise: pending.then(() => ({ output: "finished" })),
    cancel: async () => {
      task.status = "cancelled";
      task.output = "cancelled";
      release();
    },
  };
  adapter.subagents.tasks.set(task.taskId, task);

  const immediate = await adapter.subagents.taskController.wait({
    taskIds: [task.taskId],
    mode: "wait_any",
    timeoutMs: 0,
    parentSessionId: "session-1",
  });
  assert.equal(immediate[0].status, "running");
  assert.equal(immediate[0].output, "partial");

  const waiting = adapter.subagents.taskController.wait({
    taskIds: [task.taskId],
    mode: "wait_all",
    timeoutMs: 500,
    parentSessionId: "session-1",
  });
  globalThis.setTimeout(release, 10);
  const completed = await waiting;
  assert.equal(completed[0].status, "running");
  // The real task promise's completion handler updates status; this fixture
  // deliberately proves that the controller returns the current registry
  // snapshot without manufacturing a terminal state.
  assert.equal(completed[0].output, "partial");

  await adapter.subagents.taskController.cancel({
    taskId: task.taskId,
    parentSessionId: "session-1",
  });
  assert.equal(task.status, "cancelled");

  await assert.rejects(
    adapter.subagents.taskController.wait({
      taskIds: [task.taskId],
      mode: "wait_any",
      timeoutMs: 0,
      parentSessionId: "different-session",
    }),
    /当前会话访问/u,
  );
});

test("hides Skills under a Host ignore prefix across refreshes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-skill-ignore-"));
  const project = join(directory, "project");
  const skillRoot = join(project, ".agents", "skills");
  const keep = join(skillRoot, "keep");
  const hidden = join(skillRoot, "hidden");
  const previousHome = process.env.MELODY_HOME;
  const previousSkillRoots = process.env.MELODY_PI_SKILL_ROOTS_JSON;
  const previousSkillPaths = process.env.MELODY_PI_SKILL_PATHS_JSON;
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(keep, { recursive: true });
  await mkdir(hidden, { recursive: true });
  await writeFile(join(keep, "SKILL.md"), "keep");
  await writeFile(join(hidden, "SKILL.md"), "hidden");
  process.env.MELODY_HOME = join(directory, "melody");
  process.env.MELODY_PI_SKILL_PATHS_JSON = "[]";
  process.env.MELODY_PI_SKILL_ROOTS_JSON = JSON.stringify([
    { path: skillRoot, disabled: [], ignorePaths: [await realpath(hidden)] },
  ]);
  try {
    assert.deepEqual(piSkillPathsFor(project), [await realpath(keep)]);

    // A Skill created inside the ignored prefix stays hidden on the next
    // refresh, which is why the prefixes travel with the root manifest.
    await mkdir(join(hidden, "later"), { recursive: true });
    await writeFile(join(hidden, "later", "SKILL.md"), "later");
    assert.deepEqual(piSkillPathsFor(project), [await realpath(keep)]);

    // A relative or non-absolute prefix is dropped rather than resolved
    // against the worker cwd, so it cannot hide unrelated Skills.
    process.env.MELODY_PI_SKILL_ROOTS_JSON = JSON.stringify([
      { path: skillRoot, disabled: [], ignorePaths: ["hidden"] },
    ]);
    assert.deepEqual(piSkillPathsFor(project), [
      await realpath(hidden),
      await realpath(keep),
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.MELODY_HOME;
    else process.env.MELODY_HOME = previousHome;
    if (previousSkillRoots === undefined)
      delete process.env.MELODY_PI_SKILL_ROOTS_JSON;
    else process.env.MELODY_PI_SKILL_ROOTS_JSON = previousSkillRoots;
    if (previousSkillPaths === undefined)
      delete process.env.MELODY_PI_SKILL_PATHS_JSON;
    else process.env.MELODY_PI_SKILL_PATHS_JSON = previousSkillPaths;
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusts a declared plugin Skill directory below a plugin root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "melody-pi-plugin-skill-"));
  const project = join(directory, "project");
  const melodyHome = join(directory, "melody");
  const declared = join(
    melodyHome,
    "installed-plugins",
    "plugin-tools",
    "skills",
    "group",
    "first",
  );
  const previousHome = process.env.MELODY_HOME;
  const previousSkillRoots = process.env.MELODY_PI_SKILL_ROOTS_JSON;
  const previousSkillPaths = process.env.MELODY_PI_SKILL_PATHS_JSON;
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(declared, { recursive: true });
  await writeFile(join(declared, "SKILL.md"), "declared skill");
  process.env.MELODY_HOME = melodyHome;
  process.env.MELODY_PI_SKILL_PATHS_JSON = "[]";
  process.env.MELODY_PI_SKILL_ROOTS_JSON = JSON.stringify([
    { path: declared, disabled: [], ignorePaths: [] },
  ]);
  try {
    assert.deepEqual(piSkillPathsFor(project), [await realpath(declared)]);
  } finally {
    if (previousHome === undefined) delete process.env.MELODY_HOME;
    else process.env.MELODY_HOME = previousHome;
    if (previousSkillRoots === undefined)
      delete process.env.MELODY_PI_SKILL_ROOTS_JSON;
    else process.env.MELODY_PI_SKILL_ROOTS_JSON = previousSkillRoots;
    if (previousSkillPaths === undefined)
      delete process.env.MELODY_PI_SKILL_PATHS_JSON;
    else process.env.MELODY_PI_SKILL_PATHS_JSON = previousSkillPaths;
    await rm(directory, { recursive: true, force: true });
  }
});

test("finishes a Pi run as failed when its settled assistant response errored", async () => {
  const events = [];
  const adapter = new PiSessionAdapter(async (event) => {
    events.push(event);
  });
  const handle = {
    session: { sessionManager: { getLeafEntry: () => undefined } },
    nativeSessionId: "native-1",
    rootSessionId: "session-1",
    streamSessionId: "session-1",
    runId: "session-1:prompt-1",
    promptId: "prompt-1",
    runFinished: false,
    nextMessage: 0,
    offsets: new Map(),
    activeMessageIds: new Map(),
    eventTail: Promise.resolve(),
    permissionMode: "ask",
    sessionModeId: "default",
    reasoningEffort: "medium",
    configRevision: 0,
  };
  adapter.sessions.set("session-1", handle);
  const providerMessage =
    '429: {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"RateLimitExceeded.EndpointTPMExceeded"}';
  const providerMessageWithSecret = `${providerMessage} Authorization: Bearer sk-test-secret-token api_key=sk-another-test-secret`;

  await adapter.sessionEvents.handle("session-1", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: providerMessageWithSecret,
      provider: "melody-deepseek",
      api: "openai-completions",
      model: "deepseek-flash",
      usage: { input: 0, output: 0, totalTokens: 0 },
    },
  });
  await adapter.sessionEvents.handle("session-1", { type: "agent_settled" });

  const terminal = events.at(-1);
  assert.equal(terminal.event.type, "run.finished");
  assert.equal(terminal.event.status, "failed");
  assert.equal(terminal.event.stopReason, "rate_limit");
  assert.equal(terminal.event.error.code, "pi.provider_rate_limited");
  assert.equal(
    terminal.event.error.details.providerMessage,
    `${providerMessage} Authorization: Bearer [redacted] api_key=[redacted]`,
  );
  assert.doesNotMatch(
    terminal.event.error.details.providerMessage,
    /sk-test-secret-token|sk-another-test-secret/,
  );
  assert.equal(terminal.event.error.details.provider, "melody-deepseek");
  assert.equal(handle.runFinished, true);
});

test("a successful Pi response clears an earlier transient assistant error", async () => {
  const events = [];
  const adapter = new PiSessionAdapter(async (event) => {
    events.push(event);
  });
  const handle = {
    session: { sessionManager: { getLeafEntry: () => undefined } },
    nativeSessionId: "native-1",
    rootSessionId: "session-1",
    streamSessionId: "session-1",
    runId: "session-1:prompt-1",
    promptId: "prompt-1",
    runFinished: false,
    nextMessage: 0,
    offsets: new Map(),
    activeMessageIds: new Map(),
    eventTail: Promise.resolve(),
    permissionMode: "ask",
    sessionModeId: "default",
    reasoningEffort: "medium",
    configRevision: 0,
  };
  adapter.sessions.set("session-1", handle);

  await adapter.sessionEvents.handle("session-1", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "temporary provider failure",
    },
  });
  await adapter.sessionEvents.handle("session-1", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Recovered" }],
    },
  });
  await adapter.sessionEvents.handle("session-1", { type: "agent_settled" });

  const terminal = events.at(-1);
  assert.equal(terminal.event.type, "run.finished");
  assert.equal(terminal.event.status, "completed");
  assert.equal(terminal.event.error, undefined);
});
