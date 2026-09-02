import { useEffect } from "react";

import { isMacOSRuntime, isTauriRuntime } from "@/lib/melody-bridge";
import {
  SYSTEM_UI_FONT,
  useAppSettingsStore,
} from "@/stores/app-settings-store";

const CJK_SANS_FALLBACK =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC"';

const withCjkFallback = (font: string) => {
  if (!font.trim()) {
    return `${CJK_SANS_FALLBACK}, sans-serif`;
  }
  if (font.includes("PingFang SC")) {
    return font;
  }
  const withoutGeneric = font.replace(/,\s*sans-serif\s*$/u, "");
  return `${withoutGeneric}, ${CJK_SANS_FALLBACK}, sans-serif`;
};

export function useAppearanceSettings() {
  const settings = useAppSettingsStore();

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
    const supportsNativeVibrancy = isTauriRuntime() && isMacOSRuntime();
    const nativeVibrancyEnabled =
      supportsNativeVibrancy && settings.translucentSidebar;

    const apply = () => {
      const dark =
        settings.theme === "dark" ||
        (settings.theme === "system" && media.matches);
      root.classList.toggle("dark", dark);
      root.classList.toggle(
        "app-reduce-motion",
        settings.reducedMotion === "on" ||
          (settings.reducedMotion === "system" && motionMedia.matches),
      );
      root.classList.toggle("app-pointer-cursor", settings.pointerCursor);
      root.classList.toggle("app-translucent-sidebar", nativeVibrancyEnabled);
      root.classList.toggle(
        "app-native-vibrancy-window",
        nativeVibrancyEnabled,
      );
      root.classList.toggle("app-font-smoothing", settings.fontSmoothing);

      const accent = dark ? settings.darkAccent : settings.lightAccent;
      const background = dark
        ? settings.darkBackground
        : settings.lightBackground;
      const foreground = dark
        ? settings.darkForeground
        : settings.lightForeground;
      const accentNumber = Number.parseInt(accent.slice(1), 16);
      const accentLuminance =
        ((accentNumber >> 16) * 299 +
          ((accentNumber >> 8) & 255) * 587 +
          (accentNumber & 255) * 114) /
        255000;
      root.style.setProperty("--background", background);
      root.style.setProperty("--foreground", foreground);
      root.style.setProperty("--card", background);
      root.style.setProperty("--card-foreground", foreground);
      root.style.setProperty("--popover", background);
      root.style.setProperty("--popover-foreground", foreground);
      root.style.setProperty("--primary", accent);
      root.style.setProperty(
        "--primary-foreground",
        accentLuminance > 0.62 ? "#111111" : "#ffffff",
      );
      root.style.setProperty("--ring", accent);
      root.style.setProperty("--sidebar-primary", accent);
      const uiFont =
        settings.uiFontPreset === "system" ? SYSTEM_UI_FONT : settings.uiFont;
      const resolvedUiFont = withCjkFallback(uiFont);
      root.style.setProperty("--font-sans", resolvedUiFont);
      root.style.fontFamily = resolvedUiFont;
      root.style.setProperty("--app-code-font", settings.codeFont);
      root.style.setProperty("--font-mono", settings.codeFont);
      root.style.fontSize = `${settings.uiFontSize}px`;
      root.style.setProperty(
        "--app-code-font-size",
        `${settings.codeFontSize}px`,
      );
    };

    apply();
    media.addEventListener("change", apply);
    motionMedia.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      motionMedia.removeEventListener("change", apply);
    };
  }, [settings]);
}
