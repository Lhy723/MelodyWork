import type { AgentModelOption } from "@/domain/acp";
import { Tabs } from "@/components/interior/tabs";

import { SettingsList, valueAt } from "./configuration-controls";
import { objectEntries } from "./configuration-utils";
import type {
  ConfigValues,
  ConfigurationFormProps,
  SettingSection,
} from "./configuration-types";
import { CustomModelManager } from "./custom-model-manager";

export function ModelSettings({
  availableModels,
  section,
  values,
  onChange,
}: {
  availableModels: AgentModelOption[];
  section: SettingSection;
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  const configuredModels = objectEntries(values, ["model"]).map(
    ([name]) => name,
  );
  const currentDefault = valueAt(values, ["models", "default"]);
  const modelOptions = new Map(
    availableModels.map((model) => [
      model.id,
      model.name === model.id ? model.id : `${model.name} (${model.id})`,
    ]),
  );
  for (const name of configuredModels) {
    if (!modelOptions.has(name)) {
      modelOptions.set(name, name);
    }
  }
  if (typeof currentDefault === "string" && !modelOptions.has(currentDefault)) {
    modelOptions.set(currentDefault, `${currentDefault}（当前配置）`);
  }
  const inheritValue = "__melody_inherit_default__";
  const defaultSettings = section.settings.map((definition) =>
    definition.path[0] === "models" && definition.path[1] === "default"
      ? {
          ...definition,
          kind: "select" as const,
          clearValue: inheritValue,
          options: [
            { label: "跟随 Melody 默认值", value: inheritValue },
            ...Array.from(modelOptions, ([value, label]) => ({
              label,
              value,
            })),
          ],
        }
      : definition,
  );

  return (
    <Tabs
      className="w-full"
      defaultValue="custom"
      items={[
        { label: "自定义模型", value: "custom" },
        { label: "默认值与生成行为", value: "defaults" },
      ]}
      label="模型设置"
      panelClassName="pt-5"
      renderPanel={(value) =>
        value === "custom" ? (
          <CustomModelManager onChange={onChange} values={values} />
        ) : (
          <section>
            <h4 className="font-medium text-sm">默认值与生成行为</h4>
            <p className="mt-0.5 mb-2 text-muted-foreground text-xs">
              应用于新会话；自定义模型中的同名参数可以单独覆盖这些值。
            </p>
            <SettingsList
              onChange={onChange}
              section={{ ...section, settings: defaultSettings }}
              values={values}
            />
          </section>
        )
      }
    />
  );
}
