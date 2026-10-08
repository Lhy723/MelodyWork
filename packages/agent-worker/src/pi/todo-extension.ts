import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** Pi custom-entry type used for the active Melody todo state. */
export const TODO_STATE_ENTRY = "melody.todo_state" as const;
export const PI_TODO_WRITE = "todo_write" as const;

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoUpdate {
  id: string;
  content?: string;
  status?: TodoStatus;
}

export interface TodoWriteInput {
  merge?: boolean;
  todos: TodoUpdate[];
}

export interface TodoStateEntryData {
  todos: TodoItem[];
}

export interface TodoWriteDetails {
  merge: boolean;
  todos: TodoItem[];
}

const todoWriteParameters = Type.Object({
  merge: Type.Optional(
    Type.Boolean({
      description:
        "When true (default), merge items by id. When false, replace the whole list.",
    }),
  ),
  todos: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 256 }),
      content: Type.Optional(Type.String({ maxLength: 4_000 })),
      status: Type.Optional(
        Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
          Type.Literal("cancelled"),
        ]),
      ),
    }),
    { maxItems: 100 },
  ),
});

type TodoWriteParams = Static<typeof todoWriteParameters>;

const isTodoStatus = (value: unknown): value is TodoStatus =>
  value === "pending" ||
  value === "in_progress" ||
  value === "completed" ||
  value === "cancelled";

const cloneTodo = (todo: TodoItem): TodoItem => ({ ...todo });

const contentForNewTodo = (update: TodoUpdate): string =>
  update.content && update.content.length > 0 ? update.content : update.id;

const statusForNewTodo = (update: TodoUpdate): TodoStatus =>
  update.status ?? "pending";

/**
 * Apply Melody-build's todo_write merge/replace semantics without mutating
 * the previous branch state. This is kept pure so the state contract can be
 * tested independently from Pi's extension runtime.
 */
export const applyTodoWriteState = (
  current: readonly TodoItem[],
  input: TodoWriteInput,
): TodoItem[] => {
  const seen = new Set<string>();
  for (const update of input.todos) {
    if (seen.has(update.id)) {
      throw new Error(`Duplicate todo id: ${update.id}`);
    }
    seen.add(update.id);
  }

  if (input.merge === false) {
    return input.todos.map((update) => ({
      id: update.id,
      content: contentForNewTodo(update),
      status: statusForNewTodo(update),
    }));
  }

  const next = current.map(cloneTodo);
  const indexById = new Map(next.map((todo, index) => [todo.id, index]));
  for (const update of input.todos) {
    const existingIndex = indexById.get(update.id);
    if (existingIndex !== undefined) {
      const existing = next[existingIndex];
      // An empty content value is intentionally ignored for existing items,
      // matching Melody-build's partial-update behavior.
      if (update.content) existing.content = update.content;
      if (update.status) existing.status = update.status;
      continue;
    }
    indexById.set(update.id, next.length);
    next.push({
      id: update.id,
      content: contentForNewTodo(update),
      status: statusForNewTodo(update),
    });
  }
  return next;
};

const persistedTodo = (value: unknown): TodoItem | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.content !== "string" ||
    !isTodoStatus(record.status)
  ) {
    return undefined;
  }
  return {
    id: record.id,
    content: record.content,
    status: record.status,
  };
};

/** Reconstruct the most recent valid todo snapshot on the active Pi branch. */
export const reconstructTodoState = (
  entries: readonly unknown[],
): TodoItem[] => {
  let state: TodoItem[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (
      candidate.type !== "custom" ||
      candidate.customType !== TODO_STATE_ENTRY
    ) {
      continue;
    }
    const data = candidate.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      continue;
    }
    const todos = (data as Record<string, unknown>).todos;
    if (!Array.isArray(todos)) continue;
    const parsed = todos.map(persistedTodo);
    if (parsed.every((todo): todo is TodoItem => todo !== undefined)) {
      state = parsed.map(cloneTodo);
    }
  }
  return state;
};

const statusTag = (status: TodoStatus): string => `[${status}]`;

export const summarizeTodoState = (todos: readonly TodoItem[]): string =>
  todos.length === 0
    ? "No tasks currently tracked."
    : todos
        .map(
          (todo) => `- ${statusTag(todo.status)} ${todo.id}: ${todo.content}`,
        )
        .join("\n");

const todoDetails = (
  merge: boolean,
  todos: readonly TodoItem[],
): TodoWriteDetails => ({
  merge,
  todos: todos.map(cloneTodo),
});

/**
 * First-party Pi extension for the one Melody plan tool whose semantics are
 * independent of the legacy goal classifier. It is injected as an inline
 * factory, so ambient user extensions remain disabled and no arbitrary code
 * is loaded merely by choosing the Pi engine.
 */
export const createTodoExtension = (
  getSessionMode: () => string = () => "default",
  getCapabilityMode: () => string = () => "all",
): InlineExtension => ({
  name: "melody-todo",
  hidden: true,
  factory: (pi: ExtensionAPI) => {
    let todos: TodoItem[] = [];

    const reconstruct = (ctx: ExtensionContext): void => {
      todos = reconstructTodoState(ctx.sessionManager.getBranch());
    };

    pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
    pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

    pi.registerTool({
      name: PI_TODO_WRITE,
      label: "Todo",
      description:
        "Create and manage a structured task list. Use for work with three or more steps; update only the items that changed.",
      promptSnippet: "manage a structured task list",
      parameters: todoWriteParameters,
      executionMode: "sequential",
      async execute(
        _toolCallId,
        params: TodoWriteParams,
        _signal,
        _onUpdate,
        _ctx,
      ) {
        if (getSessionMode() === "ask") {
          throw new Error("todo_write is unavailable in ask mode.");
        }
        if (getCapabilityMode() === "read-only") {
          throw new Error("todo_write is unavailable in read-only mode.");
        }

        const merge = params.merge ?? true;
        const next = applyTodoWriteState(todos, {
          merge,
          todos: params.todos,
        });
        // Custom entries are durable Pi session state and are not sent to the
        // model. Appending before changing the in-memory snapshot means a
        // failed session writer cannot silently report a successful update.
        pi.appendEntry<TodoStateEntryData>(TODO_STATE_ENTRY, {
          todos: next,
        });
        todos = next;

        return {
          content: [{ type: "text", text: summarizeTodoState(next) }],
          details: todoDetails(merge, next),
        };
      },
    });
  },
});
