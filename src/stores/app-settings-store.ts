import { create } from "zustand";
import { persist } from "zustand/middleware";

export type UpdateChannel = "stable" | "beta";

export interface AppSettings {
  theme: "system" | "light" | "dark";
  lightAccent: string;
  lightBackground: string;
  lightForeground: string;
  darkAccent: string;
  darkBackground: string;
  darkForeground: string;
  uiFont: string;
  codeFont: string;
  translucentSidebar: boolean;
  pointerCursor: boolean;
  reducedMotion: "system" | "on" | "off";
  uiFontSize: number;
  codeFontSize: number;
  diffMarker: "color" | "sign";
  fontSmoothing: boolean;
  defaultPermissionMode: "ask" | "auto" | "always-approve";
  autoCheckForUpdates: boolean;
  updateChannel: UpdateChannel;
  defaultFileOpener: "system" | "vscode" | "cursor";
  language: "auto" | "zh-CN" | "en";
  showInMenuBar: boolean;
  showBottomPanel: boolean;
  terminalPosition: "bottom" | "right";
  preventSystemSleep: boolean;
  suggestions: boolean;
  showContextUsage: boolean;
  sendShortcut: "enter" | "mod-enter";
  followUpBehavior: "queue" | "steer";
  popupShortcut: string;
  allowUntitledTasks: boolean;
  completionNotification: "unfocused" | "always" | "never";
  permissionNotifications: boolean;
  questionNotifications: boolean;
}

interface AppSettingsStore extends AppSettings {
  setSetting: <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key],
  ) => void;
}

const defaultSettings: AppSettings = {
  theme: "system",
  lightAccent: "#339cff",
  lightBackground: "#ffffff",
  lightForeground: "#1a1c1f",
  darkAccent: "#339cff",
  darkBackground: "#181818",
  darkForeground: "#ffffff",
  uiFont:
    '"Geist Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  codeFont:
    'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  translucentSidebar: true,
  pointerCursor: false,
  reducedMotion: "system",
  uiFontSize: 16,
  codeFontSize: 12,
  diffMarker: "color",
  fontSmoothing: true,
  defaultPermissionMode: "ask",
  autoCheckForUpdates: true,
  updateChannel: "stable",
  defaultFileOpener: "vscode",
  language: "auto",
  showInMenuBar: true,
  showBottomPanel: true,
  terminalPosition: "bottom",
  preventSystemSleep: true,
  suggestions: true,
  showContextUsage: true,
  sendShortcut: "enter",
  followUpBehavior: "queue",
  popupShortcut: "",
  allowUntitledTasks: false,
  completionNotification: "unfocused",
  permissionNotifications: true,
  questionNotifications: true,
};

export const useAppSettingsStore = create<AppSettingsStore>()(
  persist(
    (set) => ({
      ...defaultSettings,
      setSetting: (key, value) => set({ [key]: value }),
    }),
    {
      name: "melodywork.app-settings",
      merge: (persistedState, currentState) => {
        const persistedSettings = {
          ...((persistedState ?? {}) as Record<string, unknown>),
        };
        for (const key of [
          "dockIcon",
          "defaultPermission",
          "autoReview",
          "lightContrast",
          "darkContrast",
        ]) {
          Reflect.deleteProperty(persistedSettings, key);
        }
        const legacyFullAccess = persistedSettings.fullAccess;
        Reflect.deleteProperty(persistedSettings, "fullAccess");
        if (typeof persistedSettings.uiFontSize === "number") {
          persistedSettings.uiFontSize = Math.min(
            18,
            Math.max(14, persistedSettings.uiFontSize),
          );
        }
        return {
          ...currentState,
          ...persistedSettings,
          defaultPermissionMode:
            persistedSettings.defaultPermissionMode === "auto" ||
            persistedSettings.defaultPermissionMode === "always-approve" ||
            persistedSettings.defaultPermissionMode === "ask"
              ? persistedSettings.defaultPermissionMode
              : legacyFullAccess === true
                ? "always-approve"
                : currentState.defaultPermissionMode,
          updateChannel:
            persistedSettings.updateChannel === "stable" ||
            persistedSettings.updateChannel === "beta"
              ? persistedSettings.updateChannel
              : currentState.updateChannel,
        } as AppSettingsStore;
      },
      partialize: (settings) => {
        const partial = { ...settings };
        Reflect.deleteProperty(partial, "setSetting");
        return partial;
      },
    },
  ),
);
