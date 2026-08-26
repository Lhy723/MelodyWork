import type {
  AgentQuestionRequest,
  AgentToolActivity,
  TimelineEntry,
} from "./acp";

/**
 * A persisted projection is a recovery hint, not an archive of every byte
 * emitted by a tool. Keeping a hard bound here prevents a long-running
 * session from turning every autosave into a multi-megabyte SQLite write.
 */
export const MAX_PERSISTED_TIMELINE_BYTES = 2 * 1024 * 1024;
export const MAX_PERSISTED_TIMELINE_ENTRIES = 400;

const MAX_MESSAGE_CHARS = 32_000;
const MAX_THOUGHT_CHARS = 16_000;
const MAX_PLAN_CHARS = 24_000;
const MAX_TOOL_COMMAND_CHARS = 8_000;
const MAX_TOOL_OUTPUT_CHARS = 32_000;
const MAX_ACTIVITY_TEXT_CHARS = 8_000;
const MAX_ACTIVITY_HUNK_CHARS = 2_000;
const MAX_ACTIVITY_FILES = 16;
const MAX_ACTIVITY_HUNKS = 24;
const MAX_ATTACHMENT_URL_CHARS = 32_000;
const MAX_QUESTION_CHARS = 4_000;
const MAX_QUESTION_OPTIONS = 24;
const MAX_QUESTION_COUNT = 12;

const truncate = (
  value: string | undefined,
  limit: number,
): string | undefined =>
  value === undefined || value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - 1))}…`;

const compactActivity = (
  activity: AgentToolActivity | undefined,
): AgentToolActivity | undefined => {
  if (!activity) {
    return undefined;
  }
  return {
    ...activity,
    query: truncate(activity.query, MAX_ACTIVITY_TEXT_CHARS),
    glob: truncate(activity.glob, MAX_ACTIVITY_TEXT_CHARS),
    paths: activity.paths?.slice(0, MAX_ACTIVITY_FILES),
    files: activity.files?.slice(-MAX_ACTIVITY_FILES).map((file) => ({
      ...file,
      path: truncate(file.path, MAX_ACTIVITY_TEXT_CHARS) ?? file.path,
      oldText: truncate(file.oldText, MAX_ACTIVITY_TEXT_CHARS),
      newText: truncate(file.newText, MAX_ACTIVITY_TEXT_CHARS) ?? "",
      hunks: file.hunks?.slice(-MAX_ACTIVITY_HUNKS).map((hunk) => ({
        ...hunk,
        oldText: truncate(hunk.oldText, MAX_ACTIVITY_HUNK_CHARS) ?? "",
        newText: truncate(hunk.newText, MAX_ACTIVITY_HUNK_CHARS) ?? "",
        contextBefore: truncate(hunk.contextBefore, MAX_ACTIVITY_HUNK_CHARS),
        contextAfter: truncate(hunk.contextAfter, MAX_ACTIVITY_HUNK_CHARS),
      })),
    })),
  };
};

const compactQuestion = (
  question: AgentQuestionRequest | undefined,
): AgentQuestionRequest | undefined => {
  if (!question) {
    return undefined;
  }
  return {
    ...question,
    questions: question.questions.slice(0, MAX_QUESTION_COUNT).map((item) => ({
      ...item,
      question: truncate(item.question, MAX_QUESTION_CHARS) ?? "",
      options: item.options.slice(0, MAX_QUESTION_OPTIONS).map((option) => ({
        ...option,
        label: truncate(option.label, MAX_QUESTION_CHARS) ?? "",
        description: truncate(option.description, MAX_QUESTION_CHARS) ?? "",
        preview: truncate(option.preview, MAX_QUESTION_CHARS),
      })),
    })),
  };
};

const compactAttachmentUrl = (url: string): string =>
  url.length <= MAX_ATTACHMENT_URL_CHARS
    ? url
    : url.startsWith("data:")
      ? ""
      : url.slice(0, MAX_ATTACHMENT_URL_CHARS - 1) + "…";

const compactEntry = (entry: TimelineEntry): TimelineEntry => {
  if (entry.kind === "message") {
    return {
      ...entry,
      content: truncate(entry.content, MAX_MESSAGE_CHARS) ?? "",
      attachments: entry.attachments
        ?.slice(0, MAX_ACTIVITY_FILES)
        .map((attachment) => ({
          ...attachment,
          url: compactAttachmentUrl(attachment.url),
        })),
    };
  }
  if (entry.kind === "thought") {
    return {
      ...entry,
      content: truncate(entry.content, MAX_THOUGHT_CHARS) ?? "",
    };
  }
  if (entry.kind === "plan") {
    return {
      ...entry,
      content: truncate(entry.content, MAX_PLAN_CHARS) ?? "",
    };
  }
  return {
    ...entry,
    title: truncate(entry.title, MAX_ACTIVITY_TEXT_CHARS) ?? entry.title,
    command: truncate(entry.command, MAX_TOOL_COMMAND_CHARS) ?? "",
    output: truncate(entry.output, MAX_TOOL_OUTPUT_CHARS) ?? "",
    activity: compactActivity(entry.activity),
    question: compactQuestion(entry.question),
  };
};

const serializedBytes = (timeline: TimelineEntry[]): number =>
  new TextEncoder().encode(JSON.stringify(timeline)).byteLength;

export interface PreparedTimelineSnapshot {
  timeline: TimelineEntry[];
  truncated: boolean;
  bytes: number;
}

/**
 * Compacts a timeline deterministically and keeps the newest entries. A
 * `truncated` result means the snapshot cannot be restored by itself. The
 * caller may retain an ACP cursor only when a complete timeline archive is
 * persisted transactionally beside it.
 */
export const prepareTimelineSnapshot = (
  timeline: TimelineEntry[],
): PreparedTimelineSnapshot => {
  const tail = timeline.slice(-MAX_PERSISTED_TIMELINE_ENTRIES);
  let compacted = tail.map(compactEntry);
  let truncated =
    compacted.length !== timeline.length ||
    compacted.some(
      (entry, index) => JSON.stringify(entry) !== JSON.stringify(tail[index]),
    );

  while (
    compacted.length > 1 &&
    serializedBytes(compacted) > MAX_PERSISTED_TIMELINE_BYTES
  ) {
    compacted = compacted.slice(1);
    truncated = true;
  }

  // A single malformed/oversized event should never make persistence fail.
  // The per-field limits above normally make this unnecessary, but retaining
  // an empty projection is safer than repeatedly retrying an invalid write.
  if (serializedBytes(compacted) > MAX_PERSISTED_TIMELINE_BYTES) {
    compacted = [];
    truncated = true;
  }

  return {
    timeline: compacted,
    truncated,
    bytes: serializedBytes(compacted),
  };
};
