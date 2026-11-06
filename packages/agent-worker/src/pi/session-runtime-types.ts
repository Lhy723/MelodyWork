import type {
  AgentError,
  AgentResourceManifest,
  AgentSessionModeId,
} from "@melody/agent-contract";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { IdempotencyLedger } from "../idempotency.ts";
import type { PiSubagentCapabilityMode } from "./tool-access-policy.ts";
import type { PiScopedInstructionFile } from "./instruction-scope-extension.ts";
import { normalizeThinkingLevel } from "./turn-policy.ts";
import type { PiThinkingLevel } from "./subagent-records.ts";

export type PiSdk = Pick<
  typeof import("@earendil-works/pi-coding-agent"),
  | "createAgentSession"
  | "SessionManager"
  | "DefaultResourceLoader"
  | "SettingsManager"
>;
export type PiSession = Awaited<
  ReturnType<PiSdk["createAgentSession"]>
>["session"];
export type PiResourceLoader = InstanceType<PiSdk["DefaultResourceLoader"]>;

/**
 * Keep the SDK entry statically reachable. The worker is shipped as a
 * self-contained Bun executable in production; import.meta.resolve() cannot
 * resolve a package from Bun's embedded filesystem.
 */
const PI_SDK: PiSdk = {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  SettingsManager,
};

export const loadPiSdk = async (): Promise<PiSdk> => PI_SDK;

export const PI_SESSION_ROOT_ENV = "MELODY_PI_SESSION_ROOT";

export interface PiSessionContext {
  session: PiSession;
  refreshResources?: (manifest?: AgentResourceManifest) => Promise<void>;
  refreshModelSettings?: () => Promise<void>;
  nativeSessionId: string;
  rootSessionId: string;
  streamSessionId: string;
  runId?: string;
  promptId?: string;
  runFinished: boolean;
  runError?: AgentError;
  nextMessage: number;
  offsets: Map<string, number>;
  activeMessageIds: Map<"user" | "assistant", string>;
  eventTail: Promise<void>;
  permissionMode: "ask" | "auto" | "always-approve";
  sessionModeId: AgentSessionModeId;
  capabilityMode: PiSubagentCapabilityMode;
  mcpTools?: ReadonlySet<string>;
  modelId?: string;
  reasoningEffort: PiThinkingLevel;
  configRevision: number;
  runTransition?: Promise<void>;
}

export interface PiSessionHandle extends PiSessionContext {
  unsubscribe: () => void;
  idempotency: IdempotencyLedger;
}

export interface PiResourceBinding {
  loader: PiResourceLoader;
  activateScopedInstructions: (
    files: readonly PiScopedInstructionFile[],
  ) => number;
  refreshPaths: (manifest?: AgentResourceManifest) => void;
}

export type PiResourceLoaderFactory = (
  pi: PiSdk,
  cwd: string,
  getSessionMode: () => string,
  getCapabilityMode?: () => PiSubagentCapabilityMode,
  getTokenUsage?: () => number | undefined,
) => Promise<PiResourceBinding>;

export const modelIdForSession = (
  session: PiSession,
  requestedModelId?: string,
): string | undefined => {
  const modelId =
    requestedModelId ??
    (session.model
      ? session.model.provider + "/" + session.model.id
      : undefined);
  // Pi AgentCore uses this placeholder before a model is configured. It is
  // not a catalog entry and must never become a durable session selection.
  return modelId === "unknown/unknown" ? undefined : modelId;
};

export const effectiveThinkingLevelForSession = (
  session: PiSession,
  requestedThinkingLevel?: PiThinkingLevel,
): PiThinkingLevel =>
  normalizeThinkingLevel(session.thinkingLevel) ??
  requestedThinkingLevel ??
  "medium";
