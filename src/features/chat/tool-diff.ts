import type { AgentToolDiffHunk, AgentToolFileChange } from "@/domain/acp";

export interface DiffLine {
  kind: "context" | "addition" | "deletion" | "ellipsis";
  oldNumber?: number;
  newNumber?: number;
  text: string;
}

const splitLines = (text: string | undefined) => {
  if (!text) return [];
  const lines = text.split(/\r?\n/u);
  if (text.endsWith("\n")) lines.pop();
  return lines;
};

const coarseDiff = (oldLines: string[], newLines: string[]) => {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...oldLines.slice(0, prefix).map((text) => ({ kind: "context", text })),
    ...oldLines
      .slice(prefix, oldLines.length - suffix)
      .map((text) => ({ kind: "deletion", text })),
    ...newLines
      .slice(prefix, newLines.length - suffix)
      .map((text) => ({ kind: "addition", text })),
    ...oldLines
      .slice(oldLines.length - suffix)
      .map((text) => ({ kind: "context", text })),
  ] as { kind: Exclude<DiffLine["kind"], "ellipsis">; text: string }[];
};

const sequenceDiff = (oldLines: string[], newLines: string[]) => {
  if (oldLines.length * newLines.length > 250_000) {
    return coarseDiff(oldLines, newLines);
  }
  const columns = newLines.length + 1;
  const matrix = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(columns),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? matrix[oldIndex + 1][newIndex + 1] + 1
          : Math.max(
              matrix[oldIndex + 1][newIndex],
              matrix[oldIndex][newIndex + 1],
            );
    }
  }
  const lines: ReturnType<typeof coarseDiff> = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      lines.push({ kind: "context", text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < newLines.length &&
      (oldIndex === oldLines.length ||
        matrix[oldIndex][newIndex + 1] > matrix[oldIndex + 1][newIndex])
    ) {
      lines.push({ kind: "addition", text: newLines[newIndex] });
      newIndex += 1;
    } else {
      lines.push({ kind: "deletion", text: oldLines[oldIndex] });
      oldIndex += 1;
    }
  }
  return lines;
};

const numberedDiffLines = ({
  oldText,
  newText,
  oldStartLine = 1,
  newStartLine = 1,
}: {
  oldText?: string;
  newText: string;
  oldStartLine?: number;
  newStartLine?: number;
}) => {
  const rawLines = sequenceDiff(splitLines(oldText), splitLines(newText));
  let oldNumber = oldStartLine;
  let newNumber = newStartLine;
  return rawLines.map((line): DiffLine => {
    if (line.kind === "addition") {
      return { ...line, newNumber: newNumber++ };
    }
    if (line.kind === "deletion") {
      return { ...line, oldNumber: oldNumber++ };
    }
    return {
      ...line,
      oldNumber: oldNumber++,
      newNumber: newNumber++,
    };
  });
};

const linesForHunk = (hunk: AgentToolDiffHunk) => {
  const contextBefore = splitLines(hunk.contextBefore);
  const contextAfter = splitLines(hunk.contextAfter);
  return numberedDiffLines({
    oldText: [
      ...contextBefore,
      ...splitLines(hunk.oldText),
      ...contextAfter,
    ].join("\n"),
    newText: [
      ...contextBefore,
      ...splitLines(hunk.newText),
      ...contextAfter,
    ].join("\n"),
    oldStartLine: Math.max(1, hunk.oldStartLine - contextBefore.length),
    newStartLine: Math.max(1, hunk.newStartLine - contextBefore.length),
  });
};

export const visibleDiffLines = (change: AgentToolFileChange): DiffLine[] => {
  if (change.hunks?.length) {
    return change.hunks
      .flatMap((hunk, index) => [
        ...(index > 0
          ? [{ kind: "ellipsis", text: "…" } satisfies DiffLine]
          : []),
        ...linesForHunk(hunk),
      ])
      .slice(0, 240);
  }
  const numbered = numberedDiffLines({
    oldText: change.oldText,
    newText: change.newText,
    oldStartLine: change.oldStartLine,
    newStartLine: change.newStartLine,
  });
  const changed = numbered.flatMap((line, index) =>
    line.kind === "context" ? [] : [index],
  );
  if (!changed.length) return numbered.slice(0, 20);
  const start = Math.max(0, changed[0] - 3);
  const end = Math.min(numbered.length, changed.at(-1)! + 4);
  const focused = numbered.slice(start, end);
  const withEdges: DiffLine[] = [];
  if (start > 0) withEdges.push({ kind: "ellipsis", text: "…" });
  withEdges.push(...focused.slice(0, 240));
  if (end < numbered.length || focused.length > 240) {
    withEdges.push({ kind: "ellipsis", text: "…" });
  }
  return withEdges;
};
