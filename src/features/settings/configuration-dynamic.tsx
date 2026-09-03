import {
  ChevronRightIcon,
  NetworkIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { HoldToConfirm } from "@/components/interior/hold-to-confirm";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { SettingsList, valueAt } from "./configuration-controls";
import { objectEntries } from "./configuration-utils";
import type {
  ConfigValues,
  ConfigurationFormProps,
  SettingDefinition,
} from "./configuration-types";

export function DynamicSection({
  kind,
  values,
  onChange,
}: {
  kind: "models" | "mcp";
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  const root = kind === "models" ? ["model"] : ["mcp_servers"];
  const entries = objectEntries(values, root);
  const [draftName, setDraftName] = useState("");
  const [pendingDeleteName, setPendingDeleteName] = useState<string>();
  const add = () => {
    const name = draftName.trim();
    if (!name || entries.some(([current]) => current === name)) {
      return;
    }
    onChange(
      [...root, name],
      kind === "models"
        ? { model: name, api_backend: "chat_completions" }
        : { enabled: true, command: "" },
    );
    setDraftName("");
  };

  const definitions = (name: string): SettingDefinition[] =>
    kind === "models"
      ? [
          {
            path: [...root, name, "model"],
            label: "模型标识",
            description: "发送给模型提供商的实际模型名称。",
            kind: "string",
          },
          {
            path: [...root, name, "name"],
            label: "显示名称",
            description: "模型选择器中显示的名称。",
            kind: "string",
          },
          {
            path: [...root, name, "description"],
            label: "说明",
            description: "模型选择器中显示的简短说明。",
            kind: "string",
          },
          {
            path: [...root, name, "base_url"],
            label: "接口地址",
            description: "兼容 OpenAI、Responses 或 Messages 的 API 地址。",
            kind: "string",
          },
          {
            path: [...root, name, "api_backend"],
            label: "接口类型",
            description: "此模型使用的 API 协议。",
            kind: "select",
            defaultValue: "chat_completions",
            options: [
              { value: "chat_completions", label: "Chat Completions" },
              { value: "responses", label: "Responses" },
              { value: "messages", label: "Messages" },
            ],
          },
          {
            path: [...root, name, "api_key"],
            label: "API Key",
            description: "直接保存的密钥；优先建议使用环境变量。",
            kind: "string",
            secret: true,
          },
          {
            path: [...root, name, "env_key"],
            label: "密钥环境变量",
            description: "每行一个候选环境变量名。",
            kind: "string-list",
          },
          {
            path: [...root, name, "context_window"],
            label: "上下文窗口",
            description: "模型可接收的最大 Token 数。",
            kind: "number",
            min: 1,
          },
          {
            path: [...root, name, "max_completion_tokens"],
            label: "最大输出 Token",
            description: "此模型单次生成的最大 Token 数。",
            kind: "number",
            min: 1,
          },
          {
            path: [...root, name, "max_retries"],
            label: "最大重试次数",
            description: "此模型请求失败后的自动重试上限。",
            kind: "number",
            min: 0,
            step: 1,
          },
          {
            path: [...root, name, "inference_idle_timeout_secs"],
            label: "推理空闲超时",
            description: "此模型流式响应无新内容后等待的秒数。",
            kind: "number",
            min: 1,
            step: 1,
          },
          {
            path: [...root, name, "temperature"],
            label: "温度",
            description: "此模型专用的随机性设置。",
            kind: "number",
            min: 0,
            max: 2,
            step: 0.1,
          },
          {
            path: [...root, name, "top_p"],
            label: "Top P",
            description: "此模型专用的核采样设置。",
            kind: "number",
            min: 0,
            max: 1,
            step: 0.05,
          },
          {
            path: [...root, name, "stream_tool_calls"],
            label: "流式工具调用",
            description: "覆盖全局的流式工具调用设置。",
            kind: "boolean",
            defaultValue: true,
          },
          {
            path: [...root, name, "supports_backend_search"],
            label: "服务端搜索",
            description: "声明此模型支持提供商侧联网搜索。",
            kind: "boolean",
            defaultValue: false,
          },
          {
            path: [...root, name, "extra_headers"],
            label: "请求头",
            description: "每行填写“名称=值”，覆盖或补充全局请求头。",
            kind: "key-value",
          },
        ]
      : [
          {
            path: [...root, name, "enabled"],
            label: "启用服务器",
            description: "启动 Melody 时连接此 MCP 服务器。",
            kind: "boolean",
            defaultValue: true,
          },
          {
            path: [...root, name, "command"],
            label: "启动命令",
            description: "本地 stdio MCP 服务器的可执行命令。",
            kind: "string",
          },
          {
            path: [...root, name, "args"],
            label: "命令参数",
            description: "每行一个传给启动命令的参数。",
            kind: "string-list",
          },
          {
            path: [...root, name, "url"],
            label: "远程地址",
            description: "远程 MCP 服务器地址；与启动命令二选一。",
            kind: "string",
          },
          {
            path: [...root, name, "startup_timeout_sec"],
            label: "启动超时",
            description: "等待服务器就绪的秒数。",
            kind: "number",
            min: 1,
          },
          {
            path: [...root, name, "tool_timeout_sec"],
            label: "工具超时",
            description: "MCP 工具调用的默认超时秒数。",
            kind: "number",
            min: 1,
          },
          {
            path: [...root, name, "env"],
            label: "环境变量",
            description: "每行填写“名称=值”，传给本地 MCP 进程。",
            kind: "key-value",
          },
          {
            path: [...root, name, "headers"],
            label: "请求头",
            description: "每行填写“名称=值”，随远程 MCP 请求发送。",
            kind: "key-value",
          },
          {
            path: [...root, name, "tool_timeouts"],
            label: "单工具超时",
            description: "每行填写“工具名=秒数”。",
            kind: "key-value",
            numberValues: true,
          },
        ];

  return (
    <div>
      <div className="mb-4 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label
            className="mb-1.5 block font-medium text-xs"
            htmlFor={`${kind}-name`}
          >
            {kind === "models" ? "添加自定义模型" : "添加 MCP 服务器"}
          </label>
          <Input
            id={`${kind}-name`}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                add();
              }
            }}
            placeholder={
              kind === "models" ? "例如 fast-model" : "例如 filesystem"
            }
            value={draftName}
          />
        </div>
        <Button disabled={!draftName.trim()} onClick={add} variant="outline">
          <PlusIcon />
          添加
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {entries.map(([name]) => {
          const enabledValue =
            kind === "mcp"
              ? valueAt(values, [...root, name, "enabled"])
              : undefined;
          const enabled =
            typeof enabledValue === "boolean" ? enabledValue : true;
          return (
            <details
              className="group overflow-hidden rounded-xl border bg-card"
              key={name}
            >
              <summary className="flex h-11 cursor-pointer list-none items-center gap-2 px-4">
                <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                <span className="min-w-0 flex-1 truncate font-medium text-sm">
                  {name}
                </span>
                {kind === "mcp" ? (
                  <span
                    className="flex items-center"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    <Switch
                      aria-label={`${enabled ? "停用" : "启用"} MCP 服务器 ${name}`}
                      checked={enabled}
                      onCheckedChange={(checked) =>
                        onChange([...root, name, "enabled"], checked)
                      }
                    />
                  </span>
                ) : null}
                <Button
                  aria-label={`删除 ${name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setPendingDeleteName(name);
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </summary>
              <div className="border-t">
                <SettingsList
                  onChange={onChange}
                  section={{
                    id: name,
                    label: name,
                    description: "",
                    icon: NetworkIcon,
                    settings: definitions(name),
                  }}
                  values={values}
                />
              </div>
            </details>
          );
        })}
        {entries.length === 0 ? (
          <div className="rounded-xl border border-dashed py-10 text-center text-muted-foreground text-sm">
            暂无{kind === "models" ? "自定义模型" : " MCP 服务器"}
          </div>
        ) : null}
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setPendingDeleteName(undefined);
        }}
        open={Boolean(pendingDeleteName)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              删除{kind === "models" ? "自定义模型" : " MCP 服务器"}？
            </DialogTitle>
            <DialogDescription>
              “{pendingDeleteName ?? ""}
              ”的配置将从当前设置中移除，之后需要重新添加才能使用。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <HoldToConfirm
              onConfirm={() => {
                if (pendingDeleteName) {
                  onChange([...root, pendingDeleteName], null);
                  setPendingDeleteName(undefined);
                }
              }}
              variant="destructive"
            >
              确认删除
            </HoldToConfirm>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
