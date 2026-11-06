import type {
  AgentToolActivity,
  AgentToolDiffHunk,
  AgentToolFileChange,
  AgentToolOperation,
} from "@/domain/acp";

type JsonObject = Record<string, unknown>;

const objectValue = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object"
    ? (value as JsonObject)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const toolInput = (tool: JsonObject): JsonObject | undefined => {
  const input = objectValue(tool.rawInput);
  return input?.gateway === "melody"
    ? objectValue(input.arguments)
    : input;
};

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stringifyValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value, null, 2);
};

const lineCount = (text: string | undefined) =>
  text ? text.split(/\r?\n/u).length - (text.endsWith("\n") ? 1 : 0) : 0;

const normalizedPath = (path: string) => path.replaceAll("\\", "/");

const pathFromTitle = (title: string) => {
  const quoted = title.match(/`([^`]+)`/u)?.[1];
  if (quoted) {
    return normalizedPath(quoted);
  }
  const verbPath = title.match(
    /^(?:Read|Write|Edit|Create|Delete)\s+(.+)$/iu,
  )?.[1];
  return verbPath?.trim() ? normalizedPath(verbPath.trim()) : undefined;
};

const operationFromKind = (
  kind: string | undefined,
  title: string,
  variant: string | undefined,
): AgentToolOperation => {
  // Normalized worker tool names commonly use snake_case (for example
  // `workspace_read_file`). Treat separators as spaces before inferring the
  // product operation so Pi/ACP tool names do not collapse into `other`.
  const haystack = `${kind ?? ""} ${variant ?? ""} ${title}`
    .toLowerCase()
    .replaceAll(/[_-]/gu, " ");
  if (/\b(search|grep|glob|find)\b/u.test(haystack)) {
    return "search";
  }
  if (/\b(read|listdir|list dir)\b/u.test(haystack)) {
    return "read";
  }
  if (/\b(delete|remove)\b/u.test(haystack)) {
    return "delete";
  }
  if (/\b(write|create)\b/u.test(haystack)) {
    return "create";
  }
  if (/\b(edit|patch|replace)\b/u.test(haystack)) {
    return "edit";
  }
  if (/\b(execute|bash|terminal|command|run)\b/u.test(haystack)) {
    return "execute";
  }
  return "other";
};

const diffFromContent = (value: unknown): AgentToolFileChange[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const block = objectValue(item);
    if (!block || stringValue(block.type) !== "diff") {
      return [];
    }
    const path = stringValue(block.path);
    const newText = stringValue(block.newText);
    if (!path || newText === undefined) {
      return [];
    }
    const oldText = stringValue(block.oldText);
    const meta = objectValue(block._meta);
    const hunks = Array.isArray(meta?.details)
      ? meta.details.flatMap((item): AgentToolDiffHunk[] => {
          const detail = objectValue(item);
          const detailOldText = stringValue(detail?.old_string);
          const detailNewText = stringValue(detail?.new_string);
          const oldStartLine = numberValue(detail?.old_line);
          const newStartLine = numberValue(detail?.new_line);
          if (
            detailOldText === undefined ||
            detailNewText === undefined ||
            oldStartLine === undefined ||
            newStartLine === undefined
          ) {
            return [];
          }
          return [
            {
              oldText: detailOldText,
              newText: detailNewText,
              oldStartLine,
              newStartLine,
              contextBefore: stringValue(detail?.context_before),
              contextAfter: stringValue(detail?.context_after),
            },
          ];
        })
      : [];
    const operation =
      oldText === undefined || oldText === ""
        ? "create"
        : newText === ""
          ? "delete"
          : "edit";
    return [
      {
        path: normalizedPath(path),
        operation,
        oldText,
        newText,
        additions: hunks.length
          ? hunks.reduce((total, hunk) => total + lineCount(hunk.newText), 0)
          : lineCount(newText),
        deletions: hunks.length
          ? hunks.reduce((total, hunk) => total + lineCount(hunk.oldText), 0)
          : lineCount(oldText),
        oldStartLine: numberValue(meta?.old_line) ?? numberValue(meta?.oldLine),
        newStartLine: numberValue(meta?.new_line) ?? numberValue(meta?.newLine),
        hunks: hunks.length ? hunks : undefined,
      } satisfies AgentToolFileChange,
    ];
  });
};

const inputPath = (rawInput: JsonObject | undefined) =>
  stringValue(rawInput?.path) ??
  stringValue(rawInput?.file_path) ??
  stringValue(rawInput?.filePath) ??
  stringValue(rawInput?.target_directory) ??
  stringValue(rawInput?.targetDirectory);

const locationPaths = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.flatMap((item) => {
        const location = objectValue(item);
        const path = stringValue(location?.path);
        return path ? [normalizedPath(path)] : [];
      }),
    ),
  ];
};

export const projectToolText = (
  tool: JsonObject,
): { command: string; output: string } => {
  const input = objectValue(tool.rawInput);
  const rawInput = toolInput(tool);
  const displayInput =
    stringValue(rawInput?.command) ??
    stringValue(rawInput?.cmd) ??
    stringValue(rawInput?.path) ??
    stringValue(rawInput?.file_path) ??
    stringValue(rawInput?.filePath) ??
    stringValue(rawInput?.target_directory) ??
    stringValue(rawInput?.targetDirectory);
  const content = Array.isArray(tool.content) ? tool.content : [];
  const contentText = content
    .map((item) => {
      const block = objectValue(item);
      return (
        stringValue(block?.text) ??
        stringifyValue(block?.content) ??
        stringifyValue(item)
      );
    })
    .filter(Boolean)
    .join("\n");

  return {
    command:
      displayInput ??
      (input?.gateway === "melody" ? "" : stringifyValue(tool.rawInput)),
    output: contentText || stringifyValue(tool.rawOutput),
  };
};

export const extractToolActivity = (
  tool: JsonObject,
  previous?: AgentToolActivity,
): AgentToolActivity => {
  const rawInput = toolInput(tool);
  const title = stringValue(tool.title) ?? "";
  const files = diffFromContent(tool.content);
  const paths = locationPaths(tool.locations);
  const retainedPaths = paths.length > 0 ? paths : previous?.paths;
  const inferredOperation = operationFromKind(
    stringValue(tool.kind),
    title,
    stringValue(rawInput?.variant),
  );
  const operation: AgentToolOperation =
    files.length > 0
      ? files[0].operation
      : inferredOperation === "other"
        ? (previous?.operation ?? "other")
        : inferredOperation;
  const path =
    inputPath(rawInput) ??
    retainedPaths?.[0] ??
    pathFromTitle(title) ??
    previous?.path;
  const query =
    stringValue(rawInput?.pattern) ??
    stringValue(rawInput?.query) ??
    (operation === "search" && title && !pathFromTitle(title)
      ? title
      : previous?.query);

  return {
    operation,
    path: path ? normalizedPath(path) : undefined,
    query,
    glob:
      stringValue(rawInput?.glob) ??
      stringValue(rawInput?.include) ??
      previous?.glob,
    files: files.length ? files : previous?.files,
    ...(retainedPaths?.length ? { paths: retainedPaths } : {}),
  };
};
