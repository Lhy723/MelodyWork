import {
  copyFileSync,
  constants as fsConstants,
  lstatSync,
  unlinkSync,
} from "node:fs";
import type { AgentCommandEnvelope } from "@melody/agent-contract";
import { textFromContent } from "./event-mapper.ts";
import { fail } from "./session-errors.ts";
import {
  piForkTargetMatches,
  piSessionFileFor,
  type PiForkTargetManager,
} from "./session-persistence-policy.ts";
import {
  PI_SESSION_ROOT_ENV,
  type PiSdk,
  type PiSessionHandle,
} from "./session-runtime-types.ts";

type ForkCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "session.fork" }
>;
type OpenCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "session.open" }
>;
type ForkSource = Pick<
  PiSessionHandle,
  | "session"
  | "runFinished"
  | "permissionMode"
  | "modelId"
  | "reasoningEffort"
  | "sessionModeId"
>;

interface PiSessionForkDependencies {
  getSession: (sessionId: string) => ForkSource | undefined;
  loadPiSdk: () => Promise<PiSdk>;
  openSession: (
    command: OpenCommand,
    requestId: string | number,
  ) => Promise<void>;
}

/** Validate an interrupted fork artifact before reopening it on retry. */
export const assertPiForkTargetMatches = (
  targetManager: PiForkTargetManager,
  sourcePath: string,
  anchorEntryId: string,
): void => {
  if (!piForkTargetMatches(targetManager, sourcePath, anchorEntryId)) {
    throw fail(
      "pi.fork_target_mismatch",
      "已有 Pi 分支文件与记录的源会话或锚点不一致，拒绝覆盖或打开。",
      "session",
    );
  }
};

/** Own the persisted Pi-native branch workflow behind the session command seam. */
export class PiSessionForkRuntime {
  private readonly dependencies: PiSessionForkDependencies;

  public constructor(dependencies: PiSessionForkDependencies) {
    this.dependencies = dependencies;
  }

  public async fork(
    command: ForkCommand,
    requestId: string | number,
  ): Promise<void> {
    const source = this.dependencies.getSession(command.sessionId);
    if (!source) {
      throw fail(
        "pi.fork_source_not_open",
        "请先打开要探索的 Pi 会话，再从已完成回复创建分支。",
        "session",
      );
    }
    if (!source.runFinished) {
      throw fail(
        "pi.fork_source_running",
        "会话仍在运行，暂时不能从中创建探索分支。",
        "session",
      );
    }
    if (
      command.sessionId === command.targetSessionId ||
      source.session.sessionManager.getCwd() !== command.cwd
    ) {
      throw fail(
        "pi.fork_scope_mismatch",
        "探索分支必须使用新的产品会话，并与源会话处于同一工作区。",
        "session",
      );
    }
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    if (!sessionRoot) {
      throw fail(
        "pi.fork_storage_unavailable",
        "Pi 原生会话目录尚未由 Host 配置，不能创建持久分支。",
        "session",
      );
    }

    const sourcePath = piSessionFileFor(
      sessionRoot,
      command.cwd,
      command.sessionId,
    );
    const targetPath = piSessionFileFor(
      sessionRoot,
      command.cwd,
      command.targetSessionId,
    );
    let sourceMetadata;
    try {
      sourceMetadata = lstatSync(sourcePath);
    } catch {
      throw fail(
        "pi.fork_source_missing",
        "找不到源会话的 Pi 原生记录，无法安全创建分支。",
        "session",
      );
    }
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      throw fail(
        "pi.fork_source_invalid",
        "源会话的 Pi 原生记录不是受信任的普通文件。",
        "session",
      );
    }
    let existingTarget = false;
    try {
      const targetMetadata = lstatSync(targetPath);
      if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
        throw fail(
          "pi.fork_target_invalid",
          "目标会话原生记录不是受信任的普通文件。",
          "session",
        );
      }
      existingTarget = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const pi = await this.dependencies.loadPiSdk();
    const sourceManager = pi.SessionManager.open(
      sourcePath,
      sessionRoot,
      command.cwd,
    );
    const anchor = sourceManager.getEntry(command.nativeEntryId);
    const anchorMessage =
      anchor?.type === "message" && anchor.message.role === "assistant"
        ? anchor.message
        : undefined;
    const anchorText = anchorMessage
      ? textFromContent(anchorMessage.content)
      : undefined;
    const anchorHasToolCall =
      Array.isArray(anchorMessage?.content) &&
      anchorMessage.content.some(
        (part) =>
          part !== null &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "toolCall",
      );
    if (!anchor || !anchorMessage || !anchorText?.trim() || anchorHasToolCall) {
      throw fail(
        "pi.fork_anchor_invalid",
        "只能从可验证的纯文本 assistant 回复创建探索分支。",
        "session",
      );
    }

    if (existingTarget) {
      const existingManager = pi.SessionManager.open(
        targetPath,
        sessionRoot,
        command.cwd,
      );
      assertPiForkTargetMatches(existingManager, sourcePath, anchor.id);
    } else {
      const temporaryPath = sourceManager.createBranchedSession(anchor.id);
      if (!temporaryPath) {
        throw fail(
          "pi.fork_not_persistent",
          "Pi SDK 没有生成持久分支记录。",
          "session",
        );
      }
      try {
        // COPYFILE_EXCL prevents a raced or pre-created target from being
        // overwritten. The SDK artifact is always removed afterward.
        copyFileSync(temporaryPath, targetPath, fsConstants.COPYFILE_EXCL);
      } finally {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // Preserve the primary fork error; an orphaned SDK temp file is not
          // addressable as a product session and can be safely ignored.
        }
      }
    }

    await this.dependencies.openSession(
      {
        type: "session.open",
        sessionId: command.targetSessionId,
        productSessionId: command.targetSessionId,
        cwd: command.cwd,
        permissionMode: source.permissionMode,
        ...(source.modelId ? { modelId: source.modelId } : {}),
        reasoningEffort: source.reasoningEffort,
        sessionModeId: source.sessionModeId,
      },
      requestId,
    );
  }
}
