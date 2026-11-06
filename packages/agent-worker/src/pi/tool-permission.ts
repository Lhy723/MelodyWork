import type { JsonObject } from "@melody/agent-contract";
import {
  PI_BROWSER_CLICK,
  PI_BROWSER_NAVIGATE,
  PI_BROWSER_TYPE,
  PI_MEMORY_REMEMBER,
  PI_MCP_CALL_TOOL,
  PI_MONITOR,
  PI_RUN_TERMINAL_COMMAND,
  PI_SCHEDULER_CREATE,
  PI_SCHEDULER_DELETE,
  PI_WORKSPACE_APPLY_PATCH,
  PI_WORKSPACE_EDIT,
  PI_WORKSPACE_WRITE_FILE,
} from "./tool-names.ts";

const responseOutcome = (resolution: JsonObject): string => {
  const nested = resolution.resolution;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return responseOutcome(nested as JsonObject);
  }
  const outcome = resolution.outcome;
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    return responseOutcome(outcome as JsonObject);
  }
  return typeof outcome === "string" ? outcome.toLowerCase() : "";
};

const responseOptionId = (resolution: JsonObject): string => {
  if (typeof resolution.optionId === "string") {
    return resolution.optionId;
  }
  const nested = resolution.resolution;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return responseOptionId(nested as JsonObject);
  }
  const outcome = resolution.outcome;
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    return responseOptionId(outcome as JsonObject);
  }
  return "";
};

/** Interpret legacy and current Host interaction response envelopes. */
export const isAllowedPermissionOutcome = (resolution: JsonObject): boolean => {
  const outcome = responseOutcome(resolution);
  const optionId = responseOptionId(resolution);
  return (
    outcome === "allow_once" ||
    outcome === "allow_always" ||
    outcome === "allow" ||
    optionId === "allow_once" ||
    optionId === "allow_always"
  );
};

/**
 * Keep the worker's persisted project-permission identity small and
 * deterministic. This only shapes an interaction payload; the Host remains
 * responsible for deriving and enforcing the actual permission decision.
 */
export const permissionRawInput = (
  toolName: string,
  params: JsonObject,
): JsonObject => {
  if (toolName === PI_RUN_TERMINAL_COMMAND || toolName === PI_MONITOR) {
    return {
      command: typeof params.command === "string" ? params.command : "",
    };
  }
  if (toolName === PI_WORKSPACE_WRITE_FILE || toolName === PI_WORKSPACE_EDIT) {
    return { path: typeof params.path === "string" ? params.path : "" };
  }
  if (toolName === PI_WORKSPACE_APPLY_PATCH) {
    return { command: "apply_patch" };
  }
  if (toolName === PI_SCHEDULER_CREATE) {
    // The prompt may contain user data, so the durable rule identity is only
    // the schedule expression, never the scheduled prompt contents.
    return {
      command:
        typeof params.cron === "string"
          ? params.cron
          : typeof params.interval === "string"
            ? params.interval
            : "",
    };
  }
  if (toolName === PI_SCHEDULER_DELETE) {
    return {
      command: typeof params.task_id === "string" ? params.task_id : "",
    };
  }
  if (toolName === PI_MCP_CALL_TOOL) {
    return {
      server: typeof params.server === "string" ? params.server : "",
      tool: typeof params.tool === "string" ? params.tool : "",
    };
  }
  if (toolName === PI_BROWSER_NAVIGATE) {
    try {
      const url = new URL(typeof params.url === "string" ? params.url : "");
      return { command: `${url.origin}${url.pathname}`.slice(0, 512) };
    } catch {
      return { command: "invalid browser URL" };
    }
  }
  if (toolName === PI_BROWSER_CLICK || toolName === PI_BROWSER_TYPE) {
    return {
      command: `${toolName}:${typeof params.ref_id === "string" ? params.ref_id : "unknown"}`,
      ...(toolName === PI_BROWSER_TYPE
        ? {
            textPreview:
              typeof params.text === "string" ? params.text.slice(0, 120) : "",
          }
        : {}),
    };
  }
  if (toolName === PI_MEMORY_REMEMBER) {
    // Keep the durable-memory permission identity stable across different
    // note contents. A project rule should authorize the selected scope, not
    // just one exact sentence that happened to be saved earlier.
    return {
      scope: typeof params.scope === "string" ? params.scope : "workspace",
    };
  }
  return {};
};
