import { MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AgentPermissionMode } from "@/domain/acp";
import { getFileOpenerAvailability } from "@/lib/melody-bridge";
import { requestSystemNotificationPermission } from "@/lib/system-notifications";
import { useAgentStore } from "@/stores/agent-store";
import {
  useAppSettingsStore,
  type AppSettings,
  type FileOpener,
} from "@/stores/app-settings-store";

export function PreferenceRow({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description?: string;
  label: string;
}) {
  return (
    <div className="flex min-h-14 items-center gap-5 border-t px-4 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm">{label}</p>
        {description ? (
          <p className="mt-0.5 text-muted-foreground text-xs leading-4">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

export function PreferenceGroup({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section>
      <h4 className="mb-2 font-medium text-sm">{title}</h4>
      <div className="overflow-hidden rounded-xl border bg-card">
        {children}
      </div>
    </section>
  );
}

export function PreferenceSelect<Key extends keyof AppSettings>({
  label,
  options,
  settingKey,
}: {
  label: string;
  options: { label: string; value: AppSettings[Key] & string }[];
  settingKey: Key;
}) {
  const value = useAppSettingsStore((state) => state[settingKey]);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <Select
      onValueChange={(next) => setSetting(settingKey, next as AppSettings[Key])}
      value={String(value)}
    >
      <SelectTrigger aria-label={label} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const fileOpenerOptions: {
  value: FileOpener;
  label: string;
}[] = [
  { value: "system", label: "系统默认" },
  { value: "vscode", label: "Visual Studio Code" },
  { value: "cursor", label: "Cursor" },
];

const defaultFileOpenerAvailability: Record<FileOpener, boolean> = {
  system: true,
  vscode: false,
  cursor: false,
};

export function VisualStudioCodeIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        d="M17.5 2.5 12 7.42 6.5 2.5 2 5.5v13l4.5 3 5.5-4.92 5.5 4.92 4.5-3v-13l-4.5-3Z"
        fill="#007ACC"
      />
      <path
        d="m6.5 7.57-1.9 1.23v6.4l1.9 1.23 4.4-4.43-4.4-4.43Z"
        fill="#fff"
      />
      <path
        d="m13.8 8.57 4.4-3.96v14.78l-4.4-3.96 2.2-3.43-2.2-3.43Z"
        fill="#fff"
      />
    </svg>
  );
}

export function CursorIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
    >
      <rect fill="currentColor" height="20" rx="5" width="20" x="2" y="2" />
      <path d="m15.9 6.2-5.8 3.3-3.3 5.8 5.8-3.3 3.3-5.8Z" fill="white" />
      <path
        d="m12.6 12.3 4.4 4.4"
        stroke="white"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function FileOpenerIcon({
  className,
  opener,
}: {
  className?: string;
  opener: FileOpener;
}) {
  if (opener === "vscode") {
    return <VisualStudioCodeIcon className={className} />;
  }
  if (opener === "cursor") {
    return <CursorIcon className={className} />;
  }
  return <MonitorIcon aria-hidden="true" className={className} />;
}

export function FileOpenerPreference() {
  const value = useAppSettingsStore((state) => state.defaultFileOpener);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  const [availability, setAvailability] = useState(
    defaultFileOpenerAvailability,
  );
  const [scanState, setScanState] = useState<"checking" | "ready" | "failed">(
    "checking",
  );

  const scanFileOpeners = useCallback(async () => {
    setScanState("checking");
    try {
      const detected = await getFileOpenerAvailability();
      const next = { ...defaultFileOpenerAvailability };
      for (const item of detected) {
        next[item.id] = item.installed;
      }
      setAvailability(next);
      const currentValue = useAppSettingsStore.getState().defaultFileOpener;
      if (currentValue !== "system" && !next[currentValue]) {
        useAppSettingsStore
          .getState()
          .setSetting("defaultFileOpener", "system");
      }
      setScanState("ready");
    } catch {
      setScanState("failed");
    }
  }, []);

  useEffect(() => {
    void scanFileOpeners();
  }, [scanFileOpeners]);

  const visibleOptions =
    scanState === "ready"
      ? fileOpenerOptions.filter(
          (option) => option.value === "system" || availability[option.value],
        )
      : fileOpenerOptions.filter((option) => option.value === "system");
  const selectedValue = visibleOptions.some((option) => option.value === value)
    ? value
    : "system";

  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        onValueChange={(next) =>
          setSetting("defaultFileOpener", next as FileOpener)
        }
        value={selectedValue}
      >
        <SelectTrigger aria-label="默认文件打开目标" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="min-w-52" matchTriggerWidth={false}>
          {visibleOptions.map((option) => {
            return (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex min-w-0 items-center gap-2">
                  <FileOpenerIcon
                    className="size-4 shrink-0"
                    opener={option.value}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

export function PreferenceSwitch<Key extends keyof AppSettings>({
  label,
  settingKey,
}: {
  label: string;
  settingKey: Key;
}) {
  const value = useAppSettingsStore((state) => state[settingKey]);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <Switch
      aria-label={label}
      className="data-[state=checked]:bg-blue-500"
      checked={Boolean(value)}
      onCheckedChange={(next) =>
        setSetting(settingKey, next as AppSettings[Key])
      }
    />
  );
}

export function UnavailableControl({ label = "尚未实现" }: { label?: string }) {
  return <Badge variant="outline">{label}</Badge>;
}

export function PermissionModePreference() {
  const value = useAppSettingsStore((state) => state.defaultPermissionMode);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <Select
      onValueChange={(next) => {
        const mode = next as AgentPermissionMode;
        setSetting("defaultPermissionMode", mode);
        void useAgentStore.getState().selectPermissionMode(mode);
      }}
      value={value}
    >
      <SelectTrigger aria-label="默认及当前权限模式" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="ask">询问</SelectItem>
        <SelectItem value="auto">自动审核</SelectItem>
        <SelectItem value="always-approve">始终允许</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function NotificationPreferenceSwitch({
  label,
  settingKey,
}: {
  label: string;
  settingKey: "permissionNotifications" | "questionNotifications";
}) {
  const value = useAppSettingsStore((state) => state[settingKey]);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  const [permissionDenied, setPermissionDenied] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <Switch
        aria-label={label}
        checked={value}
        onCheckedChange={(checked) => {
          if (!checked) {
            setPermissionDenied(false);
            setSetting(settingKey, false);
            return;
          }
          void requestSystemNotificationPermission().then((granted) => {
            setPermissionDenied(!granted);
            setSetting(settingKey, granted);
          });
        }}
      />
      {permissionDenied ? (
        <span className="text-destructive text-[11px]">系统未授予通知权限</span>
      ) : null}
    </div>
  );
}

export function CompletionNotificationPreference() {
  const value = useAppSettingsStore((state) => state.completionNotification);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  const [permissionDenied, setPermissionDenied] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        onValueChange={(next) => {
          const mode = next as AppSettings["completionNotification"];
          if (mode === "never") {
            setPermissionDenied(false);
            setSetting("completionNotification", mode);
            return;
          }
          void requestSystemNotificationPermission().then((granted) => {
            setPermissionDenied(!granted);
            setSetting("completionNotification", granted ? mode : "never");
          });
        }}
        value={value}
      >
        <SelectTrigger aria-label="轮次完成通知" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unfocused">仅应用失焦时</SelectItem>
          <SelectItem value="always">始终</SelectItem>
          <SelectItem value="never">从不</SelectItem>
        </SelectContent>
      </Select>
      {permissionDenied ? (
        <span className="text-destructive text-[11px]">系统未授予通知权限</span>
      ) : null}
    </div>
  );
}
