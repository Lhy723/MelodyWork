import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isMacOSRuntime, isTauriRuntime } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";
import {
  DEFAULT_UI_FONT,
  SYSTEM_UI_FONT,
  useAppSettingsStore,
  type AppSettings,
  type UiFontPreset,
} from "@/stores/app-settings-store";

import {
  PreferenceGroup,
  PreferenceRow,
  PreferenceSelect,
  PreferenceSwitch,
} from "./preference-controls";

export function ThemePreview({
  label,
  mode,
}: {
  label: string;
  mode: AppSettings["theme"];
}) {
  const selected = useAppSettingsStore((state) => state.theme === mode);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <button
      aria-pressed={selected}
      className="group text-left"
      onClick={() => setSetting("theme", mode)}
      type="button"
    >
      <div
        className={cn(
          "relative h-28 overflow-hidden rounded-xl border-2 bg-[#f5f5f5] transition-colors",
          selected ? "border-foreground" : "border-border",
          mode === "dark" && "bg-[#575757]",
          mode === "system" &&
            "bg-[linear-gradient(90deg,#f5f5f5_50%,#575757_50%)]",
        )}
      >
        <div className="absolute inset-x-5 top-8 h-1.5 rounded-full bg-black/15" />
        <div className="absolute inset-x-3 top-12 bottom-0 rounded-t-xl bg-white shadow-sm">
          <div className="mx-3 mt-4 h-2 w-14 rounded-full bg-black/15" />
          <div className="mx-3 mt-2 h-px bg-black/5" />
          <div className="mx-3 mt-2 h-2 w-20 rounded-full bg-black/10" />
        </div>
        {mode === "system" ? (
          <div className="absolute inset-y-0 left-1/2 w-1/2 bg-black/55 mix-blend-multiply" />
        ) : null}
      </div>
      <p className="mt-1.5 text-center text-muted-foreground text-xs">
        {label}
      </p>
    </button>
  );
}

export function ColorSetting({
  label,
  settingKey,
}: {
  label: string;
  settingKey:
    | "lightAccent"
    | "lightBackground"
    | "lightForeground"
    | "darkAccent"
    | "darkBackground"
    | "darkForeground";
}) {
  const value = useAppSettingsStore((state) => state[settingKey]);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <PreferenceRow description="" label={label}>
      <label
        className="flex h-7 w-36 cursor-pointer items-center gap-2 rounded-lg border px-2 text-xs"
        style={{
          backgroundColor: value,
          color:
            settingKey.includes("Background") && value === "#ffffff"
              ? "#1a1c1f"
              : undefined,
        }}
      >
        <input
          aria-label={label}
          className="size-3 cursor-pointer appearance-none rounded-full border border-current/20"
          onChange={(event) => setSetting(settingKey, event.target.value)}
          type="color"
          value={value}
        />
        <span className="font-mono">{value.toUpperCase()}</span>
      </label>
    </PreferenceRow>
  );
}

const uiFontPresetOptions: { value: UiFontPreset; label: string }[] = [
  { value: "geist", label: "Geist（默认）" },
  { value: "system", label: "系统字体" },
  { value: "custom", label: "自定义" },
];

function UiFontPreference() {
  const uiFont = useAppSettingsStore((state) => state.uiFont);
  const uiFontPreset = useAppSettingsStore((state) => state.uiFontPreset);
  const setSetting = useAppSettingsStore((state) => state.setSetting);

  const setUiFontPreset = (preset: UiFontPreset) => {
    setSetting("uiFontPreset", preset);
    if (preset === "geist") {
      setSetting("uiFont", DEFAULT_UI_FONT);
    } else if (preset === "system") {
      setSetting("uiFont", SYSTEM_UI_FONT);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Select
        onValueChange={(value) => setUiFontPreset(value as UiFontPreset)}
        value={uiFontPreset}
      >
        <SelectTrigger aria-label="UI 字体预设" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {uiFontPresetOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {uiFontPreset === "custom" ? (
        <Input
          aria-label="自定义 UI 字体"
          className="w-52"
          onChange={(event) => {
            setSetting("uiFont", event.target.value);
            setSetting("uiFontPreset", "custom");
          }}
          placeholder="字体栈，例如 system-ui, sans-serif"
          value={uiFont}
        />
      ) : null}
    </div>
  );
}

export function AppearanceThemeGroup({ dark }: { dark: boolean }) {
  const prefix = dark ? "dark" : "light";
  const codeFont = useAppSettingsStore((state) => state.codeFont);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  const showTranslucentSidebar = isTauriRuntime() && isMacOSRuntime();

  return (
    <PreferenceGroup title={dark ? "深色主题" : "浅色主题"}>
      <ColorSetting
        label="强调色"
        settingKey={`${prefix}Accent` as "lightAccent" | "darkAccent"}
      />
      <ColorSetting
        label="背景"
        settingKey={
          `${prefix}Background` as "lightBackground" | "darkBackground"
        }
      />
      <ColorSetting
        label="前景"
        settingKey={
          `${prefix}Foreground` as "lightForeground" | "darkForeground"
        }
      />
      <PreferenceRow description="" label="UI 字体">
        <UiFontPreference />
      </PreferenceRow>
      <PreferenceRow description="" label="代码字体">
        <Input
          aria-label="代码字体"
          className="w-52"
          onChange={(event) => setSetting("codeFont", event.target.value)}
          value={codeFont}
        />
      </PreferenceRow>
      {showTranslucentSidebar ? (
        <PreferenceRow description="" label="macOS 磨砂侧边栏">
          <PreferenceSwitch
            label="macOS 磨砂侧边栏"
            settingKey="translucentSidebar"
          />
        </PreferenceRow>
      ) : null}
    </PreferenceGroup>
  );
}

export function ApplicationAppearanceSettings() {
  const uiFontSize = useAppSettingsStore((state) => state.uiFontSize);
  const codeFontSize = useAppSettingsStore((state) => state.codeFontSize);
  const setSetting = useAppSettingsStore((state) => state.setSetting);

  return (
    <div className="flex flex-col gap-7">
      <section>
        <h4 className="mb-2 font-medium text-sm">主题</h4>
        <div className="grid grid-cols-3 gap-3">
          <ThemePreview label="系统" mode="system" />
          <ThemePreview label="浅色" mode="light" />
          <ThemePreview label="深色" mode="dark" />
        </div>
        <div className="mt-3 grid overflow-hidden rounded-xl border font-mono text-[11px] sm:grid-cols-2">
          <div className="min-w-0 border-b sm:border-r sm:border-b-0">
            <p className="h-5 px-3 leading-5 text-muted-foreground">
              1&nbsp; const themePreview = {"{"}
            </p>
            <p className="border-l-2 border-red-500 bg-red-500/10 px-3 py-0.5 text-red-700 dark:text-red-300">
              2&nbsp;&nbsp; surface: "sidebar",
            </p>
            <p className="border-l-2 border-red-500 bg-red-500/10 px-3 py-0.5 text-red-700 dark:text-red-300">
              3&nbsp;&nbsp; contrast: 42,
            </p>
          </div>
          <div className="min-w-0">
            <p className="h-5 px-3 leading-5 text-muted-foreground">
              1&nbsp; const themePreview = {"{"}
            </p>
            <p className="border-l-2 border-emerald-500 bg-emerald-500/10 px-3 py-0.5 text-emerald-700 dark:text-emerald-300">
              2&nbsp;&nbsp; surface: "sidebar-elevated",
            </p>
            <p className="border-l-2 border-emerald-500 bg-emerald-500/10 px-3 py-0.5 text-emerald-700 dark:text-emerald-300">
              3&nbsp;&nbsp; contrast: 68,
            </p>
          </div>
        </div>
      </section>

      <AppearanceThemeGroup dark={false} />
      <AppearanceThemeGroup dark />

      <PreferenceGroup title="偏好设置">
        <PreferenceRow
          description="悬停交互元素时切换为指针光标。"
          label="使用指针光标"
        >
          <PreferenceSwitch label="使用指针光标" settingKey="pointerCursor" />
        </PreferenceRow>
        <PreferenceRow
          description="减少动画效果或匹配系统辅助功能设置。"
          label="减少动态效果"
        >
          <PreferenceSelect
            label="减少动态效果"
            options={[
              { value: "system", label: "系统" },
              { value: "on", label: "开启" },
              { value: "off", label: "关闭" },
            ]}
            settingKey="reducedMotion"
          />
        </PreferenceRow>
        <PreferenceRow
          description="调整 MelodyWork 界面使用的基准字号。"
          label="UI 字号"
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="UI 字号"
              className="w-20"
              max={18}
              min={14}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) {
                  setSetting("uiFontSize", Math.min(18, Math.max(14, value)));
                }
              }}
              type="number"
              value={uiFontSize}
            />
            <span className="text-muted-foreground text-xs">px</span>
          </div>
        </PreferenceRow>
        <PreferenceRow
          description="调整任务活动和差异对比中代码的字号。"
          label="代码字体大小"
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="代码字体大小"
              className="w-20"
              max={18}
              min={10}
              onChange={(event) =>
                setSetting("codeFontSize", Number(event.target.value))
              }
              type="number"
              value={codeFontSize}
            />
            <span className="text-muted-foreground text-xs">px</span>
          </div>
        </PreferenceRow>
        <PreferenceRow
          description="在 macOS 上使用原生字体抗锯齿。"
          label="字体平滑"
        >
          <PreferenceSwitch label="字体平滑" settingKey="fontSmoothing" />
        </PreferenceRow>
      </PreferenceGroup>
    </div>
  );
}
