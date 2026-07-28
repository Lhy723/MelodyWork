import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  lightContrast: number;
  darkContrast: number;
  pointerCursor: boolean;
  dockIcon: "classic" | "gradient";
  reducedMotion: "system" | "on" | "off";
  uiFontSize: number;
  codeFontSize: number;
  diffMarker: "color" | "sign";
  fontSmoothing: boolean;
  defaultPermission: boolean;
  autoReview: boolean;
  fullAccess: boolean;
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
  uiFont: '"Geist Variable", sans-serif',
  codeFont: '"SFMono-Regular", Consolas, monospace',
  translucentSidebar: true,
  lightContrast: 45,
  darkContrast: 60,
  pointerCursor: false,
  dockIcon: "classic",
  reducedMotion: "system",
  uiFontSize: 14,
  codeFontSize: 12,
  diffMarker: "color",
  fontSmoothing: true,
  defaultPermission: true,
  autoReview: true,
  fullAccess: false,
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
      partialize: ({ setSetting: _setSetting, ...settings }) => settings,
    },
  ),
);
