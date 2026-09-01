import { BotIcon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { valueAt } from "./configuration-controls";
import {
  configObject,
  objectEntries,
  stringConfigValue,
} from "./configuration-utils";
import type {
  ConfigValues,
  ConfigurationFormProps,
} from "./configuration-types";
import { ModelEditorDialog } from "./model-editor-dialog";
import { modelProviderLabel } from "./model-settings-utils";

export function CustomModelManager({
  values,
  onChange,
}: {
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  const entries = objectEntries(values, ["model"]);
  const currentDefault = valueAt(values, ["models", "default"]);
  const [editingModel, setEditingModel] = useState<string | null>();
  const [pendingDelete, setPendingDelete] = useState<string>();

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h4 className="font-medium text-sm">自定义模型</h4>
          <p className="mt-0.5 text-muted-foreground text-xs">
            管理第三方提供商、自托管模型和模型专用参数。
          </p>
        </div>
        <Button onClick={() => setEditingModel(null)} size="sm">
          <PlusIcon />
          添加模型
        </Button>
      </div>

      {entries.length > 0 ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          {entries.map(([name, value], index) => {
            const model = configObject(value);
            const displayName = stringConfigValue(model, "name") || name;
            const modelId = stringConfigValue(model, "model") || name;
            const baseUrl = stringConfigValue(model, "base_url");
            const isDefault = currentDefault === name;
            return (
              <div
                className={cn(
                  "flex items-center gap-3 px-4 py-3",
                  index > 0 && "border-t",
                )}
                key={name}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <BotIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate font-medium text-sm">
                      {displayName}
                    </p>
                    {isDefault ? <Badge>默认</Badge> : null}
                    <Badge variant="outline">{modelProviderLabel(model)}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-muted-foreground text-xs">
                    {modelId}
                    {baseUrl
                      ? ` · ${baseUrl.replace(/^https?:\/\//, "")}`
                      : " · 使用默认接口"}
                  </p>
                </div>
                {!isDefault ? (
                  <Button
                    onClick={() => onChange(["models", "default"], name)}
                    size="sm"
                    variant="ghost"
                  >
                    设为默认
                  </Button>
                ) : null}
                <Button
                  onClick={() => setEditingModel(name)}
                  size="sm"
                  variant="outline"
                >
                  编辑
                </Button>
                <Button
                  aria-label={`删除 ${displayName}`}
                  onClick={() => setPendingDelete(name)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed px-6 py-10 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <ServerIcon className="size-4" />
          </span>
          <p className="mt-3 font-medium text-sm">还没有自定义模型</p>
          <p className="mt-1 text-muted-foreground text-xs">
            添加模型提供商或连接自己的兼容接口。
          </p>
        </div>
      )}

      {editingModel !== undefined ? (
        <ModelEditorDialog
          existingNames={entries.map(([name]) => name)}
          globalValues={values}
          key={editingModel ?? "new"}
          modelName={editingModel ?? undefined}
          modelValue={
            editingModel ? valueAt(values, ["model", editingModel]) : undefined
          }
          onOpenChange={(open) => {
            if (!open) {
              setEditingModel(undefined);
            }
          }}
          onSave={(name, model) => onChange(["model", name], model)}
          open
        />
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(undefined);
          }
        }}
        open={Boolean(pendingDelete)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除模型配置？</DialogTitle>
            <DialogDescription>
              这会从 Melody 配置中删除“{pendingDelete}
              ”。该操作不会删除提供商上的模型。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setPendingDelete(undefined)}
              variant="outline"
            >
              取消
            </Button>
            <Button
              onClick={() => {
                if (pendingDelete) {
                  onChange(["model", pendingDelete], null);
                  if (currentDefault === pendingDelete) {
                    onChange(["models", "default"], null);
                  }
                }
                setPendingDelete(undefined);
              }}
              variant="destructive"
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
