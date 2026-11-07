import assert from "node:assert/strict";
import test from "node:test";

import {
  pendingInteractionKind,
  pendingInteractions,
  pendingInteractionsBySession,
  pendingNotificationCandidates,
  productSessionIdForRuntimeKey,
} from "./pending-interaction.ts";

const toolEntry = (overrides = {}) => ({
  id: "tool-1",
  kind: "tool",
  title: "Run tests",
  command: "pnpm test:unit",
  output: "",
  ...overrides,
});

const question = (overrides = {}) => ({
  requestId: 7,
  sessionId: "session-1",
  toolCallId: "tool-1",
  questions: [{ question: "继续吗？", options: [] }],
  mode: "default",
  outcome: "pending",
  ...overrides,
});

const planEntry = (overrides = {}) => ({
  id: "plan-1",
  kind: "plan",
  toolCallId: "tool-2",
  content: "计划",
  status: "awaiting-approval",
  requestId: 9,
  ...overrides,
});

test("derives a pending tool permission", () => {
  const timeline = [
    toolEntry({ permission: "pending", permissionRequestId: 41 }),
  ];

  assert.deepEqual(pendingInteractions(timeline), [
    { key: "permission:41", kind: "permission" },
  ]);
  assert.equal(pendingInteractionKind(timeline), "permission");
});

test("derives a plan awaiting approval", () => {
  const timeline = [planEntry()];

  assert.deepEqual(pendingInteractions(timeline), [
    { key: "plan:9", kind: "plan" },
  ]);
  assert.equal(pendingInteractionKind(timeline), "plan");
});

test("derives a pending question with a stable request key", () => {
  const timeline = [toolEntry({ question: question() })];

  assert.deepEqual(pendingInteractions(timeline), [
    { key: "question:session-1:7", kind: "question" },
  ]);
  assert.equal(pendingInteractionKind(timeline), "question");
});

test("returns nothing for an empty timeline", () => {
  assert.deepEqual(pendingInteractions([]), []);
  assert.equal(pendingInteractionKind([]), undefined);
});

test("permission outranks a pending question", () => {
  const timeline = [
    toolEntry({ question: question() }),
    toolEntry({
      id: "tool-2",
      permission: "pending",
      permissionRequestId: 41,
    }),
  ];

  assert.equal(pendingInteractionKind(timeline), "permission");
  assert.deepEqual(
    pendingInteractions(timeline).map(({ kind }) => kind),
    ["question", "permission"],
  );
});

test("plan outranks a pending question", () => {
  const timeline = [toolEntry({ question: question() }), planEntry()];

  assert.equal(pendingInteractionKind(timeline), "plan");
});

test("permission outranks a plan awaiting approval", () => {
  const timeline = [
    planEntry(),
    toolEntry({ permission: "pending", permissionRequestId: 41 }),
  ];

  assert.equal(pendingInteractionKind(timeline), "permission");
});

test("a resolved question is not pending", () => {
  const timeline = [
    toolEntry({ question: question({ outcome: "accepted" }) }),
    toolEntry({
      id: "tool-2",
      question: question({ requestId: 8, outcome: "cancelled" }),
    }),
  ];

  assert.deepEqual(pendingInteractions(timeline), []);
  assert.equal(pendingInteractionKind(timeline), undefined);
});

test("a plan that is not awaiting approval is not pending", () => {
  for (const status of [
    "streaming",
    "approved",
    "changes-requested",
    "abandoned",
    "superseded",
  ]) {
    assert.deepEqual(pendingInteractions([planEntry({ status })]), []);
  }
  assert.deepEqual(
    pendingInteractions([planEntry({ requestId: undefined })]),
    [],
  );
});

test("allows and denied permissions are not pending", () => {
  for (const permission of ["allowed", "denied", undefined]) {
    assert.deepEqual(
      pendingInteractions([toolEntry({ permission, permissionRequestId: 41 })]),
      [],
    );
  }
  assert.deepEqual(
    pendingInteractions([toolEntry({ permission: "pending" })]),
    [],
  );
});

test("keys stay stable across calls and duplicate entries collapse", () => {
  const timeline = [
    toolEntry({ permission: "pending", permissionRequestId: 41 }),
    toolEntry({
      id: "tool-1-duplicate",
      permission: "pending",
      permissionRequestId: 41,
    }),
  ];

  const first = pendingInteractions(timeline);
  const second = pendingInteractions(timeline);

  assert.deepEqual(first, [{ key: "permission:41", kind: "permission" }]);
  assert.deepEqual(second, first);
});

test("does not mutate the input timeline", () => {
  const timeline = Object.freeze([
    Object.freeze(toolEntry({ question: Object.freeze(question()) })),
    Object.freeze(planEntry()),
  ]);

  pendingInteractions(timeline);
  pendingInteractionKind(timeline);

  assert.equal(timeline.length, 2);
  assert.equal(timeline[1].status, "awaiting-approval");
});

test("maps Pi product keys and legacy ACP keys to product sessions", () => {
  const sessions = [
    { id: "product-pi" },
    { id: "product-legacy", acpSessionId: "acp-native" },
  ];

  assert.equal(
    productSessionIdForRuntimeKey("product-pi", sessions),
    "product-pi",
  );
  assert.equal(
    productSessionIdForRuntimeKey("acp-native", sessions),
    "product-legacy",
  );
  assert.equal(
    productSessionIdForRuntimeKey("subagent-child", sessions),
    undefined,
  );
});

test("derives waiting kinds per product session", () => {
  const sessions = [
    { id: "active", acpSessionId: "acp-active" },
    { id: "background-pi" },
    { id: "background-legacy", acpSessionId: "acp-legacy" },
  ];

  const kinds = pendingInteractionsBySession({
    localSessionId: "active",
    timeline: [toolEntry({ permission: "pending", permissionRequestId: 41 })],
    backgroundTimelines: {
      "background-pi": [toolEntry({ question: question() })],
      "acp-legacy": [planEntry()],
      // A nested task stream has no product session: it must not be invented.
      "subagent-child": [planEntry({ requestId: 77 })],
      // The active session also appears under its ACP key and loses.
      "acp-active": [toolEntry({ question: question({ requestId: 99 }) })],
    },
    sessions,
  });

  assert.deepEqual(kinds, {
    active: "permission",
    "background-pi": "question",
    "background-legacy": "plan",
  });
});

test("a background timeline that cannot be mapped is dropped", () => {
  assert.deepEqual(
    pendingInteractionsBySession({
      timeline: [],
      backgroundTimelines: {
        "unknown-runtime": [planEntry()],
      },
      sessions: [{ id: "product" }],
    }),
    {},
  );
});

test("background timelines for one product session merge by precedence", () => {
  const sessions = [{ id: "product", acpSessionId: "acp-product" }];

  assert.deepEqual(
    pendingInteractionsBySession({
      timeline: [],
      backgroundTimelines: {
        product: [toolEntry({ question: question() })],
        "acp-product": [planEntry()],
      },
      sessions,
    }),
    { product: "plan" },
  );
});

test("collects an approval blocked in a background timeline", () => {
  const candidates = pendingNotificationCandidates({
    timeline: [],
    backgroundTimelines: {
      "background-session": [
        toolEntry({ permission: "pending", permissionRequestId: 41 }),
      ],
    },
    target: "approval",
  });

  assert.deepEqual(candidates, [
    {
      key: "permission:41",
      kind: "permission",
      runtimeSessionId: "background-session",
    },
  ]);
});

test("approval candidates cover plan gates but exclude questions", () => {
  const backgroundTimelines = {
    background: [
      planEntry(),
      toolEntry({ id: "tool-2", question: question() }),
    ],
  };

  assert.deepEqual(
    pendingNotificationCandidates({
      timeline: [],
      backgroundTimelines,
      target: "approval",
    }).map(({ kind }) => kind),
    ["plan"],
  );
  assert.deepEqual(
    pendingNotificationCandidates({
      timeline: [],
      backgroundTimelines,
      target: "question",
    }).map(({ kind }) => kind),
    ["question"],
  );
});

test("a duplicate interaction in the visible timeline wins once", () => {
  const entry = toolEntry({ permission: "pending", permissionRequestId: 41 });

  const candidates = pendingNotificationCandidates({
    timeline: [entry],
    backgroundTimelines: {
      "background-session": [entry],
    },
    target: "approval",
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].runtimeSessionId, undefined);
});

test("a background approval without a product session is still reported", () => {
  const candidates = pendingNotificationCandidates({
    timeline: [],
    backgroundTimelines: {
      "subagent-child": [planEntry()],
    },
    target: "approval",
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].runtimeSessionId, "subagent-child");
});
