import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { isTauriRuntime } from "@/lib/melody-bridge";

export async function requestSystemNotificationPermission(): Promise<boolean> {
  if (isTauriRuntime()) {
    if (await isPermissionGranted()) {
      return true;
    }
    return (await requestPermission()) === "granted";
  }
  if (!("Notification" in window)) {
    return false;
  }
  if (Notification.permission === "granted") {
    return true;
  }
  return (await Notification.requestPermission()) === "granted";
}

export async function sendSystemNotification(
  title: string,
  body: string,
): Promise<boolean> {
  if (!(await requestSystemNotificationPermission())) {
    return false;
  }
  if (isTauriRuntime()) {
    sendNotification({ title, body });
  } else {
    new Notification(title, { body });
  }
  return true;
}
