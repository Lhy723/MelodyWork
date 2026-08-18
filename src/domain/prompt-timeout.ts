export interface PromptLifecycle {
  createdAt: number;
  firstEventAt?: number;
  responseReceivedAt?: number;
}

export const markPromptStarted = <T extends PromptLifecycle>(
  prompt: T,
  at: number,
): T =>
  prompt.firstEventAt === undefined ? { ...prompt, firstEventAt: at } : prompt;

export const markPromptResponseReceived = <T extends PromptLifecycle>(
  prompt: T,
  at: number,
): T =>
  prompt.responseReceivedAt === undefined
    ? { ...prompt, responseReceivedAt: at }
    : prompt;

export type PromptResponseDisposition = "accepted" | "failed" | "duplicate";

export const promptResponseDisposition = (
  hasError: boolean,
  responseReceived: boolean,
): PromptResponseDisposition => {
  if (responseReceived) {
    return "duplicate";
  }
  return hasError ? "failed" : "accepted";
};

export const shouldCancelBeforeFirstEvent = (
  prompt: PromptLifecycle,
  now: number,
  timeoutMs: number,
): boolean =>
  prompt.firstEventAt === undefined && now - prompt.createdAt >= timeoutMs;
