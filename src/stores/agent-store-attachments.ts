import type {
  AgentPromptAttachment,
  AgentTimelineAttachment,
} from "@/domain/acp";

const parseDataUrl = (url: string) => {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) {
    return undefined;
  }
  return {
    data: match[3],
    base64: Boolean(match[2]),
    mediaType: match[1],
  };
};

const decodeAttachmentText = (
  parsed: NonNullable<ReturnType<typeof parseDataUrl>>,
) => {
  if (!parsed.base64) {
    return decodeURIComponent(parsed.data);
  }
  const bytes = Uint8Array.from(atob(parsed.data), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
};

export const attachmentPromptBlocks = (
  attachments: AgentPromptAttachment[],
): Record<string, unknown>[] =>
  attachments.map((attachment) => {
    const parsed = parseDataUrl(attachment.url);
    if (!parsed) {
      throw new Error(`无法读取附件 ${attachment.filename ?? "文件"}。`);
    }

    const mediaType = attachment.mediaType || parsed.mediaType;
    if (mediaType.startsWith("image/")) {
      if (!parsed.base64) {
        throw new Error(`无法编码图片 ${attachment.filename ?? "附件"}。`);
      }
      return {
        type: "image",
        data: parsed.data,
        mimeType: mediaType,
      };
    }

    return {
      type: "text",
      text: [
        `<attachment filename="${attachment.filename ?? "attachment"}" media-type="${mediaType || "text/plain"}">`,
        decodeAttachmentText(parsed),
        "</attachment>",
      ].join("\n"),
    };
  });

export const timelineAttachments = (
  attachments: AgentPromptAttachment[],
): AgentTimelineAttachment[] =>
  attachments.map((attachment, index) => ({
    id: `attachment-${Date.now()}-${index}`,
    type: "file",
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    url: "",
  }));
