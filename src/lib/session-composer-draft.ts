const draftKeyFor = (sessionId: string) => `melody:agent-draft:${sessionId}`;

export const readSessionComposerDraft = (sessionId?: string): string => {
  if (!sessionId || typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(draftKeyFor(sessionId)) ?? "";
  } catch {
    return "";
  }
};

export const writeSessionComposerDraft = (
  sessionId: string | undefined,
  value: string,
): boolean => {
  if (!sessionId || typeof window === "undefined") return false;
  try {
    if (value) window.localStorage.setItem(draftKeyFor(sessionId), value);
    else window.localStorage.removeItem(draftKeyFor(sessionId));
    return true;
  } catch {
    // Draft persistence is best-effort; it must never block normal chat input.
    return false;
  }
};
