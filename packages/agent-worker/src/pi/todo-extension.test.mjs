import test from "node:test";
import assert from "node:assert/strict";

import {
  TODO_STATE_ENTRY,
  applyTodoWriteState,
  createTodoExtension,
  reconstructTodoState,
  summarizeTodoState,
} from "./todo-extension.ts";

test("todo_write merges partial updates without losing existing content", () => {
  const initial = applyTodoWriteState([], {
    merge: true,
    todos: [
      { id: "design", content: "Design the migration", status: "in_progress" },
    ],
  });

  const next = applyTodoWriteState(initial, {
    todos: [{ id: "design", status: "completed" }],
  });

  assert.deepEqual(next, [
    { id: "design", content: "Design the migration", status: "completed" },
  ]);
});

test("todo_write replaces the complete list and applies legacy defaults", () => {
  const next = applyTodoWriteState(
    [{ id: "old", content: "Remove me", status: "pending" }],
    {
      merge: false,
      todos: [
        { id: "new" },
        { id: "done", content: "Ship", status: "completed" },
      ],
    },
  );

  assert.deepEqual(next, [
    { id: "new", content: "new", status: "pending" },
    { id: "done", content: "Ship", status: "completed" },
  ]);
});

test("todo_write rejects duplicate ids before changing state", () => {
  assert.throws(
    () =>
      applyTodoWriteState([], {
        todos: [
          { id: "same", content: "one" },
          { id: "same", content: "two" },
        ],
      }),
    /Duplicate todo id: same/,
  );
});

test("todo state follows the active Pi branch and ignores unrelated entries", () => {
  const state = reconstructTodoState([
    {
      type: "custom",
      customType: TODO_STATE_ENTRY,
      data: { todos: [{ id: "a", content: "A", status: "pending" }] },
    },
    { type: "custom", customType: "other", data: { todos: [{ id: "wrong" }] } },
    {
      type: "custom",
      customType: TODO_STATE_ENTRY,
      data: { todos: [{ id: "b", content: "B", status: "completed" }] },
    },
  ]);

  assert.deepEqual(state, [{ id: "b", content: "B", status: "completed" }]);
  assert.equal(summarizeTodoState(state), "- [completed] b: B");
});

test("inline extension registers todo_write, persists state, and restores it on session start", async () => {
  const handlers = new Map();
  const appended = [];
  let registeredTool;
  const extension = createTodoExtension(() => "default");

  extension.factory({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool(tool) {
      registeredTool = tool;
    },
    appendEntry(customType, data) {
      appended.push({ customType, data });
    },
  });

  assert.equal(registeredTool.name, "todo_write");
  await handlers.get("session_start")?.(
    {},
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: TODO_STATE_ENTRY,
            data: {
              todos: [
                { id: "existing", content: "Existing", status: "pending" },
              ],
            },
          },
        ],
      },
    },
  );

  const result = await registeredTool.execute("call-1", {
    todos: [{ id: "existing", status: "completed" }, { id: "new" }],
  });

  assert.deepEqual(appended, [
    {
      customType: TODO_STATE_ENTRY,
      data: {
        todos: [
          { id: "existing", content: "Existing", status: "completed" },
          { id: "new", content: "new", status: "pending" },
        ],
      },
    },
  ]);
  assert.equal(
    result.content[0].text,
    "- [completed] existing: Existing\n- [pending] new: new",
  );
  assert.deepEqual(result.details.todos, appended[0].data.todos);
});

test("inline extension refuses todo_write in ask mode", async () => {
  let registeredTool;
  createTodoExtension(() => "ask").factory({
    on() {},
    registerTool(tool) {
      registeredTool = tool;
    },
    appendEntry() {
      throw new Error("must not persist in ask mode");
    },
  });

  await assert.rejects(
    registeredTool.execute("call-ask", { todos: [{ id: "blocked" }] }),
    /todo_write is unavailable in ask mode/,
  );
});
