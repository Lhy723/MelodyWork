import assert from "node:assert/strict";
import test from "node:test";

import { TaskLauncher } from "./task-launch.ts";

const project = { id: "project-1", name: "Project", path: "/workspace" };
const session = {
  id: "session-1",
  projectId: project.id,
  title: "New session",
  cwd: project.path,
  timelineJson: "[]",
  timelineVersion: 0,
  createdAt: 1,
  updatedAt: 1,
};

test("waits until the workspace and Agent Session agree", async () => {
  const launcher = new TaskLauncher();
  const submitted = [];
  launcher.queue(session.id, { content: "first prompt" });

  assert.equal(
    await launcher.deliverIfReady(
      {
        activeSessionId: session.id,
        agentSessionId: "another-session",
        ready: true,
      },
      async (content) => submitted.push(content),
    ),
    false,
  );
  assert.equal(submitted.length, 0);

  assert.equal(
    await launcher.deliverIfReady(
      {
        activeSessionId: session.id,
        agentSessionId: session.id,
        ready: true,
      },
      async (content) => submitted.push(content),
    ),
    true,
  );
  assert.deepEqual(submitted, ["first prompt"]);
});

test("delivers a queued prompt at most once", async () => {
  const launcher = new TaskLauncher();
  let submissions = 0;
  launcher.queue(session.id, { content: "once" });
  const readiness = {
    activeSessionId: session.id,
    agentSessionId: session.id,
    ready: true,
  };

  await Promise.all([
    launcher.deliverIfReady(readiness, async () => {
      submissions += 1;
    }),
    launcher.deliverIfReady(readiness, async () => {
      submissions += 1;
    }),
  ]);

  assert.equal(submissions, 1);
});

test("queues against the session returned by creation", async () => {
  const launcher = new TaskLauncher();
  const submitted = [];
  const created = await launcher.createAndQueue(
    project,
    { content: "created prompt", attachments: [] },
    async () => session,
  );

  assert.equal(created, session);
  await launcher.deliverIfReady(
    {
      activeSessionId: session.id,
      agentSessionId: session.id,
      ready: true,
    },
    async (content, attachments) => submitted.push({ content, attachments }),
  );
  assert.deepEqual(submitted, [{ content: "created prompt", attachments: [] }]);
});
