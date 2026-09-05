import React from "react";
import ReactDOM from "react-dom/client";
import { useEffect } from "react";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  isTauriRuntime,
  setMenuBarVisibility,
  setSystemSleepPrevention,
} from "@/lib/melody-bridge";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import App from "./App";
import "./index.css";

function Root() {
  const reducedMotion = useAppSettingsStore((state) => state.reducedMotion);
  const showInMenuBar = useAppSettingsStore((state) => state.showInMenuBar);
  const preventSystemSleep = useAppSettingsStore(
    (state) => state.preventSystemSleep,
  );
  const motionPreference =
    reducedMotion === "on"
      ? "always"
      : reducedMotion === "off"
        ? "never"
        : "user";

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    void setMenuBarVisibility(showInMenuBar).catch(() => undefined);
  }, [showInMenuBar]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    void setSystemSleepPrevention(preventSystemSleep).catch(() => undefined);
  }, [preventSystemSleep]);

  return (
    <MotionConfig reducedMotion={motionPreference}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </MotionConfig>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
