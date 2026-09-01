import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AppSettings } from "@/stores/app-settings-store";
import { useAppSettingsStore } from "@/stores/app-settings-store";

import {
  FileOpenerPreference,
  PreferenceGroup,
  PreferenceRow,
  PreferenceSelect,
  PreferenceSwitch,
  CompletionNotificationPreference,
  NotificationPreferenceSwitch,
  PermissionModePreference,
  UnavailableControl,
} from "./preference-controls";

export function ApplicationGeneralSettings() {
  const importInput = useRef<HTMLInputElement>(null);
  const [actionMessage, setActionMessage] = useState<string>();

  const importSettings = async (file?: File) => {
    if (!file) {
      return;
    }
    try {
      const incoming = JSON.parse(await file.text()) as Partial<AppSettings>;
      const current = useAppSettingsStore.getState();
      for (const [key, value] of Object.entries(incoming)) {
        if (key in current && key !== "setSetting") {
          current.setSetting(key as keyof AppSettings, value as never);
        }
      }
      setActionMessage("已导入可识别的 MelodyWork 设置。");
    } catch {
      setActionMessage("无法读取该设置文件。");
    }
  };

  return (
    <div className="flex flex-col gap-7">
      <PreferenceGroup title="权限">
        <PreferenceRow
          description="立即应用到当前任务，并作为以后新任务的默认权限模式。"
          label="默认及当前权限模式"
        >
          <PermissionModePreference />
        </PreferenceRow>
      </PreferenceGroup>

      <PreferenceGroup title="常规">
        <PreferenceRow label="默认文件打开目标">
          <FileOpenerPreference />
        </PreferenceRow>
        <PreferenceRow description="MelodyWork 界面使用的语言。" label="语言">
          <UnavailableControl label="简体中文 · 其他语言尚未实现" />
        </PreferenceRow>
        <PreferenceRow
          description="关闭主窗口后仍在系统菜单栏中保留 MelodyWork。"
          label="在菜单栏中显示"
        >
          <PreferenceSwitch label="在菜单栏中显示" settingKey="showInMenuBar" />
        </PreferenceRow>
        <PreferenceRow
          description="代理运行时阻止系统自动休眠。"
          label="运行时防止系统休眠"
        >
          <PreferenceSwitch
            label="运行时防止系统休眠"
            settingKey="preventSystemSleep"
          />
        </PreferenceRow>
        <PreferenceRow
          description="导入其他客户端导出的 JSON 设置。"
          label="从其他 AI 应用导入工作内容"
        >
          <input
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              void importSettings(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
            ref={importInput}
            type="file"
          />
          <Button
            onClick={() => importInput.current?.click()}
            size="sm"
            variant="secondary"
          >
            导入
          </Button>
        </PreferenceRow>
        <PreferenceRow
          description="查看 MelodyWork 使用的第三方开源依赖。"
          label="开源许可证"
        >
          <Button
            onClick={() =>
              setActionMessage(
                "开源依赖信息可在 package.json 与 pnpm-lock.yaml 中查看。",
              )
            }
            size="sm"
            variant="secondary"
          >
            查看
          </Button>
        </PreferenceRow>
      </PreferenceGroup>

      <PreferenceGroup title="编辑器">
        <PreferenceRow
          description="在输入区显示当前会话的上下文窗口使用情况。"
          label="显示上下文窗口使用情况"
        >
          <PreferenceSwitch
            label="显示上下文窗口使用情况"
            settingKey="showContextUsage"
          />
        </PreferenceRow>
        <PreferenceRow
          description="选择按 Enter 时发送消息还是插入新行。"
          label="发送快捷键"
        >
          <PreferenceSelect
            label="发送快捷键"
            options={[
              { value: "enter", label: "Enter" },
              { value: "mod-enter", label: "⌘ / Ctrl + Enter" },
            ]}
            settingKey="sendShortcut"
          />
        </PreferenceRow>
        <PreferenceRow
          description="代理运行时，将后续指令加入队列或引导当前运行。"
          label="跟进行为"
        >
          <PreferenceSelect
            label="跟进行为"
            options={[
              { value: "queue", label: "排队" },
              { value: "steer", label: "引导" },
            ]}
            settingKey="followUpBehavior"
          />
        </PreferenceRow>
      </PreferenceGroup>

      <PreferenceGroup title="新建任务">
        <PreferenceRow
          description="新建任务默认使用不绑定项目目录的任务空间。"
          label="默认使用任务"
        >
          <PreferenceSwitch
            label="默认使用任务"
            settingKey="defaultIndependentChat"
          />
        </PreferenceRow>
      </PreferenceGroup>

      <PreferenceGroup title="通知">
        <PreferenceRow
          description="设置代理完成回复时提醒你的时机。"
          label="轮次完成通知"
        >
          <CompletionNotificationPreference />
        </PreferenceRow>
        <PreferenceRow
          description="在需要授权时显示系统提醒。"
          label="启用权限通知"
        >
          <NotificationPreferenceSwitch
            label="启用权限通知"
            settingKey="permissionNotifications"
          />
        </PreferenceRow>
        <PreferenceRow
          description="代理需要你回答问题时显示系统提醒。"
          label="启用问题通知"
        >
          <NotificationPreferenceSwitch
            label="启用问题通知"
            settingKey="questionNotifications"
          />
        </PreferenceRow>
      </PreferenceGroup>

      {actionMessage ? (
        <p className="text-muted-foreground text-xs">{actionMessage}</p>
      ) : null}
    </div>
  );
}
