import { Buffer } from "node:buffer";
import type { AgentAttachment } from "@melody/agent-contract";
import { gatewayError } from "./tool-errors.ts";

/** Upper bound for one encoded attachment decoded into the Pi process. */
export const MAX_PI_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Aggregate decoded-byte ceiling for one Pi turn. */
export const MAX_PI_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;

export interface DecodedPiAttachment {
  byteLength: number;
  image?: { type: "image"; data: string; mimeType: string };
  text?: string;
}

/**
 * Return whether a Pi model can receive a given content modality. Pi's
 * built-in catalog always has an explicit `input` array; the optional shape
 * keeps this helper safe for legacy/default sessions whose model metadata is
 * unavailable. Unknown capability is allowed so an older provider catalog is
 * not rejected merely because it omitted the field.
 */
export const modelSupportsInput = (
  model: { input?: readonly unknown[] } | undefined,
  input: "text" | "image",
): boolean => {
  if (input === "text" || !model || !Array.isArray(model.input)) {
    return true;
  }
  return model.input.includes("image");
};

export const assertModelSupportsAttachments = (
  model: { input?: readonly unknown[] } | undefined,
  attachments: readonly Pick<AgentAttachment, "mediaType">[],
): void => {
  const hasImages = attachments.some((attachment) =>
    attachment.mediaType.trim().toLowerCase().startsWith("image/"),
  );
  if (hasImages && !modelSupportsInput(model, "image")) {
    throw gatewayError(
      "pi.model_input_unsupported",
      "当前 Pi 模型不支持图片输入，请移除图片或切换到支持视觉的模型。",
      false,
      "run",
    );
  }
};

/** Decode one data URL while keeping Pi input memory explicitly bounded. */
export const decodeAttachment = (
  url: string,
  mediaType: string,
): DecodedPiAttachment => {
  if (!url.startsWith("data:")) {
    throw gatewayError(
      "pi.unsupported_attachment",
      "Pi worker 目前只接受 data URL 附件。",
      false,
      "run",
    );
  }
  const comma = url.indexOf(",");
  if (comma < 0) {
    throw gatewayError(
      "pi.invalid_attachment",
      "附件 data URL 缺少内容。",
      false,
      "run",
    );
  }
  const header = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const base64 = header.endsWith(";base64");
  let bytes: Buffer;
  try {
    bytes = base64
      ? Buffer.from(body, "base64")
      : Buffer.from(decodeURIComponent(body), "utf8");
  } catch (error) {
    throw gatewayError(
      "pi.invalid_attachment",
      `附件 data URL 无法解码：${error instanceof Error ? error.message : String(error)}`,
      false,
      "run",
    );
  }
  if (bytes.byteLength > MAX_PI_ATTACHMENT_BYTES) {
    throw gatewayError(
      "pi.attachment_too_large",
      `单个附件不能超过 ${MAX_PI_ATTACHMENT_BYTES / (1024 * 1024)} MiB。`,
      false,
      "run",
    );
  }
  if (mediaType.startsWith("image/")) {
    return {
      byteLength: bytes.byteLength,
      image: {
        type: "image",
        data: bytes.toString("base64"),
        mimeType: mediaType,
      },
    };
  }
  return { byteLength: bytes.byteLength, text: bytes.toString("utf8") };
};

export interface PreparedPiTurnInput {
  content: string;
  images: NonNullable<DecodedPiAttachment["image"]>[];
}

/**
 * Validate and project attachments for one Pi turn. This keeps modality,
 * decoded-byte limits, and text/image placement in the same input owner.
 */
export const preparePiTurnAttachments = (
  model: Parameters<typeof assertModelSupportsAttachments>[0],
  content: string,
  attachments: readonly Pick<
    AgentAttachment,
    "filename" | "mediaType" | "url"
  >[],
): PreparedPiTurnInput => {
  assertModelSupportsAttachments(model, attachments);
  const images: PreparedPiTurnInput["images"] = [];
  const textAttachments: string[] = [];
  let attachmentBytes = 0;
  for (const attachment of attachments) {
    const decoded = decodeAttachment(attachment.url, attachment.mediaType);
    attachmentBytes += decoded.byteLength;
    if (attachmentBytes > MAX_PI_ATTACHMENT_TOTAL_BYTES) {
      throw gatewayError(
        "pi.attachments_too_large",
        `本次请求的附件总大小不能超过 ${MAX_PI_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MiB。`,
        false,
        "run",
      );
    }
    if (decoded.image) {
      images.push(decoded.image);
    } else {
      textAttachments.push(
        `[附件 ${attachment.filename ?? attachment.mediaType}]\n${decoded.text ?? ""}`,
      );
    }
  }
  return {
    content: textAttachments.length
      ? `${content}\n\n${textAttachments.join("\n\n")}`
      : content,
    images,
  };
};
