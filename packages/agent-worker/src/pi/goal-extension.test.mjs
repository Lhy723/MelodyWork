import assert from "node:assert/strict";
import test from "node:test";

import {
  GOAL_STATE_ENTRY,
  PI_UPDATE_GOAL,
  reconstructGoalState,
  startGoalState,
  summarizeGoalState,
  transitionGoalState,
  parseGoalObjective,
  enforceGoalGuards,
  createGoalExtension,
} from "./goal-extension.ts";

test("goal state starts with a bounded active objective", () => {
  assert.deepEqual(startGoalState(" Ship the Pi migration "), {
    status: "active",
    objective: "Ship the Pi migration",
    blockedAttempts: 0,
    completionAttempts: 0,
    revision: 1,
  });
  assert.throws(() => startGoalState("   "), /objective is required/u);
});

test("goal command consumes only a trailing standalone token budget", () => {
  assert.deepEqual(parseGoalObjective("Ship it --budget 5000"), {
    objective: "Ship it",
    tokenBudget: 5000,
  });
  assert.deepEqual(parseGoalObjective("mention --budget 5000 in the docs"), {
    objective: "mention --budget 5000 in the docs",
  });
  assert.deepEqual(parseGoalObjective("Ship it --budget nope"), {
    objective: "Ship it --budget nope",
  });
});

test("goal guard stops at a measured cumulative token budget", () => {
  const initial = startGoalState("Bound the run", { tokenBudget: 100 }, 1_000);
  const result = enforceGoalGuards(initial, {
    totalTokens: 1_101,
    turnRevisionAtStart: initial.revision,
    now: 2_000,
  });
  assert.equal(result.reason, "token_budget");
  assert.equal(result.shouldAbort, true);
  assert.equal(result.state.status, "paused");
  assert.equal(result.state.tokensUsed, 101);
  assert.match(result.summary, /101 of 100/u);
});

test("goal guard pauses a stalled run only after its wall-clock window", () => {
  const initial = startGoalState(
    "Detect a stall",
    { stallDetection: true, stallTimeoutSecs: 10 },
    0,
    0,
  );
  const before = enforceGoalGuards(initial, {
    turnRevisionAtStart: initial.revision,
    now: 9_999,
  });
  assert.equal(before.state.status, "active");
  const stalled = enforceGoalGuards(before.state, {
    turnRevisionAtStart: before.state.revision,
    now: 10_000,
  });
  assert.equal(stalled.reason, "stall");
  assert.equal(stalled.shouldAbort, true);
  assert.equal(stalled.state.status, "paused");
  assert.match(stalled.summary, /no progress/u);
});

test("stall-only goal does not synthesize token accounting", () => {
  const initial = startGoalState(
    "Keep the session moving",
    { stallDetection: true, stallTimeoutSecs: 60 },
    42_000,
    0,
  );
  const result = enforceGoalGuards(initial, {
    totalTokens: 42_100,
    turnRevisionAtStart: initial.revision,
    now: 1_000,
  });
  assert.equal(result.state.tokenBaseline, undefined);
  assert.equal(result.state.tokensUsed, undefined);
  assert.equal(result.state.status, "active");
});

test("update_goal records progress and completes an active goal", () => {
  const initial = startGoalState("Ship the migration");
  const progress = transitionGoalState(initial, { message: "Worker is ready" });
  assert.equal(progress.state.status, "active");
  assert.equal(progress.state.message, "Worker is ready");
  assert.equal(progress.state.revision, 2);

  const completed = transitionGoalState(progress.state, {
    completed: true,
    message: "All parity tests pass",
  });
  assert.equal(completed.state.status, "completed");
  assert.equal(completed.state.completionAttempts, 1);
  assert.match(completed.summary, /All parity tests pass/u);
});

test("three consecutive blocked reports pause a goal", () => {
  let state = startGoalState("Investigate outage");
  for (const attempt of [1, 2]) {
    const result = transitionGoalState(state, {
      blocked_reason: `blocked ${attempt}`,
    });
    state = result.state;
    assert.equal(state.status, "active");
    assert.match(result.summary, new RegExp(`Blocked attempt ${attempt}/3`));
  }
  const final = transitionGoalState(state, { blocked_reason: "blocked 3" });
  assert.equal(final.state.status, "blocked");
  assert.equal(final.state.blockedAttempts, 3);
  assert.match(final.summary, /paused as blocked/u);
});

test("update_goal rejects conflicting or non-active updates", () => {
  const state = startGoalState("Ship it");
  assert.throws(
    () =>
      transitionGoalState(state, {
        completed: true,
        blocked_reason: "not actually done",
      }),
    /cannot be used together/u,
  );
  const completed = transitionGoalState(state, { completed: true }).state;
  assert.throws(
    () => transitionGoalState(completed, { message: "late" }),
    /unavailable while the goal is completed/u,
  );
});

test("goal snapshots follow the active branch and honor clear entries", () => {
  const state = startGoalState("Persist this");
  const completed = transitionGoalState(state, { completed: true }).state;
  assert.deepEqual(
    reconstructGoalState([
      { type: "custom", customType: GOAL_STATE_ENTRY, data: state },
      { type: "custom", customType: GOAL_STATE_ENTRY, data: completed },
    ]),
    completed,
  );
  assert.equal(
    reconstructGoalState([
      { type: "custom", customType: GOAL_STATE_ENTRY, data: state },
      {
        type: "custom",
        customType: GOAL_STATE_ENTRY,
        data: {
          status: "cleared",
          objective: state.objective,
          blockedAttempts: 0,
          completionAttempts: 0,
          revision: 3,
        },
      },
    ]),
    undefined,
  );
  assert.match(summarizeGoalState(completed), /\[completed\]/u);
});

test("inline goal extension seeds state, registers update_goal, and persists updates", async () => {
  const handlers = new Map();
  const appended = [];
  let registeredTool;
  createGoalExtension(
    () => "default",
    () => "all",
    {
      initialObjective: () => "Ship Pi parity",
    },
  ).factory({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool(tool) {
      registeredTool = tool;
    },
    registerCommand() {},
    appendEntry(customType, data) {
      appended.push({ customType, data });
    },
  });

  assert.equal(registeredTool.name, PI_UPDATE_GOAL);
  await handlers.get("session_start")?.(
    {},
    { sessionManager: { getBranch: () => [] } },
  );
  const result = await registeredTool.execute("call-1", {
    message: "Tool is wired",
  });
  assert.equal(appended.length, 2);
  assert.equal(appended[0].customType, GOAL_STATE_ENTRY);
  assert.equal(appended[1].data.message, "Tool is wired");
  assert.match(result.content[0].text, /Tool is wired/u);
  assert.equal(result.details.status, "active");
});

test("inline goal extension refuses mutation in ask and read-only modes", async () => {
  for (const [mode, capability, expected] of [
    ["ask", "all", /ask mode/u],
    ["default", "read-only", /read-only mode/u],
  ]) {
    let registeredTool;
    createGoalExtension(
      () => mode,
      () => capability,
      {
        initialObjective: () => "Protected goal",
      },
    ).factory({
      on() {},
      registerTool(tool) {
        registeredTool = tool;
      },
      registerCommand() {},
      appendEntry() {},
    });
    await assert.rejects(
      registeredTool.execute("call", { message: "no mutation" }),
      expected,
    );
  }
});

test("update_goal outside goal mode fails closed instead of pretending success", async () => {
  let registeredTool;
  createGoalExtension().factory({
    on() {},
    registerTool(tool) {
      registeredTool = tool;
    },
    registerCommand() {},
    appendEntry() {
      throw new Error("should not persist");
    },
  });
  await assert.rejects(
    registeredTool.execute("call", { message: "not active" }),
    /outside an active goal/u,
  );
});
