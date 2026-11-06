/**
 * Engine-neutral protocol used at the MelodyWork agent boundary.
 *
 * This module deliberately contains no React, Tauri, Pi, or ACP imports.  An
 * engine adapter is responsible for translating its wire messages into these
 * values before they reach the product stores.
 */

import { AGENT_PROTOCOL_VERSION } from "./protocol-version.ts";

export { AGENT_PROTOCOL_VERSION };

export {
  AGENT_SESSION_MODE_IDS,
  isAgentSessionModeId,
  type AgentSessionModeId,
} from "./session-modes.ts";

export type AgentEngine = "melody-acp" | "pi";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type AgentRunStatus =
  "accepted" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type AgentInteractionKind = "permission" | "question" | "plan";

export interface AgentError {
  code: string;
  message: string;
  retriable: boolean;
  scope?: "runtime" | "session" | "run" | "tool" | "interaction";
  diagnosticId?: string;
  details?: JsonObject;
}

/**
 * A capability gap discovered during Pi preflight.
 *
 * Keeping this structured lets the Host block unsafe Pi sessions or explain
 * unavailable peripheral capabilities without implying a runtime switch.
 */
export interface AgentCapabilityDiagnostic {
  code: string;
  capability: string;
  severity: "info" | "warning" | "blocking";
  message: string;
  /** @deprecated Legacy diagnostic field; Pi-only runtime never falls back. */
  fallbackEngine?: AgentEngine;
  source?: string;
}

export interface AgentProtocolCapabilities {
  engine: AgentEngine;
  engineVersion: string;
  protocolVersion: number;
  /** Whether the engine exposes the product authentication command. */
  authentication: boolean;
  /** Whether the engine can return the versioned model catalog snapshot. */
  modelCatalog: boolean;
  tools: string[];
  sessionTree: boolean;
  compaction: boolean;
  plans: boolean;
  questions: boolean;
  permissions: boolean;
  subagents: boolean;
  backgroundTasks: boolean;
  mcp: boolean;
  media: string[];
  /** Session modes implemented by the selected engine, when known. */
  sessionModes?: string[];
  /** Explicit compatibility gaps shown by the host/diagnostics UI. */
  limitations?: string[];
  /** Machine-readable compatibility gaps used during engine negotiation. */
  diagnostics?: AgentCapabilityDiagnostic[];
}

export type AgentModelAvailability =
  "available" | "auth-needed" | "unavailable" | "unknown";

/** A non-secret model catalog entry shared by settings and an engine worker. */
export interface AgentModelDescriptor {
  provider: string;
  id: string;
  name: string;
  api: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  availability: AgentModelAvailability;
  authSource?: string;
}

export interface AgentRunConfig {
  modelId?: string;
  reasoningEffort?: string;
  sessionModeId?: string;
  permissionMode: "ask" | "auto" | "always-approve";
  configRevision: number;
}

/**
 * Host-owned resource roots projected into a Pi worker.
 *
 * The paths are not renderer-provided capabilities: the desktop Host derives
 * them from the authorized workspace and validates them again in the worker.
 * Keeping the manifest in the shared contract lets an already-running worker
 * receive an updated disabled-name snapshot without restarting the process.
 */
export interface AgentSkillResourceRoot {
  path: string;
  scope?: string;
  disabled: string[];
  /**
   * Canonical path prefixes Melody's `[skills].ignore` hides. The Host resolves
   * them so a refresh cannot resurrect an ignored Skill, and the worker applies
   * them to native roots only, matching the engine's filter order.
   */
  ignorePaths?: string[];
}

export interface AgentPromptResourceRoot {
  path: string;
  disabled: string[];
}

/**
 * Host-projected safeguards for Pi's durable goal lifecycle.
 *
 * These are intentionally bounded, deterministic controls.  They cover the
 * token and wall-clock safety rails that do not require a hidden planner or
 * classifier. Higher-level orchestration policies are outside this bounded
 * contract; unsupported policies are diagnosed or block the Pi session rather
 * than triggering a different Agent runtime.
 */
export interface AgentGoalPolicy {
  tokenBudget?: number;
  stallDetection?: boolean;
  stallTimeoutSecs?: number;
  maxBlockedAttempts?: number;
}

export interface AgentQuestionTimeoutPolicy {
  enabled: boolean;
  timeoutMs: number;
}

/**
 * Capability ceiling for a child session. `read-write-execute` exists because
 * Melody's agent definitions routinely request file mutation and a terminal
 * together; expressing that as `all` would additionally grant MCP calls the
 * definition never listed.
 */
export type AgentSubagentCapabilityMode =
  "read-only" | "read-write" | "read-write-execute" | "execute" | "all";

export type AgentSubagentIsolation = "none" | "worktree";

/**
 * A Host-resolved subagent role.  The worker receives the already-read
 * instruction text rather than a path, so a model cannot use a role manifest
 * to make it read arbitrary files outside the authorized workspace.
 */
export interface AgentSubagentRolePolicy {
  name: string;
  description?: string;
  instructions?: string;
  defaultCapabilityMode?: AgentSubagentCapabilityMode;
  modelId?: string;
  reasoningEffort?: string;
  isolation?: AgentSubagentIsolation;
}

/** A Host-resolved persona/SOUL definition with bounded prompt text. */
export interface AgentSubagentPersonaPolicy {
  name: string;
  description?: string;
  instructions: string;
  modelId?: string;
  reasoningEffort?: string;
  isolation?: AgentSubagentIsolation;
}

/**
 * The safe, declarative subset of a Melody/Claude Markdown agent definition
 * that can be projected into a Pi child session.  Dynamic tool lists,
 * executable hooks, MCP declarations and completion gates intentionally do
 * not cross the worker boundary; those definitions are unavailable in Pi
 * and are surfaced by the Host capability diagnostic.
 */
export interface AgentSubagentAgentPolicy {
  name: string;
  description?: string;
  instructions?: string;
  defaultCapabilityMode?: AgentSubagentCapabilityMode;
  permissionMode?: AgentRunConfig["permissionMode"];
  modelId?: string;
  reasoningEffort?: string;
  isolation?: AgentSubagentIsolation;
  /**
   * Exact `mcp__<server>__<tool>` grants carried from the definition's tool
   * allowlist. They apply only when `defaultCapabilityMode` is not `all`, so a
   * bounded ceiling never widens into the rest of an MCP server's surface.
   */
  mcpTools?: string[];
}

/**
 * Effective user/project subagent configuration projected into a Pi worker.
 * Maps are intentionally data-only and bounded by the protocol validator.
 */
export interface AgentSubagentPolicyManifest {
  enabled: boolean;
  models: Record<string, string>;
  toggle: Record<string, boolean>;
  roles: AgentSubagentRolePolicy[];
  personas: AgentSubagentPersonaPolicy[];
  /** Safe Markdown agent definitions projected by the Host. */
  agents: AgentSubagentAgentPolicy[];
  /** Names of definitions that contain unsupported dynamic behavior. */
  unsupportedAgents?: string[];
}

export interface AgentResourceManifest {
  cwd: string;
  skillRoots: AgentSkillResourceRoot[];
  promptRoots: AgentPromptResourceRoot[];
  /** Host-resolved Melody `.gitignore` policy for workspace tools. */
  respectGitignore?: boolean;
  /** Host-resolved wait policy for `ask_user_question` interactions. */
  questionTimeoutPolicy?: AgentQuestionTimeoutPolicy;
  /** Host-resolved role/persona defaults for Pi child sessions. */
  subagentPolicies?: AgentSubagentPolicyManifest;
  /** Host-resolved deterministic goal safety rails for Pi sessions. */
  goalPolicy?: AgentGoalPolicy;
}

/**
 * A short-lived Host-projected model credential. Values are sent only over
 * the local Host → worker pipe and are never echoed in a product event.
 */
export interface AgentModelCredential {
  name: string;
  value: string;
}

export type AgentToolResolutionStatus = "completed" | "failed" | "cancelled";

/**
 * Result returned by Melody's host-owned ToolGateway.
 *
 * Pi never receives a filesystem or shell capability directly.  A worker
 * pauses the tool call, emits a `tool.requested` event, and resumes only after
 * the host sends this bounded resolution over the authenticated worker pipe.
 */
export interface AgentToolResolution {
  status: AgentToolResolutionStatus;
  output?: string;
  error?: AgentError;
}

export type AgentCommand =
  | {
      type: "runtime.health";
      /** Product session used only to route a command to the right engine. */
      sessionId?: string;
      clientType?: string;
      clientVersion?: string;
      clientCapabilities?: JsonObject;
      startupHints?: JsonObject;
    }
  | {
      type: "runtime.shutdown";
      reason?: "stop" | "app-close";
    }
  | {
      type: "runtime.authenticate";
      methodId: string;
      headless?: boolean;
      /** Provider whose credential should be changed. */
      providerId?: string;
      /** API key for `setApiKey`; never echoed in events or diagnostics. */
      apiKey?: string;
      action?: "setApiKey" | "removeApiKey" | "status";
    }
  | {
      type: "runtime.models.list";
      /** Optional session affinity for per-session engine routing. */
      sessionId?: string;
      /** Re-read locally configured catalogs without enabling network access. */
      refresh?: boolean;
    }
  | {
      /**
       * Apply a Host-generated model catalog and credential snapshot to a
       * running worker without restarting active sessions.
       */
      type: "runtime.models.sync";
      /** Generated provider ids whose transient runtime overrides are stale. */
      providerIds: string[];
      /** Generated environment entries referenced by the catalog. */
      credentials: AgentModelCredential[];
    }
  | {
      type: "session.open";
      sessionId?: string;
      /** Stable Melody session identity, independent from an engine-native ID. */
      productSessionId?: string;
      cwd: string;
      modelId?: string;
      /** Initial reasoning level restored from the Host session binding. */
      reasoningEffort?: string;
      /** Initial workflow mode restored from the Host session binding. */
      sessionModeId?: string;
      permissionMode: AgentRunConfig["permissionMode"];
      cursor?: string;
    }
  | {
      type: "session.close";
      sessionId: string;
    }
  | {
      /** Create an independent Pi-native branch from a completed assistant entry. */
      type: "session.fork";
      /** Existing Pi product session to fork. */
      sessionId: string;
      /** New, already-persisted product session that will own the branch. */
      targetSessionId: string;
      cwd: string;
      /** Native Pi session-tree entry id; renderer timeline ids are never accepted. */
      nativeEntryId: string;
    }
  | {
      /** Materialize a validated ACP-to-Pi import plan into native JSONL. */
      type: "session.import";
      sessionId: string;
      /** Durable Host journal entry that authorizes this conversion attempt. */
      migrationId: string;
      /** Workspace used for the imported native session. */
      cwd: string;
      /** Session settings to use when the imported session is reopened. */
      modelId?: string;
      reasoningEffort?: string;
      sessionModeId?: string;
      permissionMode?: AgentRunConfig["permissionMode"];
      plan: JsonObject;
      /** Explicitly selected by the Host journal; omission is unsafe. */
      backup: boolean;
    }
  | {
      type: "session.configure";
      sessionId: string;
      /**
       * Optimistic-concurrency guard for mutable session settings. The worker
       * rejects a stale update instead of silently overwriting a newer one.
       */
      expectedRevision?: number;
      modelId?: string;
      reasoningEffort?: string;
      sessionModeId?: string;
      permissionMode?: AgentRunConfig["permissionMode"];
    }
  | {
      /** Refresh Host-projected Skill/command roots for every live session. */
      type: "session.resources.refresh";
      manifest: AgentResourceManifest;
    }
  | {
      type: "turn.submit";
      sessionId: string;
      promptId: string;
      content: string;
      attachments: AgentAttachment[];
      streamingBehavior?: "steer" | "followUp";
      config: AgentRunConfig;
    }
  | {
      type: "turn.steer" | "turn.follow_up";
      sessionId: string;
      runId: string;
      content: string;
    }
  | {
      type: "turn.cancel";
      sessionId: string;
      promptId?: string;
      runId?: string;
      cancelSubagents: boolean;
      reason: "user" | "timeout" | "shutdown";
    }
  | {
      type: "interaction.resolve";
      sessionId: string;
      interactionId: string;
      resolution: JsonObject;
    }
  | {
      type: "tool.resolve";
      sessionId: string;
      runId?: string;
      toolCallId: string;
      resolution: AgentToolResolution;
    }
  | {
      type: "task.wait" | "task.cancel";
      sessionId: string;
      taskId: string;
    }
  | {
      type: "task.continue";
      sessionId: string;
      taskId: string;
      content: string;
    };

export interface AgentAttachment {
  url: string;
  mediaType: string;
  filename?: string;
}

/**
 * Provider-native usage attached to a completed assistant message.
 *
 * `AgentUsage` is the aggregate billing shape used by the UI.  This smaller
 * lossless shape is kept on the message event as well so a Pi session can be
 * reopened without manufacturing the fields required by Pi's native v3
 * `AssistantMessage` record.
 */
export interface AgentAssistantUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** Metadata Pi exposes on a completed assistant response. */
export interface AgentAssistantMetadata {
  provider?: string;
  api?: string;
  model?: string;
  responseId?: string;
  stopReason?: string;
  usage?: AgentAssistantUsage;
}

export interface AgentCommandEnvelope {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  requestId: string | number;
  sessionId?: string;
  idempotencyKey?: string;
  command: AgentCommand;
}

export interface AgentEventEnvelope {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  eventId: string;
  sourceEventId?: string;
  /** Command that caused this event, when the event is a direct acknowledgement. */
  requestId?: string | number;
  sessionId?: string;
  /**
   * Identity of a nested task stream. `sessionId` remains the product/root
   * session used for Host persistence and authorization.
   */
  streamSessionId?: string;
  runId?: string;
  seq?: number;
  workerEpoch?: string;
  replay: boolean;
  event: AgentEvent;
}

export type AgentEvent =
  | {
      type: "runtime.ready";
      capabilities: AgentProtocolCapabilities;
    }
  | {
      type: "runtime.models";
      revision: number;
      models: AgentModelDescriptor[];
      refreshErrors?: JsonObject;
    }
  | {
      type: "runtime.warning" | "runtime.error";
      error: AgentError;
    }
  | {
      type:
        | "session.opened"
        | "session.closed"
        | "session.configured"
        | "session.imported";
      nativeSessionId?: string;
      revision?: number;
      importedRecords?: number;
      migrationId?: string;
      backupPath?: string;
      modelId?: string;
      reasoningEffort?: string;
      sessionModeId?: string;
      permissionMode?: AgentRunConfig["permissionMode"];
    }
  | {
      type: "run.accepted" | "run.started";
      promptId?: string;
    }
  | {
      /** Current Pi steering/follow-up queues for the active run. */
      type: "run.queue_updated";
      steering: string[];
      followUp: string[];
    }
  | {
      type: "run.finished";
      /** Prompt that owns this terminal event; present for Pi and replay-safe correlation. */
      promptId?: string;
      status: Exclude<AgentRunStatus, "accepted" | "running">;
      stopReason?: string;
      error?: AgentError;
    }
  | {
      type: "message.started" | "message.completed";
      messageId: string;
      role: "user" | "assistant";
      content?: string;
      /** Native Pi entry identity, emitted only for a verified assistant message. */
      nativeEntryId?: string;
      /** Provider metadata is optional for legacy ACP events. */
      assistantMetadata?: AgentAssistantMetadata;
    }
  | {
      type: "message.delta" | "thought.delta";
      messageId: string;
      partId: string;
      text: string;
      offset: number;
    }
  | {
      type:
        "tool.requested" | "tool.started" | "tool.progress" | "tool.finished";
      toolCallId: string;
      toolName?: string;
      output?: string;
      status?: "pending" | "running" | "completed" | "failed" | "cancelled";
      activity?: JsonObject;
      error?: AgentError;
    }
  | {
      type:
        | "interaction.requested"
        | "interaction.resolved"
        | "interaction.expired";
      interactionId: string;
      kind: AgentInteractionKind;
      payload?: JsonObject;
    }
  | {
      type: "usage.updated";
      usage: AgentUsage;
    }
  | {
      type: "context.updated";
      tokens: number | null;
      limit: number | null;
      confidence: "measured" | "estimated" | "unknown";
    }
  | {
      type: "session.compacting" | "session.compacted";
      nativeEntryId?: string;
    }
  | {
      type: "task.changed" | "subagent.changed";
      taskId: string;
      status: string;
      parentTaskId?: string;
      childSessionId?: string;
      payload?: JsonObject;
    }
  | {
      /**
       * A Host-owned schedule changed state. Schedules outlive a worker: the
       * Host persists them, so this event has no `workerEpoch` and is emitted by
       * the Host rather than reported by an engine.
       */
      type: "schedule.changed";
      change: AgentScheduleChange;
      schedule: AgentScheduleRecord;
    }
  | {
      /** One schedule trigger was dispatched, skipped or failed. */
      type: "schedule.fired";
      scheduleId: string;
      runOrdinal: number;
      status: AgentScheduleRunStatus;
      firedAt: number;
      runId?: string;
      error?: string;
    }
  | {
      /**
       * One line of a Host-owned monitor, delivered as a conversation
       * notification. Melody's `monitor` tool streams a long-running command
       * line by line; the Host bounds each line and rate-limits the stream, and
       * stops the monitor when it produces too many events.
       */
      type: "task.notification";
      taskId: string;
      description: string;
      line: string;
      sequence: number;
      truncated?: boolean;
    }
  | {
      /** Preserve an event while an adapter is catching up with a new engine. */
      type: "protocol.unhandled";
      method?: string;
      payload: JsonObject;
    };

export type AgentScheduleKind = "once" | "interval" | "cron";

export type AgentScheduleStatus =
  "active" | "paused" | "completed" | "expired" | "cancelled";

export type AgentScheduleChange =
  "created" | "paused" | "resumed" | "cancelled" | "completed" | "expired";

export type AgentScheduleRunStatus = "fired" | "skipped" | "failed";

/**
 * A durable Host-owned timer for one product session.
 *
 * `permissionMode`, `sessionModeId`, `modelId` and `reasoningEffort` are the
 * identity captured when the schedule was created: a trigger must never run
 * with more authority than the session had at that moment, and a later change
 * to the session does not silently widen it.
 */
export interface AgentScheduleRecord {
  scheduleId: string;
  sessionId: string;
  projectId: string;
  kind: AgentScheduleKind;
  intervalMs?: number;
  runAt?: number;
  /** Local-time 5-field cron expression; present only for `kind: "cron"`. */
  cron?: string;
  prompt: string;
  missedPolicy: "skip" | "run-once";
  maxRuns?: number;
  expiresAt?: number;
  status: AgentScheduleStatus;
  nextRunAt?: number;
  lastRunAt?: number;
  runCount: number;
  permissionMode: AgentRunConfig["permissionMode"];
  sessionModeId: string;
  modelId?: string;
  reasoningEffort?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentScheduleRunRecord {
  scheduleId: string;
  runOrdinal: number;
  status: AgentScheduleRunStatus;
  firedAt: number;
  runId?: string;
  error?: string;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
  modelCalls?: number;
  apiDurationMs?: number;
  cost?: { amount: number; currency: string };
  confidence: "measured" | "estimated" | "unknown";
}

export * from "./capabilities.ts";
export {
  containsControlCharacters,
  withoutControlCharacters,
  validateAgentCommandEnvelope,
} from "./validation.ts";
