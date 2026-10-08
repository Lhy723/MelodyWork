import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "./melody-bridge-runtime";

export type PiBrowserElement = {
  refId: string;
  role: string;
  name: string;
  tag: string;
};

export type PiBrowserSnapshot = {
  url: string;
  title: string;
  text: string;
  elements: PiBrowserElement[];
};

export type PiBrowserScreenshot = {
  tabId: string;
  url: string;
  mimeType: "image/jpeg";
  data: string;
};

export type PiBrowserStatus = {
  sessionId: string;
  open: boolean;
  activeTabId?: string;
  tabs: PiBrowserTabStatus[];
};

export type PiBrowserTabStatus = {
  id: string;
  url?: string;
  active: boolean;
};

export type PiBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
};

export const openPiBrowser = async (
  sessionId: string,
  url?: string,
): Promise<PiBrowserStatus> => {
  if (!isTauriRuntime()) {
    throw new Error("Melody Browser 仅在桌面应用中可用。");
  }
  return invoke<PiBrowserStatus>("pi_browser_open", { sessionId, url });
};

export const navigatePiBrowser = async (
  sessionId: string,
  url: string,
): Promise<PiBrowserStatus> => {
  if (!isTauriRuntime()) {
    throw new Error("Melody Browser 仅在桌面应用中可用。");
  }
  return invoke<PiBrowserStatus>("pi_browser_navigate", { sessionId, url });
};

export const navigatePiBrowserLocalPreview = async (
  sessionId: string,
  url: string,
): Promise<PiBrowserStatus> => {
  if (!isTauriRuntime()) {
    throw new Error("本地预览仅在桌面应用中可用。");
  }
  return invoke<PiBrowserStatus>("pi_browser_navigate_local_preview", {
    sessionId,
    url,
  });
};

export const openPiBrowserTab = async (
  sessionId: string,
): Promise<PiBrowserStatus> => {
  if (!isTauriRuntime()) {
    throw new Error("Melody Browser 仅在桌面应用中可用。");
  }
  return invoke<PiBrowserStatus>("pi_browser_tab_open", { sessionId });
};

export const selectPiBrowserTab = async (
  sessionId: string,
  tabId: string,
): Promise<PiBrowserStatus> => {
  if (!isTauriRuntime()) {
    throw new Error("Melody Browser 仅在桌面应用中可用。");
  }
  return invoke<PiBrowserStatus>("pi_browser_tab_select", { sessionId, tabId });
};

export const closePiBrowserTab = async (
  sessionId: string,
  tabId: string,
): Promise<PiBrowserStatus> => {
  if (!isTauriRuntime()) {
    throw new Error("Melody Browser 仅在桌面应用中可用。");
  }
  return invoke<PiBrowserStatus>("pi_browser_tab_close", { sessionId, tabId });
};

export const setPiBrowserBounds = async (
  sessionId: string,
  tabId: string,
  bounds: PiBrowserBounds,
): Promise<void> => {
  if (!isTauriRuntime()) return;
  await invoke("pi_browser_set_bounds", { sessionId, tabId, ...bounds });
};

export const setPiBrowserPopupPolicy = async (
  sessionId: string,
  tabId: string,
  allow: boolean,
): Promise<void> => {
  if (!isTauriRuntime()) return;
  await invoke("pi_browser_set_popup_policy", { sessionId, tabId, allow });
};

export const snapshotPiBrowser = async (
  sessionId: string,
): Promise<PiBrowserSnapshot> => {
  if (!isTauriRuntime()) {
    throw new Error("Melody Browser 仅在桌面应用中可用。");
  }
  return invoke<PiBrowserSnapshot>("pi_browser_snapshot", { sessionId });
};

export const capturePiBrowserScreenshot = async (
  sessionId: string,
): Promise<PiBrowserScreenshot> => {
  if (!isTauriRuntime()) {
    throw new Error("Melody Browser 截图仅在桌面应用中可用。");
  }
  return invoke<PiBrowserScreenshot>("pi_browser_screenshot", { sessionId });
};

export const closePiBrowser = async (sessionId: string): Promise<void> => {
  if (!isTauriRuntime()) return;
  await invoke("pi_browser_close", { sessionId });
};
