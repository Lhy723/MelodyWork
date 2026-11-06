import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { gatewayError } from "./tool-errors.ts";

export type GatewayToolResultDetails = {
  gateway: "melody";
  toolName: string;
  approved?: boolean;
  taskId?: string;
};

/** Project a Host resolution into the text result shape expected by Pi. */
export const textResult = (
  output: string,
  toolName: string,
  approved?: boolean,
  taskId?: string,
): AgentToolResult<GatewayToolResultDetails> => ({
  content: [{ type: "text", text: output }],
  details: {
    gateway: "melody",
    toolName,
    ...(approved === undefined ? {} : { approved }),
    ...(taskId === undefined ? {} : { taskId }),
  },
});

/** Validate and project the Host's bounded JPEG payload into Pi image content. */
export const browserScreenshotResult = (
  output: string,
  toolName: string,
  approved?: boolean,
): AgentToolResult<GatewayToolResultDetails> => {
  const prefix = "data:image/jpeg;base64,";
  const data = output.startsWith(prefix) ? output.slice(prefix.length) : "";
  if (
    !data ||
    data.length > 700_000 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
  ) {
    throw gatewayError(
      "pi.browser_screenshot_invalid",
      "Host returned an invalid or oversized browser screenshot.",
      false,
    );
  }
  return {
    content: [
      { type: "image", data, mimeType: "image/jpeg" },
      { type: "text", text: "Current approved Browser viewport screenshot." },
    ],
    details: {
      gateway: "melody",
      toolName,
      ...(approved === undefined ? {} : { approved }),
    },
  };
};
