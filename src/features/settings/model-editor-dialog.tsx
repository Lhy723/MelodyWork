import {
  CheckIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  ServerIcon,
} from "lucide-react";
import { useState } from "react";

import { Dropdown } from "@/components/interior/dropdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/interior/drawer";
import { FloatingLabelInput } from "@/components/interior/floating-label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { MelodyConfigValue } from "@/domain/config";

import { valueAt } from "./configuration-controls";
import { configObject, stringConfigValue } from "./configuration-utils";
import type { ConfigObject, ConfigValues } from "./configuration-types";
import {
  inheritedModelFields,
  providerTemplates,
} from "./model-settings-utils";

function ModelOverrideField({
  definition,
  draft,
  globalValues,
  onChange,
}: {
  definition: (typeof inheritedModelFields)[number];
  draft: ConfigObject;
  globalValues: ConfigValues;
  onChange: (key: string, value: MelodyConfigValue | undefined) => void;
}) {
  const enabled = draft[definition.key] !== undefined;
  const inherited =
    valueAt(globalValues, ["models", definition.key]) ?? definition.fallback;
  const value = draft[definition.key];

  return (
    <div className="flex min-h-16 items-center gap-4 border-t px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm">{definition.label}</p>
          <Badge variant={enabled ? "secondary" : "outline"}>
            {enabled ? "单独设置" : `继承：${String(inherited)}`}
          </Badge>
        </div>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {definition.description}
        </p>
      </div>
      {enabled ? (
        <Input
          aria-label={definition.label}
          className="w-24"
          max={"max" in definition ? definition.max : undefined}
          min={definition.min}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) {
              onChange(definition.key, next);
            }
          }}
          step={definition.step}
          type="number"
          value={typeof value === "number" ? value : definition.fallback}
        />
      ) : null}
      <Switch
        aria-label={`${enabled ? "取消" : "启用"}${definition.label}单独设置`}
        checked={enabled}
        onCheckedChange={(checked) =>
          onChange(
            definition.key,
            checked && typeof inherited === "number"
              ? inherited
              : checked
                ? definition.fallback
                : undefined,
          )
        }
      />
    </div>
  );
}

export function ModelEditorDialog({
  existingNames,
  globalValues,
  modelName,
  modelValue,
  onExitComplete,
  onOpenChange,
  onSave,
  open,
}: {
  existingNames: string[];
  globalValues: ConfigValues;
  modelName?: string;
  modelValue?: MelodyConfigValue;
  onExitComplete?: () => void;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, value: ConfigObject) => void;
  open: boolean;
}) {
  const editing = Boolean(modelName);
  const [step, setStep] = useState<"provider" | "details">(
    editing ? "details" : "provider",
  );
  const [alias, setAlias] = useState(modelName ?? "");
  const [draft, setDraft] = useState<ConfigObject>(() =>
    configObject(modelValue),
  );
  const [authMode, setAuthMode] = useState<"environment" | "key">(() =>
    stringConfigValue(configObject(modelValue), "api_key")
      ? "key"
      : "environment",
  );

  const setField = (key: string, value: MelodyConfigValue | undefined) => {
    setDraft((current) => {
      const next = { ...current };
      if (
        value === undefined ||
        value === null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      ) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const chooseProvider = (template: (typeof providerTemplates)[number]) => {
    setDraft((current) => ({
      ...current,
      api_backend: template.backend,
      ...(template.baseUrl ? { base_url: template.baseUrl } : {}),
      ...(template.envKey ? { env_key: [template.envKey] } : {}),
    }));
    setAuthMode("environment");
    setStep("details");
  };

  const modelId = stringConfigValue(draft, "model");
  const baseUrl = stringConfigValue(draft, "base_url");
  const envKeys = Array.isArray(draft.env_key)
    ? draft.env_key
        .filter((item): item is string => typeof item === "string")
        .join(", ")
    : "";
  const nameConflict = !editing && existingNames.includes(alias.trim());

  return (
    <Drawer
      description={
        step === "provider"
          ? "选择接口类型，我们会预填常用连接参数。"
          : "先完成必要信息；其余参数可以继承全局默认值。"
      }
      footer={
        step === "details" ? (
          <>
            <Button onClick={() => onOpenChange(false)} variant="outline">
              取消
            </Button>
            <Button
              disabled={!alias.trim() || !modelId.trim() || nameConflict}
              onClick={() => {
                onSave(alias.trim(), draft);
                onOpenChange(false);
              }}
            >
              <CheckIcon />
              {editing ? "保存更改" : "添加模型"}
            </Button>
          </>
        ) : (
          <Button onClick={() => onOpenChange(false)} variant="outline">
            取消
          </Button>
        )
      }
      dismissOnScrimClick={false}
      onExitComplete={onExitComplete}
      onOpenChange={onOpenChange}
      open={open}
      side="right"
      title={
        editing
          ? `编辑 ${stringConfigValue(draft, "name") || modelName}`
          : step === "provider"
            ? "添加模型"
            : "配置模型"
      }
      width={640}
    >
      {step === "provider" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {providerTemplates.map((template) => (
            <button
              className="group rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted/40"
              key={template.id}
              onClick={() => chooseProvider(template)}
              type="button"
            >
              <span className="mb-3 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:text-foreground">
                <ServerIcon className="size-4" />
              </span>
              <span className="block font-medium text-sm">{template.name}</span>
              <span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
                {template.description}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="grid gap-5">
          <section>
            <h4 className="mb-2 font-medium text-sm">基础信息</h4>
            <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2">
              <FloatingLabelInput
                className="text-xs"
                disabled={editing}
                hint={
                  nameConflict
                    ? "该配置名称已经存在。"
                    : "用于默认模型和代理路由。"
                }
                invalid={nameConflict}
                label="配置名称"
                onChange={(value) => setAlias(value)}
                value={alias}
              />
              <FloatingLabelInput
                className="text-xs"
                hint="例如 GPT 工作模型"
                label="显示名称"
                onChange={(value) => setField("name", value)}
                value={stringConfigValue(draft, "name")}
              />
              <FloatingLabelInput
                className="text-xs sm:col-span-2"
                hint="发送给模型提供商的实际模型名称。"
                label="模型 ID"
                onChange={(value) => setField("model", value)}
                value={modelId}
              />
              <FloatingLabelInput
                className="text-xs sm:col-span-2"
                hint="这个模型适合什么任务"
                label="说明"
                onChange={(value) => setField("description", value)}
                value={stringConfigValue(draft, "description")}
              />
            </div>
          </section>

          <section>
            <h4 className="mb-2 font-medium text-sm">连接与认证</h4>
            <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2">
              <FloatingLabelInput
                className="text-xs sm:col-span-2"
                hint="例如 https://api.example.com/v1"
                label="接口地址"
                onChange={(value) => setField("base_url", value)}
                value={baseUrl}
              />
              <label className="grid gap-1.5 text-xs">
                <span className="font-medium">接口类型</span>
                <Dropdown
                  className="w-full"
                  items={[
                    { label: "Chat Completions", value: "chat_completions" },
                    { label: "Responses", value: "responses" },
                    { label: "Messages", value: "messages" },
                  ]}
                  label="接口类型"
                  onChange={(value) => setField("api_backend", value)}
                  value={
                    stringConfigValue(draft, "api_backend") ||
                    "chat_completions"
                  }
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="font-medium">认证方式</span>
                <Dropdown
                  className="w-full"
                  items={[
                    { label: "环境变量", value: "environment" },
                    { label: "直接填写 API Key", value: "key" },
                  ]}
                  label="认证方式"
                  onChange={(value) => {
                    const next = value as "environment" | "key";
                    setAuthMode(next);
                    if (next === "environment") {
                      setField("api_key", undefined);
                    } else {
                      setField("env_key", undefined);
                    }
                  }}
                  value={authMode}
                />
              </label>
              {authMode === "environment" ? (
                <FloatingLabelInput
                  className="text-xs sm:col-span-2"
                  hint="例如 OPENAI_API_KEY，可填写多个变量"
                  label="密钥环境变量"
                  onChange={(value) =>
                    setField(
                      "env_key",
                      value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    )
                  }
                  value={envKeys}
                />
              ) : (
                <FloatingLabelInput
                  autoComplete="off"
                  className="text-xs sm:col-span-2"
                  hint="推荐使用环境变量，避免把密钥写入配置文件。"
                  label={
                    <span className="flex items-center gap-1.5">
                      <KeyRoundIcon aria-hidden className="size-3.5" />
                      API Key
                    </span>
                  }
                  onChange={(value) => setField("api_key", value)}
                  type="password"
                  value={stringConfigValue(draft, "api_key")}
                />
              )}
            </div>
          </section>

          <details className="group overflow-hidden rounded-xl border bg-card">
            <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-4 py-3">
              <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm">高级设置</p>
                <p className="text-muted-foreground text-xs">
                  上下文能力和单模型生成参数覆盖
                </p>
              </div>
            </summary>
            <div className="border-t">
              <div className="grid gap-4 p-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs">
                  <span className="font-medium">上下文窗口</span>
                  <Input
                    min={1}
                    onChange={(event) =>
                      setField(
                        "context_window",
                        event.target.value
                          ? Number(event.target.value)
                          : undefined,
                      )
                    }
                    placeholder="由提供商决定"
                    type="number"
                    value={
                      typeof draft.context_window === "number"
                        ? draft.context_window
                        : ""
                    }
                  />
                </label>
                <label className="flex items-center justify-between gap-4 rounded-lg bg-muted/40 px-3 py-2">
                  <span>
                    <span className="block font-medium text-xs">
                      服务端搜索
                    </span>
                    <span className="text-muted-foreground text-xs">
                      声明模型支持提供商侧搜索
                    </span>
                  </span>
                  <Switch
                    checked={draft.supports_backend_search === true}
                    onCheckedChange={(checked) =>
                      setField("supports_backend_search", checked)
                    }
                  />
                </label>
              </div>
              <div className="border-t">
                {inheritedModelFields.map((definition) => (
                  <ModelOverrideField
                    definition={definition}
                    draft={draft}
                    globalValues={globalValues}
                    key={definition.key}
                    onChange={setField}
                  />
                ))}
                <div className="flex min-h-16 items-center gap-4 border-t px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm">流式工具调用</p>
                      <Badge
                        variant={
                          draft.stream_tool_calls === undefined
                            ? "outline"
                            : "secondary"
                        }
                      >
                        {draft.stream_tool_calls === undefined
                          ? `继承：${String(valueAt(globalValues, ["models", "stream_tool_calls"]) ?? true)}`
                          : "单独设置"}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-muted-foreground text-xs">
                      在模型输出结束前解析工具调用。
                    </p>
                  </div>
                  {draft.stream_tool_calls !== undefined ? (
                    <>
                      <Switch
                        aria-label="流式工具调用"
                        checked={draft.stream_tool_calls === true}
                        onCheckedChange={(checked) =>
                          setField("stream_tool_calls", checked)
                        }
                      />
                      <Button
                        onClick={() => setField("stream_tool_calls", undefined)}
                        size="sm"
                        variant="ghost"
                      >
                        恢复继承
                      </Button>
                    </>
                  ) : (
                    <Button
                      onClick={() =>
                        setField(
                          "stream_tool_calls",
                          valueAt(globalValues, [
                            "models",
                            "stream_tool_calls",
                          ]) ?? true,
                        )
                      }
                      size="sm"
                      variant="outline"
                    >
                      单独设置
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </details>
        </div>
      )}
    </Drawer>
  );
}
