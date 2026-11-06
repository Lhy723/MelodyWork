import type {
  AgentCommandEnvelope,
  AgentGoalPolicy,
  AgentQuestionTimeoutPolicy,
  AgentProtocolCapabilities,
  AgentSubagentPolicyManifest,
} from "@melody/agent-contract";
import { AGENT_SESSION_MODE_IDS } from "@melody/agent-contract";
import { PiToolGateway, PI_GATEWAY_TOOL_NAMES } from "./tool-gateway.ts";
import type { PiSubagentCapabilityMode } from "./tool-access-policy.ts";
import { PI_TODO_WRITE } from "./todo-extension.ts";
import { PI_UPDATE_GOAL } from "./goal-extension.ts";
import { PiSessionForkRuntime } from "./session-fork-runtime.ts";
import { PiSessionImportRuntime } from "./session-import-runtime.ts";
import { PiSessionConfigurationRuntime } from "./session-configuration-runtime.ts";
import { PiSessionCloseRuntime } from "./session-close-runtime.ts";
import { PiSessionEventRuntime } from "./session-event-runtime.ts";
import { PiSessionResourceRefreshRuntime } from "./session-resource-refresh-runtime.ts";
import { PiSessionOpenRuntime } from "./session-open-runtime.ts";
export {
  assertActivePiRun,
  assertPiCancelTarget,
  validateTurnConfigSnapshot,
} from "./turn-policy.ts";
export {
  assertPiInteractiveChildTarget,
  assertPiResumeIdentity,
  assertPiResumeScope,
  assertPiResumeTarget,
  normalizePiResumeFrom,
  normalizePiSubagentCwd,
  parsePiWorktreeResponse,
} from "./subagent-session-boundaries.ts";
import {
  parsePiRuntimePolicyEnvironment,
  type PiResourcePolicySnapshot,
} from "./resource-policy-snapshot.ts";
export { piSessionFileFor } from "./session-persistence-policy.ts";
export { assertPiForkTargetMatches } from "./session-fork-runtime.ts";
import { createPiSessionResourceBinding } from "./session-resource-loader.ts";
export {
  assertModelSupportsAttachments,
  decodeAttachment,
  MAX_PI_ATTACHMENT_BYTES,
  MAX_PI_ATTACHMENT_TOTAL_BYTES,
  modelSupportsInput,
} from "./attachment-policy.ts";
export type { DecodedPiAttachment } from "./attachment-policy.ts";
import {
  PiModelCatalogRuntime,
  type PiModelRuntimeFactory,
} from "./model-catalog-runtime.ts";
import {
  loadPiSdk,
  type PiResourceBinding,
  type PiSdk,
  type PiSessionContext,
  type PiSessionHandle,
} from "./session-runtime-types.ts";
import { PiSubagentRuntime } from "./subagent-runtime.ts";
import { PiSessionTurnRuntime } from "./session-turn-runtime.ts";
export { parseHostTaskSnapshots } from "./subagent-runtime.ts";
import type { WorkerEmitter } from "../protocol.ts";

type TaskCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "task.wait" | "task.cancel" }
>;
type ContinueTaskCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "task.continue" }
>;
export const PI_CAPABILITIES: AgentProtocolCapabilities = {
  engine: "pi",
  engineVersion: "1.0.1",
  protocolVersion: 1,
  authentication: true,
  modelCatalog: true,
  // Derived from the gateway's own name list plus the in-process extension
  // tools: the announcement, the event mapper's gateway set and tool
  // registration must never disagree about which tools exist.
  tools: [...PI_GATEWAY_TOOL_NAMES, PI_TODO_WRITE, PI_UPDATE_GOAL],
  sessionTree: true,
  compaction: true,
  plans: true,
  questions: true,
  permissions: true,
  subagents: true,
  backgroundTasks: true,
  // MCP is exposed through the Rust Host's bounded local/remote bridge. The
  // worker never starts a server or opens a transport itself.
  mcp: true,
  sessionModes: [...AGENT_SESSION_MODE_IDS],
  media: ["image-input"],
  limitations: [
    "Pi is the only Agent runtime. Unsupported or unsafe configured surfaces are diagnosed as unavailable or block opening Pi; no capability gap switches a session to ACP.",
    "MCP local stdio and bounded HTTP/SSE servers use the Host bridge; provider-specific transports are unavailable in Pi and reported as a degradation.",
    "Melody/Claude plugin JavaScript/HTTP extensions are not loaded; trusted JSON command hooks run in the Host (PreToolUse can block, post/session/compaction/subagent hooks are observational, and unsupported Stop blocking semantics are unavailable).",
    "Read-only LSP definition, reference, hover, implementation, document-symbol, and workspace-symbol queries use the Host stdio bridge; project servers require trusted=true, while unsupported transports are unavailable in Pi.",
    "Host-owned codebase_navigation provides bounded tree-sitter definitions, references, document/workspace symbols, incremental refresh and Melody codebase_indexing boolean/glob policy for Rust, TypeScript/JavaScript, Python, and Go; strict cross-file graph semantics and unsupported languages are unavailable in Pi.",
    "Host-owned web_search and web_fetch are available in Pi with bounded URL, response-size, redirect, and domain policies; provider-specific search APIs still use their configured model credentials.",
    "Host-owned browser_navigate, browser_tabs, browser_snapshot, browser_wait, browser_screenshot, browser_click, browser_type, and browser_tab_* tools use an embedded workspace Webview and per-product-session profiles (Windows/Linux use persistent directories, macOS 14+ a persistent WebKit store, and older macOS an ephemeral store). Each product session supports up to 8 tabs, bounded untrusted snapshots/waits, and per-call approval for navigation/DOM actions. Local preview is explicit and loopback-only; public HTTPS login popups require opt-in. Desktop screenshots crop to the embedded viewport but can fail on Linux Wayland or when OS/display capture is unavailable. Password inputs are neither exposed nor typed.",
    "Custom Melody model catalogs are fetched and cached by the Host, then projected into Pi providers; when no custom endpoint is configured Pi keeps its signed native catalog.",
    "The Host evaluates a workspace .envrc through direnv export json with an empty environment and bounded names/values; arbitrary shell environment inheritance is not enabled.",
    "Host-owned memory_search, memory_get, and memory_remember read/write the existing global/workspace/session Markdown layout with bounded BM25-style ranking and guarded durable-note writes; the Host maintains a versioned SQLite lexical sidecar and uses Markdown when sidecar validation fails. The Host also performs first-turn injection and deterministic session-end snapshots. Pi's compaction extension adds a bounded first-pass memory-flush note and exposes /flush before native compaction; embedding/vector ranking and dream consolidation are unavailable in Pi.",
    "Headless OAuth login is not exposed; configure provider API keys in Melody settings.",
    "Background task output, wait-any/wait-all, and cancellation are exposed through the Melody-compatible task tools; Pi child tasks and Host-owned terminal tasks share the same scoped controls.",
    "Pi owns the bounded two-pass compaction/memory-flush extension, basic update_goal state persistence, and deterministic token-budget/stall/blocked-attempt safeguards. Configured advanced goal orchestration, model pins, external-auth commands, and dynamic plugin tools are unavailable in Pi. Pi supports general-purpose/explore/plan roles and read-only/read-write/execute/all capability ceilings with parent-child intersection. Custom auto-compaction thresholds map to Pi's native reserve-token setting, while the Host ToolGateway applies terminal, question-timeout, web, `.envrc`, and `.gitignore` visibility policies.",
    "Pi Host path checks are not a kernel sandbox. An unrepresentable configured isolation profile blocks opening Pi; platforms with no sandbox implementation show an explicit warning and run without OS sandboxing. Neither case switches to ACP.",
  ],
  diagnostics: [
    {
      code: "pi.plugins_unavailable",
      capability: "plugins",
      severity: "warning",
      message:
        "Pi 不会加载 Melody/Claude 插件的动态扩展、命令或代理；相关表面在本次会话中不可用，静态 Markdown Skill/命令资源仍可由 Host 受控投影。",
    },
    {
      code: "pi.hooks_unavailable",
      capability: "hooks",
      severity: "warning",
      message:
        "Pi 通过 Host 执行受限 JSON command Hook（PreToolUse 可阻断，post/session/compaction/subagent 为观察）；动态 JS/HTTP、未知事件及未映射 Stop 阻断语义在本次会话中不可用。",
    },
    {
      code: "pi.lsp_unavailable",
      capability: "lsp",
      severity: "warning",
      message:
        "Pi 通过 Host 只读 stdio 桥接接管受信任的 LSP；插件 LSP、非 stdio 传输或未显式 trusted=true 的项目配置在本次会话中不可用。",
    },
    {
      code: "pi.memory_semantic_index_unavailable",
      capability: "memory",
      severity: "warning",
      message:
        "Pi 已接管基础 Markdown 记忆检索、受控 memory_remember 写入、首轮注入、会话保存和两阶段 memory flush（含 /flush）；embedding/vector index 或 dream consolidation 在本次会话中不可用。",
    },
    {
      code: "pi.external_auth_unavailable",
      capability: "external-auth-provider",
      severity: "warning",
      message:
        "Pi 迁移版只支持 Host 管理的 API key，不执行外部认证提供程序命令。",
    },
    {
      code: "pi.oidc_unavailable",
      capability: "oidc-authentication",
      severity: "warning",
      message: "Pi 迁移版不提供浏览器/PKCE OIDC 登录流程。",
    },
    {
      code: "pi.subagent_policy_unavailable",
      capability: "subagent-policy",
      severity: "warning",
      message:
        "Pi 已支持声明式 agent 的提示、模型、权限和隔离；当前定义包含动态工具、Hook、MCP 或完成门禁时，该定义在本次会话中不可用。",
    },
    {
      code: "pi.goal_orchestration_unavailable",
      capability: "goal-orchestration",
      severity: "warning",
      message:
        "Pi 已支持基础 goal 状态、update_goal，以及有界的 token budget、停滞检测和阻塞次数护栏；Melody 的分类器、规划/验证器、重试编排或角色模型策略在本次会话中不可用。",
    },
    {
      code: "pi.terminal_policy_unavailable",
      capability: "terminal-policy",
      severity: "warning",
      message:
        "Melody 的终端超时或输出上限配置无法安全解析；该配置不会应用，本次会话使用 Host 默认上限。",
    },
    {
      code: "pi.question_timeout_policy_unavailable",
      capability: "question-timeout-policy",
      severity: "warning",
      message:
        "Pi 不应用无法安全解析的 Melody 自定义提问等待策略，本次会话使用默认行为。",
    },
    {
      code: "pi.sandbox_unavailable",
      capability: "sandbox",
      severity: "warning",
      message:
        "Pi Host 路径检查不等同于 OS 级沙箱；无法表达的隔离配置会阻止 Pi 会话，平台不支持沙箱时明确警告并以无沙箱方式运行。",
    },
  ],
};

/**
 * Isolated Pi SDK adapter. Every exposed tool is a Host-owned ToolGateway
 * proxy; the worker never receives an ambient filesystem or shell
 * implementation. The desktop product uses Pi as its only Agent runtime;
 * browser preview fixtures are deliberately not a native Pi session.
 */
export class PiSessionAdapter {
  private readonly sessions = new Map<string, PiSessionHandle>();
  /**
   * Open/import/close/configure are lifecycle mutations. The worker dispatches
   * stdin frames concurrently so tool resolutions can unblock a running turn,
   * so these operations need a smaller per-session queue of their own to
   * prevent duplicate native sessions, close/import races, or a configuration
   * update mutating a handle after it has been disposed. Long-running turns
   * stay outside this queue so tool/approval responses remain concurrent.
   */
  private readonly lifecycleTails = new Map<string, Promise<unknown>>();
  private readonly loadPiSdk: () => Promise<PiSdk>;
  private readonly toolGateway: PiToolGateway;
  private readonly modelCatalog: PiModelCatalogRuntime;
  private readonly subagents: PiSubagentRuntime;
  private readonly sessionFork: PiSessionForkRuntime;
  private readonly sessionImport: PiSessionImportRuntime;
  private readonly sessionConfiguration: PiSessionConfigurationRuntime;
  private readonly sessionResourceRefresh: PiSessionResourceRefreshRuntime;
  private readonly sessionOpen: PiSessionOpenRuntime;
  private readonly sessionClose: PiSessionCloseRuntime;
  private readonly sessionEvents: PiSessionEventRuntime;
  private readonly sessionTurns: PiSessionTurnRuntime;
  /** Host-resolved workspace file visibility policy shared by root/child sessions. */
  private respectGitignore: boolean;
  /** Host-resolved wait policy for user-question interactions. */
  private questionTimeoutPolicy: AgentQuestionTimeoutPolicy | undefined;
  /** Host-resolved deterministic goal safeguards shared by root/child sessions. */
  private goalPolicy: AgentGoalPolicy | undefined;
  /** Host-resolved role/persona defaults shared by root and child sessions. */
  private subagentPolicies: AgentSubagentPolicyManifest;

  /** Keep the bundled loader as default while allowing a local SDK adapter at the external-runtime seam. */
  public constructor(
    emit: WorkerEmitter,
    dependencies: {
      loadPiSdk?: () => Promise<PiSdk>;
      createModelRuntime?: PiModelRuntimeFactory;
    } = {},
  ) {
    const initialPolicy = parsePiRuntimePolicyEnvironment(process.env);
    this.respectGitignore = initialPolicy.respectGitignore;
    this.questionTimeoutPolicy = initialPolicy.questionTimeoutPolicy;
    this.goalPolicy = initialPolicy.goalPolicy;
    this.subagentPolicies = initialPolicy.subagentPolicies;
    this.loadPiSdk = dependencies.loadPiSdk ?? loadPiSdk;
    this.toolGateway = new PiToolGateway(emit);
    this.modelCatalog = new PiModelCatalogRuntime(
      emit,
      () => this.refreshModelSettingsForLiveSessions(),
      dependencies.createModelRuntime
        ? { createModelRuntime: dependencies.createModelRuntime }
        : {},
    );
    this.subagents = new PiSubagentRuntime({
      sessions: this.sessions,
      emit,
      loadPiSdk: this.loadPiSdk,
      toolGateway: this.toolGateway,
      modelCatalog: this.modelCatalog,
      createResourceLoader: (...args) => this.createResourceLoader(...args),
      onPiEvent: (sessionId, event) =>
        this.sessionEvents.handle(sessionId, event),
      getRespectGitignore: () => this.respectGitignore,
      getQuestionTimeoutPolicy: () => this.questionTimeoutPolicy,
      getSubagentPolicies: () => this.subagentPolicies,
      tools: PI_CAPABILITIES.tools,
    });
    this.sessionTurns = new PiSessionTurnRuntime({
      sessions: this.sessions,
      subagents: this.subagents,
      emit,
    });
    this.sessionEvents = new PiSessionEventRuntime({
      contextForSession: (sessionId) => this.contextForSession(sessionId),
      observePiEvent: (sessionId, input) =>
        this.subagents.observePiEvent(sessionId, input),
      emit,
    });
    this.sessionClose = new PiSessionCloseRuntime({
      sessions: this.sessions,
      cancelSubagentsForRootSession: (sessionId) =>
        this.subagents.cancelForRootSession(sessionId),
      emit,
    });
    this.sessionFork = new PiSessionForkRuntime({
      getSession: (sessionId) => this.sessions.get(sessionId),
      loadPiSdk: this.loadPiSdk,
      openSession: (command, requestId) =>
        this.openInternal(command, requestId, true),
    });
    this.sessionImport = new PiSessionImportRuntime({
      getSession: (sessionId) => this.sessions.get(sessionId),
      closeSession: (sessionId, requestId, emitLifecycle) =>
        this.sessionClose.close(
          sessionId,
          requestId,
          "session_closed",
          emitLifecycle,
        ),
      openSession: (command, requestId, emitLifecycle) =>
        this.openInternal(command, requestId, emitLifecycle),
      emit,
    });
    this.sessionConfiguration = new PiSessionConfigurationRuntime({
      getSession: (sessionId) => this.sessions.get(sessionId),
      modelCatalog: this.modelCatalog,
      emit,
    });
    this.sessionResourceRefresh = new PiSessionResourceRefreshRuntime({
      sessions: this.sessions,
      enqueueLifecycle: (sessionId, operation) =>
        this.enqueueLifecycle(sessionId, operation),
      subagents: this.subagents,
      applyPolicySnapshot: (snapshot) => {
        this.respectGitignore = snapshot.respectGitignore;
        this.questionTimeoutPolicy = snapshot.questionTimeoutPolicy;
        this.goalPolicy = snapshot.goalPolicy;
        this.subagentPolicies = snapshot.subagentPolicies;
      },
      emit,
    });
    this.sessionOpen = new PiSessionOpenRuntime({
      sessions: this.sessions,
      emit,
      loadPiSdk: this.loadPiSdk,
      modelCatalog: this.modelCatalog,
      createResourceLoader: (...args) => this.createResourceLoader(...args),
      toolContext: {
        gateway: this.toolGateway,
        subagents: this.subagents,
        contextForSession: (sessionId) => this.contextForSession(sessionId),
        getRespectGitignore: () => this.respectGitignore,
        getQuestionTimeoutPolicy: () => this.questionTimeoutPolicy,
      },
      tools: PI_CAPABILITIES.tools,
      subscribeToEvents: (sessionId, handle, session) =>
        session.subscribe((event) =>
          this.sessionEvents.enqueue(sessionId, handle, event),
        ),
    });
  }

  private async enqueueLifecycle<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.lifecycleTails.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.lifecycleTails.get(sessionId) === current) {
        this.lifecycleTails.delete(sessionId);
      }
    }
  }

  /** Resolve a root or nested child session without treating the worker's
   * root-session map as the only source of truth. Tool callbacks use the
   * child stream identity, while Host commands continue to use the product
   * root identity for authorization and persistence. */
  private contextForSession(
    sessionId: string,
  ): { handle: PiSessionContext } | undefined {
    const handle = this.subagents.sessionContextFor(sessionId);
    return handle ? { handle } : undefined;
  }

  public health(): AgentProtocolCapabilities {
    return PI_CAPABILITIES;
  }

  /**
   * Pi's OAuth login flow is intentionally not driven from this headless
   * worker. API-key providers are fully supported and credentials stay in the
   * Host-created auth file; status is exposed through the normal model event.
   */
  public async authenticate(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "runtime.authenticate" }
    >,
    requestId: string | number,
  ): Promise<void> {
    return this.modelCatalog.authenticate(command, requestId);
  }

  public async listModels(
    requestId: string | number,
    refresh = false,
  ): Promise<void> {
    return this.modelCatalog.listModels(requestId, refresh);
  }

  /**
   * Replace the generated model catalog and its short-lived environment
   * references without restarting the worker. The Host always sends the
   * complete snapshot, so removed models and credentials disappear together.
   */
  public async syncModels(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "runtime.models.sync" }
    >,
    requestId: string | number,
  ): Promise<void> {
    return this.modelCatalog.syncModels(command, requestId);
  }

  private async refreshModelSettingsForLiveSessions(): Promise<void> {
    const roots = [...this.sessions.entries()];
    await Promise.all([
      ...roots.map(([sessionId, handle]) =>
        this.enqueueLifecycle(sessionId, async () => {
          if (this.sessions.get(sessionId) !== handle) return;
          // A Pi run can be waiting for a tool/permission response while
          // `session.isStreaming` is false.  Keep the old policy snapshot for
          // that whole run; submit() applies the new one at the next boundary.
          if (!handle.runFinished) return;
          await handle.refreshModelSettings?.();
        }),
      ),
      this.subagents.refreshModelSettingsForLiveSessions(),
    ]);
  }

  /**
   * Apply a fresh Host-owned resource manifest to every live root/child
   * session. A running provider turn keeps its current prompt/tool runtime;
   * the per-turn callback retains the new manifest and reloads it before the
   * next top-level or child prompt. Idle sessions reload immediately so a
   * settings toggle is reflected without restarting the worker.
   */
  public async refreshResources(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "session.resources.refresh" }
    >,
    requestId: string | number,
  ): Promise<void> {
    return this.sessionResourceRefresh.refresh(command, requestId);
  }

  public async closeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.entries()].map(async ([sessionId]) => {
        try {
          await this.close(sessionId, undefined, "shutdown");
        } catch {
          // Shutdown should be best effort; the supervisor owns process exit.
        }
      }),
    );
    await this.subagents.closeAll();
    this.toolGateway.rejectAll();
  }

  public resolveTool(
    command: Extract<AgentCommandEnvelope["command"], { type: "tool.resolve" }>,
  ): void {
    this.toolGateway.resolve(command);
  }

  public resolveInteraction(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "interaction.resolve" }
    >,
  ): void {
    this.toolGateway.resolveInteraction(command);
  }

  public async importSession(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "session.import" }
    >,
    requestId: string | number,
  ): Promise<void> {
    return this.enqueueLifecycle(command.sessionId, () =>
      this.sessionImport.importSession(command, requestId),
    );
  }

  public async open(
    command: Extract<AgentCommandEnvelope["command"], { type: "session.open" }>,
    requestId: string | number,
  ): Promise<void> {
    const lifecycleKey = command.productSessionId ?? command.sessionId;
    if (lifecycleKey) {
      return this.enqueueLifecycle(lifecycleKey, () =>
        this.openInternal(command, requestId, true),
      );
    }
    await this.openInternal(command, requestId, true);
  }

  public async fork(
    command: Extract<AgentCommandEnvelope["command"], { type: "session.fork" }>,
    requestId: string | number,
  ): Promise<void> {
    return this.enqueueLifecycle(command.sessionId, () =>
      this.sessionFork.fork(command, requestId),
    );
  }

  private async openInternal(
    command: Extract<AgentCommandEnvelope["command"], { type: "session.open" }>,
    requestId: string | number,
    emitLifecycle: boolean,
  ): Promise<void> {
    return this.sessionOpen.open(command, requestId, emitLifecycle);
  }

  public async close(
    sessionId: string,
    requestId?: string | number,
    stopReason: "session_closed" | "shutdown" = "session_closed",
    emitLifecycle = true,
  ): Promise<void> {
    return this.enqueueLifecycle(sessionId, () =>
      this.sessionClose.close(sessionId, requestId, stopReason, emitLifecycle),
    );
  }

  public async submit(
    command: Extract<AgentCommandEnvelope["command"], { type: "turn.submit" }>,
    requestId: string | number,
    idempotencyKey?: string,
  ): Promise<void> {
    return this.sessionTurns.submit(command, requestId, idempotencyKey);
  }

  public async steer(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "turn.steer" | "turn.follow_up" }
    >,
    requestId: string | number,
  ): Promise<void> {
    return this.sessionTurns.steer(command, requestId);
  }

  public async cancel(
    command: Extract<AgentCommandEnvelope["command"], { type: "turn.cancel" }>,
    requestId: string | number,
  ): Promise<void> {
    return this.sessionTurns.cancel(command, requestId);
  }

  public async waitTask(
    command: TaskCommand,
    requestId: string | number,
  ): Promise<void> {
    return this.subagents.waitTask(command, requestId);
  }

  public async cancelTask(
    command: TaskCommand,
    requestId: string | number,
  ): Promise<void> {
    return this.subagents.cancelTask(command, requestId);
  }

  public async continueTask(
    command: ContinueTaskCommand,
    requestId: string | number,
  ): Promise<void> {
    return this.subagents.continueTask(command, requestId);
  }

  public async configure(
    command: Extract<
      AgentCommandEnvelope["command"],
      { type: "session.configure" }
    >,
    requestId: string | number,
  ): Promise<void> {
    return this.enqueueLifecycle(command.sessionId, () =>
      this.sessionConfiguration.configure(command, requestId),
    );
  }

  private async createResourceLoader(
    pi: PiSdk,
    cwd: string,
    getSessionMode: () => string,
    getCapabilityMode: () => PiSubagentCapabilityMode = () => "all",
    getTokenUsage?: () => number | undefined,
  ): Promise<PiResourceBinding> {
    return createPiSessionResourceBinding(pi, {
      cwd,
      getSessionMode,
      getCapabilityMode,
      getTokenUsage,
      getGoalPolicy: () => this.goalPolicy,
      applyPolicySnapshot: (snapshot: PiResourcePolicySnapshot) => {
        this.respectGitignore = snapshot.respectGitignore;
        this.questionTimeoutPolicy = snapshot.questionTimeoutPolicy;
        this.goalPolicy = snapshot.goalPolicy;
        this.subagentPolicies = snapshot.subagentPolicies;
      },
    });
  }
}
