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

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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
  const haystack = `${kind ?? ""} ${variant ?? ""} ${title}`.toLowerCase();
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
          return [{
            oldText: detailOldText,
            newText: detailNewText,
            oldStartLine,
            newStartLine,
            contextBefore: stringValue(detail?.context_before),
            contextAfter: stringValue(detail?.context_after),
          }];
        })
      : [];
    const operation =
      oldText === undefined || oldText === ""
        ? "create"
        : newText === ""
          ? "delete"
          : "edit";
    return [{
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
      oldStartLine:
        numberValue(meta?.old_line) ?? numberValue(meta?.oldLine),
      newStartLine:
        numberValue(meta?.new_line) ?? numberValue(meta?.newLine),
      hunks: hunks.length ? hunks : undefined,
    } satisfies AgentToolFileChange];
  });
};

const inputPath = (rawInput: JsonObject | undefined) =>
  stringValue(rawInput?.path) ??
  stringValue(rawInput?.file_path) ??
  stringValue(rawInput?.filePath) ??
  stringValue(rawInput?.target_directory) ??
  stringValue(rawInput?.targetDirectory);

export const extractToolActivity = (
  tool: JsonObject,
  previous?: AgentToolActivity,
): AgentToolActivity => {
  const rawInput = objectValue(tool.rawInput);
  const title = stringValue(tool.title) ?? "";
  const files = diffFromContent(tool.content);
  const inferredOperation = operationFromKind(
    stringValue(tool.kind),
    title,
    stringValue(rawInput?.variant),
  );
  const operation: AgentToolOperation =
    files.length > 0
      ? files[0].operation
      : inferredOperation === "other"
        ? previous?.operation ?? "other"
        : inferredOperation;
  const path =
    inputPath(rawInput) ??
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
  };
};
