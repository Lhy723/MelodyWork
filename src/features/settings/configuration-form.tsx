import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  compatibilityGroups,
  configurationSections,
} from "./configuration-sections";
import {
  ApplicationAppearanceSettings,
  ApplicationGeneralSettings,
} from "./application-preferences";
import { CompatibilitySettings, SettingsList } from "./configuration-controls";
import { DynamicSection } from "./configuration-dynamic";
import type { ConfigurationFormProps } from "./configuration-types";
import { ModelSettings } from "./model-settings";

export { getConfigurationNavigation } from "./configuration-sections";
export type { ConfigurationNavigationItem } from "./configuration-sections";

export function ConfigurationForm({
  availableModels,
  onReload,
  reloadDisabled = false,
  reloadLoading = false,
  sectionId,
  scope,
  values,
  onChange,
}: ConfigurationFormProps) {
  const sections = configurationSections(scope);
  const active =
    sections.find((section) => section.id === sectionId) ?? sections[0];

  if (!active) {
    return null;
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto w-full max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold text-3xl">{active.label}</h3>
            <p className="mt-1 text-muted-foreground text-sm">
              {active.description}
            </p>
          </div>
          {scope === "project" && onReload ? (
            <Button
              aria-label="重新加载项目配置"
              disabled={reloadDisabled}
              onClick={onReload}
              size="sm"
              title="重新加载项目配置"
              type="button"
              variant="ghost"
            >
              <RefreshCwIcon
                className={cn("size-3.5", reloadLoading && "animate-spin")}
              />
              重新加载
            </Button>
          ) : null}
        </div>
        <div className="mt-5">
          {active.id === "general" ? (
            <ApplicationGeneralSettings />
          ) : active.id === "appearance" ? (
            <ApplicationAppearanceSettings />
          ) : active.id === "models" ? (
            <ModelSettings
              availableModels={availableModels}
              onChange={onChange}
              section={active}
              values={values}
            />
          ) : active.id === "mcp" ? (
            <DynamicSection kind="mcp" onChange={onChange} values={values} />
          ) : active.id === "compatibility" ? (
            <CompatibilitySettings
              groups={compatibilityGroups}
              onChange={onChange}
              section={active}
              values={values}
            />
          ) : (
            <SettingsList
              onChange={onChange}
              section={active}
              values={values}
            />
          )}
        </div>
        <p className="mt-4 text-muted-foreground text-xs leading-relaxed">
          未在此界面中展示的配置项、注释和文件排版会在保存时保留。
        </p>
      </div>
    </div>
  );
}
