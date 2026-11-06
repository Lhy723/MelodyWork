import type { AgentCommandEnvelope } from "@melody/agent-contract";
import type { WorkerEmitter } from "../protocol.ts";
import {
  normalizePiResourcePolicySnapshot,
  type PiResourcePolicySnapshot,
} from "./resource-policy-snapshot.ts";
import { fail } from "./session-errors.ts";
import type { PiSessionHandle } from "./session-runtime-types.ts";
import type { PiSubagentRuntime } from "./subagent-runtime.ts";

type RefreshCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "session.resources.refresh" }
>;

interface PiSessionResourceRefreshDependencies {
  sessions: Map<string, PiSessionHandle>;
  enqueueLifecycle: <T>(
    sessionId: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  subagents: Pick<PiSubagentRuntime, "taskCount" | "refreshResources">;
  applyPolicySnapshot: (snapshot: PiResourcePolicySnapshot) => void;
  emit: WorkerEmitter;
}

/**
 * Own Host resource refresh across root and child sessions: validate and
 * publish one policy snapshot, serialize idle root reloads, refresh idle
 * children, and emit a single bounded success/failure result.
 */
export class PiSessionResourceRefreshRuntime {
  private readonly dependencies: PiSessionResourceRefreshDependencies;

  public constructor(dependencies: PiSessionResourceRefreshDependencies) {
    this.dependencies = dependencies;
  }

  public async refresh(
    command: RefreshCommand,
    requestId: string | number,
  ): Promise<void> {
    const cwd = command.manifest.cwd;
    const normalizedManifest = normalizePiResourcePolicySnapshot(
      cwd,
      command.manifest,
      process.env,
    );
    this.dependencies.applyPolicySnapshot(normalizedManifest);

    const rootHandles = [...this.dependencies.sessions.entries()];
    const taskCount = this.dependencies.subagents.taskCount;
    const failures: string[] = [];
    await Promise.all([
      ...rootHandles.map(([sessionId, handle]) =>
        this.dependencies.enqueueLifecycle(sessionId, async () => {
          try {
            // `isStreaming` is not a complete activity signal: Pi may be
            // paused on a host interaction between provider requests. The
            // worker-owned run state keeps reloads out of that run.
            if (!handle.runFinished) return;
            await handle.refreshResources?.(command.manifest);
          } catch (error) {
            failures.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
      ),
      this.dependencies.subagents
        .refreshResources(command.manifest)
        .then((childFailures) => failures.push(...childFailures)),
    ]);
    if (failures.length > 0) {
      throw fail(
        "pi.resource_refresh_failed",
        `Pi 资源刷新失败：${failures[0]}`,
        "session",
      );
    }
    await this.dependencies.emit({
      requestId,
      event: {
        type: "runtime.warning",
        error: {
          code: "pi.resources_refreshed",
          message: `Pi 已刷新受控 Skill/命令资源（${cwd}）。`,
          retriable: false,
          scope: "runtime",
          details: {
            sessionCount: rootHandles.length,
            taskCount,
          },
        },
      },
    });
  }
}
