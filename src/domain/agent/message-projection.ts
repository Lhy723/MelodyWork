import type { AgentAssistantMetadata, AgentEvent } from "./contract.ts";
import type { TimelineEntry } from "../acp.ts";
import {
  applySessionUpdate,
  settleSessionProjection,
  type SessionUpdateResult,
} from "../session-projection-updates.ts";

type MessageProjectionDiagnostic = {
  kind: "duplicate-message-delta" | "message-offset-gap";
  eventType: "message.delta";
  messageId: string;
  partId: string;
  receivedOffset: number;
  expectedOffset: number;
};

type MessageProjectionPatch = {
  messageTimelineIds?: ReadonlyMap<string, string>;
  deltaOffsets?: ReadonlyMap<string, number>;
};

type MessageProjectionExtras = {
  diagnostic?: MessageProjectionDiagnostic;
};

export type MessageEventProjection =
  | {
      kind: "unchanged";
      extras?: MessageProjectionExtras;
    }
  | {
      kind: "projected";
      projection: SessionUpdateResult;
      patch?: MessageProjectionPatch;
      extras?: MessageProjectionExtras;
    };

interface MessageProjectionInput {
  timeline: TimelineEntry[];
  messageTimelineIds: ReadonlyMap<string, string>;
  deltaOffsets: ReadonlyMap<string, number>;
  event: AgentEvent;
  eventId: string;
}

const latestAssistantAfterLatestUser = (timeline: TimelineEntry[]) => {
  let latestUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry?.kind === "message" && entry.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  for (let index = timeline.length - 1; index > latestUserIndex; index -= 1) {
    const entry = timeline[index];
    if (entry?.kind === "message" && entry.role === "assistant") {
      return index;
    }
  }
  return -1;
};

/** Replace a streamed assistant row with Pi's final complete message. */
const completeAssistantMessage = (
  timeline: TimelineEntry[],
  messageTimelineId: string | undefined,
  content: string | undefined,
  assistantMetadata: AgentAssistantMetadata | undefined,
  nativeEntryId: string | undefined,
): TimelineEntry[] => {
  const mappedIndex = messageTimelineId
    ? timeline.findIndex(
        (entry) =>
          entry.id === messageTimelineId &&
          entry.kind === "message" &&
          entry.role === "assistant",
      )
    : -1;
  const index =
    mappedIndex >= 0 ? mappedIndex : latestAssistantAfterLatestUser(timeline);
  if (index < 0) {
    return settleSessionProjection(timeline);
  }
  const now = Date.now();
  return timeline.map((entry, entryIndex) =>
    entryIndex === index && entry.kind === "message"
      ? {
          ...entry,
          ...(content !== undefined ? { content } : {}),
          ...(nativeEntryId ? { nativeEntryId } : {}),
          ...(assistantMetadata
            ? {
                assistantMetadata: {
                  ...(entry.assistantMetadata ?? {}),
                  ...assistantMetadata,
                },
              }
            : {}),
          streaming: false,
          completedAt: entry.completedAt ?? now,
        }
      : entry,
  );
};

const messageMapAfterDelta = (
  map: ReadonlyMap<string, string>,
  messageId: string,
  timeline: TimelineEntry[],
): Map<string, string> => {
  const next = new Map(map);
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (
      entry?.kind === "message" &&
      entry.role === "assistant" &&
      entry.streaming
    ) {
      next.set(messageId, entry.id);
      break;
    }
  }
  return next;
};

const removeMessageState = (
  messageTimelineIds: ReadonlyMap<string, string>,
  deltaOffsets: ReadonlyMap<string, number>,
  messageId: string,
): Required<MessageProjectionPatch> => {
  const nextMessageTimelineIds = new Map(messageTimelineIds);
  nextMessageTimelineIds.delete(messageId);
  const prefix = `${messageId}\u0000`;
  const nextDeltaOffsets = new Map(
    [...deltaOffsets].filter(([key]) => !key.startsWith(prefix)),
  );
  return {
    messageTimelineIds: nextMessageTimelineIds,
    deltaOffsets: nextDeltaOffsets,
  };
};

/**
 * Project message-stream lifecycle events into the product timeline.
 * The caller owns envelope validation and applies the returned state patch.
 */
export const projectMessageEvent = (
  input: MessageProjectionInput,
): MessageEventProjection | undefined => {
  const { event, eventId, timeline, messageTimelineIds, deltaOffsets } = input;
  if (event.type === "message.delta") {
    const key = `${event.messageId}\u0000${event.partId}`;
    const expectedOffset = deltaOffsets.get(key) ?? 0;
    if (event.offset < expectedOffset) {
      return {
        kind: "unchanged",
        extras: {
          diagnostic: {
            kind: "duplicate-message-delta",
            eventType: "message.delta",
            messageId: event.messageId,
            partId: event.partId,
            receivedOffset: event.offset,
            expectedOffset,
          },
        },
      };
    }
    const projection = applySessionUpdate(
      timeline,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.text },
      },
      eventId,
    );
    const nextDeltaOffsets = new Map(deltaOffsets);
    nextDeltaOffsets.set(key, event.offset + event.text.length);
    return {
      kind: "projected",
      projection,
      patch: {
        messageTimelineIds: messageMapAfterDelta(
          messageTimelineIds,
          event.messageId,
          projection.timeline,
        ),
        deltaOffsets: nextDeltaOffsets,
      },
      extras: {
        diagnostic:
          event.offset > expectedOffset
            ? {
                kind: "message-offset-gap",
                eventType: "message.delta",
                messageId: event.messageId,
                partId: event.partId,
                receivedOffset: event.offset,
                expectedOffset,
              }
            : undefined,
      },
    };
  }

  if (event.type === "thought.delta") {
    return {
      kind: "projected",
      projection: applySessionUpdate(
        timeline,
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: event.text },
        },
        eventId,
      ),
    };
  }

  if (event.type === "message.started") {
    if (event.role !== "user" || !event.content) {
      return { kind: "unchanged" };
    }
    return {
      kind: "projected",
      projection: applySessionUpdate(
        timeline,
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: event.content },
        },
        eventId,
      ),
    };
  }

  if (event.type === "message.completed") {
    if (event.role === "user") {
      const withUser = event.content
        ? applySessionUpdate(
            timeline,
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: event.content },
            },
            eventId,
          ).timeline
        : timeline;
      return {
        kind: "projected",
        projection: { timeline: settleSessionProjection(withUser) },
        patch: removeMessageState(
          messageTimelineIds,
          deltaOffsets,
          event.messageId,
        ),
      };
    }
    return {
      kind: "projected",
      projection: {
        timeline: completeAssistantMessage(
          timeline,
          messageTimelineIds.get(event.messageId),
          event.content,
          event.assistantMetadata,
          event.nativeEntryId,
        ),
      },
      patch: removeMessageState(
        messageTimelineIds,
        deltaOffsets,
        event.messageId,
      ),
    };
  }

  return undefined;
};
