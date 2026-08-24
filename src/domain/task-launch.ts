import type { AgentPromptAttachment } from "./acp.ts";
import type { ProjectRecord, SessionRecord } from "./workspace.ts";

export interface TaskLaunchPrompt {
  content: string;
  attachments?: AgentPromptAttachment[];
}

export interface TaskLaunchReadiness {
  activeSessionId?: string;
  agentSessionId?: string;
  ready: boolean;
}

type CreateSession = (
  project: ProjectRecord,
) => Promise<SessionRecord | undefined>;

type SubmitPrompt = (
  content: string,
  attachments?: AgentPromptAttachment[],
) => Promise<void>;

export class TaskLauncher {
  readonly #pendingBySession = new Map<string, TaskLaunchPrompt>();

  queue(sessionId: string, prompt: TaskLaunchPrompt) {
    this.#pendingBySession.set(sessionId, prompt);
  }

  async createAndQueue(
    project: ProjectRecord,
    prompt: TaskLaunchPrompt,
    createSession: CreateSession,
  ): Promise<SessionRecord | undefined> {
    const session = await createSession(project);
    if (session) {
      this.queue(session.id, prompt);
    }
    return session;
  }

  async deliverIfReady(
    readiness: TaskLaunchReadiness,
    submitPrompt: SubmitPrompt,
  ): Promise<boolean> {
    const sessionId = readiness.activeSessionId;
    if (
      !sessionId ||
      !readiness.ready ||
      readiness.agentSessionId !== sessionId
    ) {
      return false;
    }
    const prompt = this.#pendingBySession.get(sessionId);
    if (!prompt) {
      return false;
    }
    this.#pendingBySession.delete(sessionId);
    await submitPrompt(prompt.content, prompt.attachments);
    return true;
  }
}
