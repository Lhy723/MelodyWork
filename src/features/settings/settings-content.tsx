import { AnimatePresence } from "motion/react";
import { lazy, Suspense } from "react";
import { MotionPage } from "@/components/motion/page-transition";
import type {
  MelodyConfigDocument,
  MelodyConfigScope,
  MelodyConfigValue,
  MelodyExtension,
  MelodyExtensionKind,
} from "@/domain/config";
import type { AgentModelOption } from "@/domain/acp";
import type { PermissionRule } from "@/domain/permission";
import { AboutPage } from "./about-page";
import { ConfigurationForm } from "./configuration-form";
import {
  SettingsExtensionPage,
  type SettingsExtensionGroup,
} from "./settings-extension-page";
import { SettingsPermissionsPage } from "./settings-permissions-page";
import type { SettingsPage } from "./settings-types";

const StatisticsPage = lazy(() =>
  import("./statistics-page").then((module) => ({
    default: module.StatisticsPage,
  })),
);

interface SettingsContentProps {
  activeConfigSection: string;
  availableModels: AgentModelOption[];
  configDocument?: MelodyConfigDocument;
  configValues: Record<string, MelodyConfigValue>;
  cwd: string;
  extensionKind?: MelodyExtensionKind;
  kindExtensions: MelodyExtension[];
  loading: boolean;
  onChangeConfig: (path: string[], value: MelodyConfigValue) => void;
  onRefreshExtensions: () => void;
  onRefreshRules: () => void;
  onReloadConfig: () => void;
  onRemoveRule: (id: string) => void | Promise<void>;
  onSelectedPluginChange: (extension?: MelodyExtension) => void;
  onSkillQueryChange: (query: string) => void;
  onSkillStatusChange: (status: "all" | "enabled" | "disabled") => void;
  onToggleExtension: (
    extension: MelodyExtension,
    enabled: boolean,
  ) => void | Promise<void>;
  page: SettingsPage;
  reloadDisabled: boolean;
  rules: PermissionRule[];
  scope: MelodyConfigScope;
  selectedPlugin?: MelodyExtension;
  settingsViewKey: string;
  skillQuery: string;
  skillStatus: "all" | "enabled" | "disabled";
  togglingExtensions: Set<string>;
  visibleExtensions: MelodyExtension[];
  visibleExtensionGroups: SettingsExtensionGroup[];
}

export function SettingsContent({
  activeConfigSection,
  availableModels,
  configDocument,
  configValues,
  cwd,
  extensionKind,
  kindExtensions,
  loading,
  onChangeConfig,
  onRefreshExtensions,
  onRefreshRules,
  onReloadConfig,
  onRemoveRule,
  onSelectedPluginChange,
  onSkillQueryChange,
  onSkillStatusChange,
  onToggleExtension,
  page,
  reloadDisabled,
  rules,
  scope,
  selectedPlugin,
  settingsViewKey,
  skillQuery,
  skillStatus,
  togglingExtensions,
  visibleExtensions,
  visibleExtensionGroups,
}: SettingsContentProps) {
  return (
    <div className="settings-workspace-content relative min-h-0 min-w-0 flex-1">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 z-20 h-5 min-h-5"
        data-tauri-drag-region
      />

      <AnimatePresence initial={false} mode="wait">
        <MotionPage
          className="absolute inset-0 flex min-h-0 min-w-0 flex-col"
          key={settingsViewKey}
        >
          {page === "statistics" ? (
            <Suspense
              fallback={
                <p className="min-w-0 flex-1 p-8 text-muted-foreground text-sm">
                  正在加载统计…
                </p>
              }
            >
              <StatisticsPage cwd={cwd} />
            </Suspense>
          ) : page === "configuration" ? (
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              {configDocument?.parseError ? (
                <div className="m-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                  <p className="font-medium text-destructive text-sm">
                    配置文件包含无效的 TOML
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground text-xs">
                    {configDocument.parseError}
                  </p>
                  <p className="mt-2 text-muted-foreground text-xs">
                    请先在外部编辑器中修复该文件，然后重新加载。
                  </p>
                </div>
              ) : loading ? (
                <p className="p-6 text-muted-foreground text-sm">
                  正在加载设置…
                </p>
              ) : (
                <ConfigurationForm
                  availableModels={availableModels}
                  onChange={onChangeConfig}
                  onReload={() => onReloadConfig()}
                  reloadDisabled={reloadDisabled}
                  reloadLoading={loading}
                  sectionId={activeConfigSection}
                  scope={scope}
                  values={configValues}
                />
              )}
            </section>
          ) : page === "about" ? (
            <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              <AboutPage />
            </section>
          ) : extensionKind ? (
            <SettingsExtensionPage
              cwd={cwd}
              extensionKind={extensionKind}
              kindExtensions={kindExtensions}
              loading={loading}
              onRefresh={onRefreshExtensions}
              onSelectedPluginChange={onSelectedPluginChange}
              onSkillQueryChange={onSkillQueryChange}
              onSkillStatusChange={onSkillStatusChange}
              onToggleExtension={onToggleExtension}
              selectedPlugin={selectedPlugin}
              skillQuery={skillQuery}
              skillStatus={skillStatus}
              togglingExtensions={togglingExtensions}
              visibleExtensions={visibleExtensions}
              visibleExtensionGroups={visibleExtensionGroups}
            />
          ) : (
            <SettingsPermissionsPage
              loading={loading}
              onRefresh={onRefreshRules}
              onRemoveRule={onRemoveRule}
              rules={rules}
            />
          )}
        </MotionPage>
      </AnimatePresence>
    </div>
  );
}
