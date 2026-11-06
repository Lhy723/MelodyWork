import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type {
  AgentCommandEnvelope,
  AgentError,
  AgentProtocolCapabilities,
  AgentQuestionTimeoutPolicy,
  AgentResourceManifest,
  AgentSubagentPolicyManifest,
} from "@melody/agent-contract";
import type { WorkerEmitter } from "../protocol.ts";
import { PiModelCatalogRuntime } from "./model-catalog-runtime.ts";
import {
  PiToolGateway,
  PI_CREATE_SUBAGENT_WORKTREE,
  PI_KILL_COMMAND_OR_SUBAGENT,
  PI_WAIT_COMMANDS_OR_SUBAGENTS,
} from "./tool-gateway.ts";
import type { PiSubagentCapabilityMode } from "./tool-access-policy.ts";
import type { PiTaskController, PiTaskSnapshot } from "./task-tools.ts";
import {
  effectiveThinkingLevelForSession,
  modelIdForSession,
  PI_SESSION_ROOT_ENV,
  type PiResourceLoaderFactory,
  type PiSdk,
  type PiSessionContext,
  type PiSessionHandle,
} from "./session-runtime-types.ts";
import { applyModelPolicyOverrides } from "./model-policy.ts";
import { fail } from "./session-errors.ts";
import {
  assertPiInteractiveChildTarget,
  assertPiResumeIdentity,
  assertPiResumeScope,
  assertPiResumeTarget,
  normalizePiResumeFrom,
  normalizePiSubagentCwd,
  parsePiWorktreeResponse,
} from "./subagent-session-boundaries.ts";
import {
  composePiSubagentPrompt,
  resolvePiSubagentLaunchPolicy,
} from "./subagent-policy.ts";
import {
  loadPiSubagentRecord,
  savePiSubagentRecord,
  type PersistedPiSubagent,
} from "./subagent-records.ts";
import { normalizeThinkingLevel } from "./turn-policy.ts";
import {
  startPiSubagentTaskLifecycle,
  type PiSubagentTaskHandle as TaskHandle,
} from "./subagent-task-lifecycle.ts";
import {
  HostTaskControl,
  isHostBackgroundTaskId,
} from "./host-task-control.ts";
export { parseHostTaskSnapshots } from "./host-task-control.ts";

type TaskCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "task.wait" | "task.cancel" }
>;
type ContinueTaskCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "task.continue" }
>;

type TaskSessionContext =
  | { handle: PiSessionHandle; task?: undefined }
  | { handle: TaskHandle; task: TaskHandle };

export interface PiSubagentRuntimeOptions {
  sessions: ReadonlyMap<string, PiSessionHandle>;
  emit: WorkerEmitter;
  loadPiSdk: () => Promise<PiSdk>;
  toolGateway: PiToolGateway;
  modelCatalog: PiModelCatalogRuntime;
  createResourceLoader: PiResourceLoaderFactory;
  onPiEvent: (sessionId: string, event: unknown) => Promise<void>;
  getRespectGitignore: () => boolean;
  getQuestionTimeoutPolicy: () => AgentQuestionTimeoutPolicy | undefined;
  getSubagentPolicies: () => AgentSubagentPolicyManifest;
  tools: AgentProtocolCapabilities["tools"];
}

const MAX_TASK_OUTPUT_CHARS = 1_000_000;

const appendTaskOutput = (current: string, next: string): string => {
  if (!next) return current;
  const combined = current + next;
  return combined.length <= MAX_TASK_OUTPUT_CHARS
    ? combined
    : combined.slice(combined.length - MAX_TASK_OUTPUT_CHARS);
};

/**
 * Owns Pi child-session identity, task hierarchy, durable resume records,
 * background control and child-session teardown. The adapter retains root
 * session ownership and the public worker command/event boundary.
 */
export class PiSubagentRuntime {
  private readonly tasks = new Map<string, TaskHandle>();
  private readonly continuingTasks = new Set<string>();
  private readonly sessions: ReadonlyMap<string, PiSessionHandle>;
  private readonly emit: WorkerEmitter;
  private readonly loadPiSdk: () => Promise<PiSdk>;
  private readonly toolGateway: PiToolGateway;
  private readonly hostTaskControl: HostTaskControl;
  private readonly modelCatalog: PiModelCatalogRuntime;
  private readonly resourceLoaderFactory: PiResourceLoaderFactory;
  private readonly handlePiEvent: (
    sessionId: string,
    event: unknown,
  ) => Promise<void>;
  private readonly getRespectGitignore: () => boolean;
  private readonly getQuestionTimeoutPolicy: () =>
    AgentQuestionTimeoutPolicy | undefined;
  private readonly getSubagentPolicies: () => AgentSubagentPolicyManifest;
  private readonly tools: AgentProtocolCapabilities["tools"];
  public readonly taskController: PiTaskController;

  public constructor(options: PiSubagentRuntimeOptions) {
    this.sessions = options.sessions;
    this.emit = options.emit;
    this.loadPiSdk = options.loadPiSdk;
    this.toolGateway = options.toolGateway;
    this.hostTaskControl = new HostTaskControl({
      toolGateway: options.toolGateway,
      contextForSession: (sessionId) =>
        this.contextForSession(sessionId)?.handle,
    });
    this.modelCatalog = options.modelCatalog;
    this.resourceLoaderFactory = options.createResourceLoader;
    this.handlePiEvent = options.onPiEvent;
    this.getRespectGitignore = options.getRespectGitignore;
    this.getQuestionTimeoutPolicy = options.getQuestionTimeoutPolicy;
    this.getSubagentPolicies = options.getSubagentPolicies;
    this.tools = options.tools;
    this.taskController = {
      wait: (input) => this.waitTasksForSession(input),
      cancel: (input) => this.cancelTaskForSession(input),
    };
  }

  public get taskCount(): number {
    return this.tasks.size;
  }

  public sessionContextFor(sessionId: string): PiSessionContext | undefined {
    return this.contextForSession(sessionId)?.handle;
  }

  private contextForSession(sessionId: string): TaskSessionContext | undefined {
    const root = this.sessions.get(sessionId);
    if (root) return { handle: root };
    for (const task of this.tasks.values()) {
      if (task.childSessionId === sessionId) return { handle: task, task };
    }
    return undefined;
  }

  private get respectGitignore(): boolean {
    return this.getRespectGitignore();
  }

  private get questionTimeoutPolicy(): AgentQuestionTimeoutPolicy | undefined {
    return this.getQuestionTimeoutPolicy();
  }

  private get subagentPolicies(): AgentSubagentPolicyManifest {
    return this.getSubagentPolicies();
  }

  private createResourceLoader(
    pi: PiSdk,
    cwd: string,
    getSessionMode: () => string,
    getCapabilityMode: () => PiSubagentCapabilityMode = () => "all",
    getTokenUsage?: () => number | undefined,
  ) {
    return this.resourceLoaderFactory(
      pi,
      cwd,
      getSessionMode,
      getCapabilityMode,
      getTokenUsage,
    );
  }

  public observePiEvent(
    sessionId: string,
    input: {
      mappedEvent?: {
        type: string;
        text?: string;
        role?: string;
        content?: string;
      };
      settled?: boolean;
      runError?: AgentError;
    },
  ): void {
    const task = this.contextForSession(sessionId)?.task;
    if (!task) return;
    const event = input.mappedEvent;
    if (event?.type === "message.delta" && event.text) {
      task.output = appendTaskOutput(task.output, event.text);
    } else if (
      event?.type === "message.completed" &&
      event.role === "assistant" &&
      event.content
    ) {
      task.output = appendTaskOutput("", event.content);
    }
    if (input.settled && task.status === "running") {
      task.status = input.runError ? "failed" : "completed";
      if (input.runError && !task.output) {
        task.output = input.runError.message;
      }
    }
  }

  public async refreshModelSettingsForLiveSessions(): Promise<void> {
    const tasks = [...this.tasks.values()].filter(
      (task) => task.status === "running",
    );
    await Promise.all(
      tasks
        .filter((task) => task.runFinished)
        .map((task) => task.refreshModelSettings?.()),
    );
  }

  public async refreshResources(
    manifest: AgentResourceManifest,
  ): Promise<string[]> {
    const tasks = [...this.tasks.values()];
    const failures: string[] = [];
    await Promise.all(
      tasks
        .filter((task) => task.status === "running" && task.runFinished)
        .map(async (task) => {
          try {
            await task.refreshResources?.(manifest);
          } catch (error) {
            failures.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
    );
    return failures;
  }

  public async cancelForRootSession(rootSessionId: string): Promise<void> {
    const tasks = [...this.tasks.values()].filter(
      (task) => task.rootSessionId === rootSessionId,
    );
    await Promise.all(tasks.map((task) => task.cancel()));
  }

  public async closeAll(): Promise<void> {
    const remainingTasks = [...this.tasks.values()];
    await Promise.all(
      remainingTasks.map(async (task) => {
        if (task.status === "running") {
          await task.cancel().catch(() => undefined);
        }
        await task.promise.catch(() => undefined);
      }),
    );
    this.tasks.clear();
  }

  private taskSnapshot(task: TaskHandle): PiTaskSnapshot {
    return {
      taskId: task.taskId,
      status: task.status,
      ...(task.output ? { output: task.output } : {}),
      childSessionId: task.childSessionId,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      ...(task.role ? { role: task.role } : {}),
      ...(task.persona ? { persona: task.persona } : {}),
      ...(task.agent ? { agent: task.agent } : {}),
      ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
      isolation: task.isolation,
      ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
    };
  }

  private async emitTaskCommandResult(
    task: TaskHandle,
    sessionId: string,
    requestId: string | number,
  ): Promise<void> {
    await this.emit({
      requestId,
      sessionId,
      event: {
        type: "task.changed",
        taskId: task.taskId,
        status: task.status,
        childSessionId: task.childSessionId,
        payload: {
          output: task.output,
          subagentType: task.subagentType,
          ...(task.role ? { role: task.role } : {}),
          ...(task.persona ? { persona: task.persona } : {}),
          ...(task.agent ? { agent: task.agent } : {}),
          capabilityMode: task.capabilityMode,
          permissionMode: task.permissionMode,
          isolation: task.isolation,
        },
      },
    });
  }

  private async loadPersistedSubagent(
    taskId: string,
  ): Promise<PersistedPiSubagent | undefined> {
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    if (!sessionRoot) return undefined;
    const result = await loadPiSubagentRecord(sessionRoot, taskId);
    if (result.kind === "missing") return undefined;
    if (result.kind === "unavailable") {
      throw fail(
        "pi.resume_record_unavailable",
        `读取 Pi 子代理恢复记录失败：${result.message}`,
        "run",
      );
    }
    if (result.kind === "invalid") {
      throw fail(
        "pi.resume_record_invalid",
        `Pi 子代理恢复记录无效：${result.message}`,
        "run",
      );
    }
    return result.record;
  }

  private async persistSubagentRecord(task: TaskHandle): Promise<void> {
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    const sessionFile = task.sessionFile;
    if (!sessionRoot || !sessionFile) return;
    const record: PersistedPiSubagent = {
      taskId: task.taskId,
      rootSessionId: task.rootSessionId,
      parentSessionId: task.parentSessionId,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      subagentType: task.subagentType,
      ...(task.role ? { role: task.role } : {}),
      ...(task.persona ? { persona: task.persona } : {}),
      ...(task.agent ? { agent: task.agent } : {}),
      capabilityMode: task.capabilityMode,
      permissionMode: task.permissionMode,
      isolation: task.isolation,
      ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
      ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
      sessionFile,
      cwd: task.session.sessionManager.getCwd(),
      ...(task.modelId ? { modelId: task.modelId } : {}),
      reasoningEffort: task.reasoningEffort,
      status: task.status,
      ...(task.output ? { output: task.output.slice(-64 * 1024) } : {}),
      updatedAt: Date.now(),
    };
    // SessionManager can allocate a path before the first transcript flush;
    // the record store skips saving until the JSONL exists as a regular file.
    await savePiSubagentRecord(sessionRoot, record);
  }

  /**
   * A root session may inspect all of its descendants. A child session may
   * only inspect itself or tasks nested below it; this prevents a model from
   * using an otherwise valid task id to observe a sibling session.
   */
  private taskVisibleToSession(task: TaskHandle, sessionId: string): boolean {
    const context = this.contextForSession(sessionId);
    if (!context || task.rootSessionId !== context.handle.rootSessionId) {
      return false;
    }
    if (!context.task) return true;
    let current: TaskHandle | undefined = task;
    while (current) {
      if (current.taskId === context.task.taskId) return true;
      current = current.parentTaskId
        ? this.tasks.get(current.parentTaskId)
        : undefined;
    }
    return false;
  }

  private taskForController(taskId: string, sessionId: string): TaskHandle {
    const normalized = taskId.trim();
    const task = normalized ? this.tasks.get(normalized) : undefined;
    if (!task || !this.taskVisibleToSession(task, sessionId)) {
      throw fail(
        "pi.task_not_found",
        `找不到可由当前会话访问的后台任务：${taskId}。`,
        "run",
      );
    }
    return task;
  }

  private taskListForController(
    taskIds: readonly string[],
    sessionId: string,
  ): TaskHandle[] {
    const normalized = [...new Set(taskIds.map((taskId) => taskId.trim()))];
    if (normalized.length === 0 || normalized.some((taskId) => !taskId)) {
      throw fail("pi.task_ids_invalid", "后台任务 ID 列表不能为空。", "run");
    }
    if (normalized.length > 20) {
      throw fail("pi.task_ids_too_many", "一次最多等待 20 个后台任务。", "run");
    }
    return normalized.map((taskId) =>
      this.taskForController(taskId, sessionId),
    );
  }

  private async waitTasksForSession(input: {
    taskIds: string[];
    mode: "wait_any" | "wait_all";
    timeoutMs: number;
    parentSessionId: string;
  }): Promise<readonly PiTaskSnapshot[]> {
    if (input.mode !== "wait_any" && input.mode !== "wait_all") {
      throw fail(
        "pi.task_wait_mode_invalid",
        `不支持的后台任务等待模式：${input.mode}。`,
        "run",
      );
    }
    const normalized = [
      ...new Set(input.taskIds.map((taskId) => taskId.trim())),
    ];
    if (normalized.length === 0 || normalized.some((taskId) => !taskId)) {
      throw fail("pi.task_ids_invalid", "后台任务 ID 列表不能为空。", "run");
    }
    if (normalized.length > 20) {
      throw fail("pi.task_ids_too_many", "一次最多等待 20 个后台任务。", "run");
    }
    const timeoutMs = Math.max(
      0,
      Math.min(
        120_000,
        Number.isFinite(input.timeoutMs) ? Math.trunc(input.timeoutMs) : 0,
      ),
    );
    const hostTasks = normalized.filter((taskId) =>
      isHostBackgroundTaskId(taskId),
    );
    if (hostTasks.length > 0) {
      if (hostTasks.length !== normalized.length) {
        throw fail(
          "pi.task_scope_mixed",
          "一次等待不能混合 Host 终端任务和 Pi 子代理任务。",
          "run",
        );
      }
      return this.hostTaskControl.request(
        input.parentSessionId,
        PI_WAIT_COMMANDS_OR_SUBAGENTS,
        {
          task_ids: normalized,
          mode: input.mode,
          timeout_ms: timeoutMs,
        },
      );
    }
    const tasks = this.taskListForController(normalized, input.parentSessionId);
    if (timeoutMs > 0 && tasks.some((task) => task.status === "running")) {
      const completion = tasks.map((task) =>
        task.promise.catch(() => ({ output: task.output })),
      );
      const target =
        input.mode === "wait_all"
          ? Promise.all(completion)
          : Promise.race(completion);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          target,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return tasks.map((task) => this.taskSnapshot(task));
  }

  private async cancelTaskForSession(input: {
    taskId: string;
    parentSessionId: string;
  }): Promise<PiTaskSnapshot> {
    if (isHostBackgroundTaskId(input.taskId)) {
      const snapshots = await this.hostTaskControl.request(
        input.parentSessionId,
        PI_KILL_COMMAND_OR_SUBAGENT,
        { task_id: input.taskId.trim() },
      );
      const snapshot = snapshots[0];
      if (!snapshot) {
        throw fail(
          "pi.host_task_response_invalid",
          "宿主没有返回被取消的后台终端任务。",
          "run",
        );
      }
      return snapshot;
    }
    const task = this.taskForController(input.taskId, input.parentSessionId);
    await task.cancel();
    await task.promise.catch(() => undefined);
    return this.taskSnapshot(task);
  }

  public async waitTask(
    command: TaskCommand,
    requestId: string | number,
  ): Promise<void> {
    const task = this.tasks.get(command.taskId);
    if (!task || task.rootSessionId !== command.sessionId) {
      throw fail(
        "pi.task_not_found",
        `找不到后台任务：${command.taskId}。`,
        "run",
      );
    }
    await task.promise;
    await this.emitTaskCommandResult(task, command.sessionId, requestId);
  }

  public async cancelTask(
    command: TaskCommand,
    requestId: string | number,
  ): Promise<void> {
    const task = this.tasks.get(command.taskId);
    if (!task || task.rootSessionId !== command.sessionId) {
      throw fail(
        "pi.task_not_found",
        `找不到后台任务：${command.taskId}。`,
        "run",
      );
    }
    await task.cancel();
    await task.promise.catch(() => undefined);
    await this.emitTaskCommandResult(task, command.sessionId, requestId);
  }

  public async continueTask(
    command: ContinueTaskCommand,
    _requestId: string | number,
  ): Promise<void> {
    if (this.continuingTasks.has(command.taskId)) {
      throw fail(
        "pi.child_continue_running",
        "该 Pi 子会话正在启动续接请求，请稍后再试。",
        "run",
      );
    }
    if (!this.sessions.has(command.sessionId)) {
      throw fail(
        "pi.session_not_found",
        `Pi 根会话不存在：${command.sessionId}。`,
        "session",
      );
    }
    this.continuingTasks.add(command.taskId);
    try {
      const candidate =
        this.tasks.get(command.taskId) ??
        (await this.loadPersistedSubagent(command.taskId));
      assertPiInteractiveChildTarget(
        command.taskId,
        candidate,
        command.sessionId,
      );
      await this.spawnSubagent({
        task: command.content,
        resumeFrom: command.taskId,
        parentSessionId: command.sessionId,
        background: true,
        continueExisting: true,
      });
    } finally {
      this.continuingTasks.delete(command.taskId);
    }
  }

  public async spawnSubagent(input: {
    task: string;
    continueExisting?: boolean;
    resumeFrom?: string;
    subagentType?: string;
    role?: string;
    persona?: string;
    agent?: string;
    capabilityMode?: string;
    cwd?: string;
    isolation?: string;
    modelId?: string;
    reasoningEffort?: string;
    background: boolean;
    parentSessionId: string;
  }): Promise<{ taskId: string; output?: string; worktreePath?: string }> {
    const parentContext = this.contextForSession(input.parentSessionId);
    if (!parentContext) {
      throw fail(
        "pi.session_not_found",
        `Pi session 不存在：${input.parentSessionId}。`,
        "session",
      );
    }
    const parent = parentContext.handle;
    const parentTaskId = parentContext.task?.taskId;
    const rootSessionId = parent.rootSessionId;
    const resumeFrom = normalizePiResumeFrom(input.resumeFrom);
    const inMemoryResumeTask = resumeFrom
      ? this.tasks.get(resumeFrom)
      : undefined;
    const resumeTask =
      inMemoryResumeTask ??
      (resumeFrom ? await this.loadPersistedSubagent(resumeFrom) : undefined);
    if (resumeFrom) {
      assertPiResumeTarget(resumeFrom, resumeTask, rootSessionId);
      assertPiResumeScope(resumeTask, input.parentSessionId, parentTaskId);
      assertPiResumeIdentity(resumeTask, input);
      if (this.continuingTasks.has(resumeFrom) && !input.continueExisting) {
        throw fail(
          "pi.resume_running",
          "该 Pi 子会话正在接受用户续接请求，请等待本轮完成。",
          "run",
        );
      }
    }
    const launchPolicy = resolvePiSubagentLaunchPolicy({
      manifest: this.subagentPolicies,
      request: input,
      parent: {
        capabilityMode: parent.capabilityMode,
        permissionMode: parent.permissionMode,
        ...(parent.mcpTools ? { mcpTools: parent.mcpTools } : {}),
        ...(parent.modelId ? { modelId: parent.modelId } : {}),
        reasoningEffort: parent.reasoningEffort,
      },
      ...(resumeTask
        ? {
            resume: {
              subagentType: resumeTask.subagentType,
              ...(resumeTask.role ? { role: resumeTask.role } : {}),
              ...(resumeTask.persona ? { persona: resumeTask.persona } : {}),
              ...(resumeTask.agent ? { agent: resumeTask.agent } : {}),
              capabilityMode: resumeTask.capabilityMode,
              isolation: resumeTask.isolation,
              mcpTools: Array.from(resumeTask.mcpTools ?? []),
              permissionMode: resumeTask.permissionMode,
              ...(resumeTask.modelId ? { modelId: resumeTask.modelId } : {}),
              reasoningEffort: resumeTask.reasoningEffort,
            },
          }
        : {}),
    });
    const {
      subagentType,
      role,
      persona,
      agent,
      isolation,
      capabilityMode,
      permissionMode,
      mcpTools,
      requestedModelId,
      requestedReasoningEffort,
      policyResolution,
    } = launchPolicy;
    const runningTasks = [...this.tasks.values()].filter(
      (task) => task.status === "running",
    ).length;
    if (runningTasks >= 16) {
      throw fail(
        "pi.task_limit",
        "同时运行的 Pi 子任务不能超过 16 个。",
        "run",
      );
    }
    // Completed task handles remain addressable until the UI calls wait/cancel,
    // but must not grow without bound during a long-lived desktop session.
    for (const [id, task] of this.tasks) {
      if (task.status !== "running" && this.tasks.size > 64) {
        this.tasks.delete(id);
      }
    }
    const pi = await this.loadPiSdk();
    const taskId =
      input.continueExisting && resumeTask
        ? resumeTask.taskId
        : `${rootSessionId}:task:${randomUUID()}`;
    const childSessionId = `${taskId}:session`;
    const promptId = input.continueExisting
      ? `${taskId}:continue:${randomUUID()}`
      : taskId;
    const runId = input.continueExisting ? `${promptId}:run` : `${taskId}:run`;
    const runtime = await this.modelCatalog.getModelRuntime();
    const parentCwd = parent.session.sessionManager.getCwd();
    const rootHandle = this.sessions.get(rootSessionId);
    const workspaceRoot =
      rootHandle?.session.sessionManager.getCwd() ?? parentCwd;
    // A resumed child keeps the source session's cwd/worktree. For a fresh
    // child, an explicit cwd is allowed only inside the authenticated root;
    // omitting it preserves the parent's current directory.
    const resumeCwd = resumeTask
      ? "session" in resumeTask
        ? resumeTask.session.sessionManager.getCwd()
        : resumeTask.cwd
      : undefined;
    let cwd = resumeCwd
      ? (normalizePiSubagentCwd(resumeCwd, parentCwd, workspaceRoot) ??
        parentCwd)
      : (normalizePiSubagentCwd(input.cwd, parentCwd, workspaceRoot) ??
        parentCwd);
    let worktreePath = resumeTask?.worktreePath;
    if (!resumeTask && isolation === "worktree") {
      const resolution = await this.toolGateway.request({
        sessionId: input.parentSessionId,
        rootSessionId,
        runId: parent.runId,
        cwd: parentCwd,
        toolCallId: `pi-worktree:${randomUUID()}`,
        toolName: PI_CREATE_SUBAGENT_WORKTREE,
        arguments: { task_id: taskId },
        permissionMode: parent.permissionMode,
        // The user explicitly selected isolation on the model-facing tool;
        // Host still validates the workspace and keeps the operation off the
        // generic shell/file gateway.
        approved: true,
      });
      if (resolution.status !== "completed") {
        throw fail(
          resolution.error?.code ?? "pi.subagent_worktree_failed",
          resolution.error?.message ?? "宿主无法创建 Pi 子代理 worktree。",
          resolution.error?.scope ?? "run",
        );
      }
      worktreePath = parsePiWorktreeResponse(resolution.output ?? "");
      cwd =
        normalizePiSubagentCwd(worktreePath, parentCwd, workspaceRoot) ??
        (() => {
          throw fail(
            "pi.subagent_worktree_scope_denied",
            "宿主返回的子代理 worktree 不在当前项目工作区内。",
            "run",
          );
        })();
    }
    // Resuming pins the source model and reasoning level. This mirrors
    // Melody-build and prevents a caller from silently changing provider
    // state while continuing the child's own transcript.
    const model = resumeTask
      ? resumeTask.modelId
        ? await this.modelCatalog.resolveModel(resumeTask.modelId)
        : "session" in resumeTask
          ? (resumeTask.session.model ?? undefined)
          : undefined
      : requestedModelId
        ? await this.modelCatalog.resolveModel(requestedModelId)
        : (parent.session.model ?? undefined);
    const requestedThinkingLevel = normalizeThinkingLevel(
      requestedReasoningEffort,
    );
    const resourceBinding = await this.createResourceLoader(
      pi,
      cwd,
      () =>
        this.contextForSession(childSessionId)?.handle.sessionModeId ??
        parent.sessionModeId,
      () =>
        this.contextForSession(childSessionId)?.handle.capabilityMode ??
        capabilityMode,
      () =>
        this.contextForSession(childSessionId)?.handle.session.getSessionStats()
          .tokens.total,
    );
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    // Keep the property check adjacent to the open call. TypeScript cannot
    // carry an assertion-function refinement through the conditional task
    // lookup, while this explicit guard documents the same invariant for the
    // runtime as well.
    if (resumeFrom && !resumeTask?.sessionFile) {
      throw fail(
        "pi.resume_unavailable",
        "该 Pi 子代理没有可恢复的持久化会话；请重新启动一个子代理。",
        "run",
      );
    }
    const sessionManager = resumeTask?.sessionFile
      ? pi.SessionManager.open(
          resumeTask.sessionFile,
          sessionRoot ?? dirname(resumeTask.sessionFile),
          cwd,
        )
      : sessionRoot
        ? pi.SessionManager.create(cwd, sessionRoot, {
            // Product-facing stream IDs contain separators that Pi's native
            // JSONL session ID intentionally does not accept.
            id: randomUUID(),
            parentSession:
              parent.session.sessionManager.getSessionFile() ??
              parent.nativeSessionId,
          })
        : pi.SessionManager.inMemory(cwd, {
            id: randomUUID(),
            parentSession: parent.nativeSessionId,
          });
    const { session } = await pi.createAgentSession({
      cwd,
      model,
      modelRuntime: runtime,
      resourceLoader: resourceBinding.loader,
      settingsManager: pi.SettingsManager.inMemory(
        await this.modelCatalog.settingsOverridesForModel(model),
      ),
      ...(requestedThinkingLevel
        ? { thinkingLevel: requestedThinkingLevel }
        : {}),
      sessionManager,
      customTools: this.toolGateway.createTools(
        () => childSessionId,
        () => this.contextForSession(childSessionId)?.handle.runId,
        () =>
          this.contextForSession(childSessionId)?.handle.permissionMode ??
          parent.permissionMode,
        () =>
          this.contextForSession(
            childSessionId,
          )?.handle.session.sessionManager.getCwd() ?? cwd,
        (nested) => this.spawnSubagent(nested),
        () => rootSessionId,
        () =>
          this.contextForSession(childSessionId)?.handle.sessionModeId ??
          parent.sessionModeId,
        this.taskController,
        () => this.respectGitignore,
        () => this.questionTimeoutPolicy,
        () => capabilityMode,
        () =>
          this.contextForSession(childSessionId)?.handle.mcpTools ?? mcpTools,
        resourceBinding.activateScopedInstructions,
      ),
      noTools: "builtin",
      tools: this.tools,
    });
    const task: TaskHandle = {
      taskId,
      parentSessionId: input.parentSessionId,
      ...(parentTaskId ? { parentTaskId } : {}),
      subagentType,
      ...(role ? { role } : {}),
      ...(persona ? { persona } : {}),
      ...(agent ? { agent } : {}),
      isolation,
      permissionMode,
      ...(worktreePath ? { worktreePath } : {}),
      ...(resumeFrom ? { resumedFrom: resumeFrom } : {}),
      childSessionId,
      ...(session.sessionManager.getSessionFile()
        ? { sessionFile: session.sessionManager.getSessionFile() }
        : {}),
      session,
      refreshResources: async (manifest) => {
        resourceBinding.refreshPaths(manifest);
        if (!session.isStreaming) await session.reload();
      },
      refreshModelSettings: async () => {
        if (session.isStreaming) return;
        applyModelPolicyOverrides(
          session.settingsManager,
          await this.modelCatalog.settingsOverridesForModel(session.model),
        );
      },
      nativeSessionId: session.sessionId,
      rootSessionId,
      streamSessionId: childSessionId,
      runId,
      promptId,
      runFinished: false,
      nextMessage: 0,
      offsets: new Map(),
      activeMessageIds: new Map(),
      eventTail: Promise.resolve(),
      sessionModeId: parent.sessionModeId,
      capabilityMode,
      ...(mcpTools ? { mcpTools } : {}),
      ...(modelIdForSession(session, requestedModelId)
        ? { modelId: modelIdForSession(session, requestedModelId) }
        : {}),
      reasoningEffort: effectiveThinkingLevelForSession(
        session,
        requestedThinkingLevel,
      ),
      configRevision: 0,
      promise: Promise.resolve({ output: "" }),
      unsubscribe: () => undefined,
      cancel: async () => undefined,
      output: "",
      status: "running",
    };
    this.tasks.set(taskId, task);
    startPiSubagentTaskLifecycle({
      task,
      initialPrompt: input.task,
      resolvePrompt: () =>
        resumeTask
          ? input.task
          : composePiSubagentPrompt(policyResolution!, input.task),
      emit: this.emit,
      observePiEvent: this.handlePiEvent,
      persistRecord: (preparedTask) => this.persistSubagentRecord(preparedTask),
    });
    if (input.background) {
      return { taskId, ...(worktreePath ? { worktreePath } : {}) };
    }
    const result = await task.promise;
    return {
      taskId,
      output: result.output,
      ...(worktreePath ? { worktreePath } : {}),
    };
  }
}
