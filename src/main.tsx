import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import App from "./App";
import "./index.css";

function Root() {
  const reducedMotion = useAppSettingsStore((state) => state.reducedMotion);
  const motionPreference =
    reducedMotion === "on"
      ? "always"
      : reducedMotion === "off"
        ? "never"
        : "user";

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
