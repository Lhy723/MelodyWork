import type { AgentSessionModeOption } from "@/domain/acp";

export interface AgentSessionModeState {
  availableSessionModes: AgentSessionModeOption[];
  selectedSessionModeId?: string;
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const sessionModeState = (
  result: Record<string, unknown> | undefined,
): AgentSessionModeState | undefined => {
  const modes = objectValue(result?.modes);
  if (!modes) {
    return undefined;
  }
  const availableSessionModes = Array.isArray(modes.availableModes)
    ? modes.availableModes.flatMap((raw) => {
        const mode = objectValue(raw);
        const id = stringValue(mode?.id);
        if (!id) {
          return [];
        }
        return [
          {
            id,
            name: stringValue(mode?.name) ?? id,
            description: stringValue(mode?.description),
          },
        ];
      })
    : [];
  const selectedSessionModeId = stringValue(modes.currentModeId);
  return {
    availableSessionModes,
    selectedSessionModeId,
  };
};

export const sessionModeIdFromUpdate = (
  update: Record<string, unknown> | undefined,
): string | undefined =>
  update?.sessionUpdate === "current_mode_update"
    ? stringValue(update.currentModeId)
    : undefined;
