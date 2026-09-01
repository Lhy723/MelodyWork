import {
  ArrowLeftIcon,
  ChartNoAxesCombinedIcon,
  InfoIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import type { MelodyConfigScope } from "@/domain/config";
import type { ConfigurationNavigationItem } from "./configuration-form";
import { cn } from "@/lib/utils";

import { kindIcon, kindLabel, type SettingsPage } from "./settings-types";

const settingsSidebarGroupClass =
  "mt-5 px-2 pb-1.5 font-semibold text-muted-foreground text-xs tracking-[0.04em]";
const settingsSidebarItemClass =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors";
const settingsSidebarItemState = (selected: boolean) =>
  selected
    ? "bg-muted font-medium text-foreground"
    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground";

interface SettingsSidebarProps {
  activeConfigSection: string;
  extensionConfigNavigation: ConfigurationNavigationItem[];
  onChangeScope: (scope: MelodyConfigScope) => void;
  onClose: () => void;
  onSelectConfigSection: (section: string) => void;
  onSelectPage: (page: SettingsPage) => void;
  page: SettingsPage;
  primaryConfigNavigation: ConfigurationNavigationItem[];
  scope: MelodyConfigScope;
  scopeLocked: boolean;
}

export function SettingsSidebar({
  activeConfigSection,
  extensionConfigNavigation,
  onChangeScope,
  onClose,
  onSelectConfigSection,
  onSelectPage,
  page,
  primaryConfigNavigation,
  scope,
  scopeLocked,
}: SettingsSidebarProps) {
  const scopeTabRefs = useRef<
    Record<MelodyConfigScope, HTMLButtonElement | null>
  >({
    user: null,
    project: null,
  });
  return (
    <aside
      className="settings-sidebar-scroll flex w-56 shrink-0 flex-col overflow-y-auto border-r"
      data-app-sidebar
      data-settings-sidebar
    >
      <div
        className="harness-window-titlebar shrink-0"
        data-tauri-drag-region
      />

      <div className="px-3 py-4">
        <Button
          aria-label="返回对话"
          className="mb-3 w-full justify-start gap-2 px-2 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          size="sm"
          title="返回对话"
          variant="ghost"
        >
          <ArrowLeftIcon />
          返回对话
        </Button>
        <div className="mb-4 border-b pb-4">
          <p className="px-1 pb-2 font-semibold text-muted-foreground text-xs tracking-[0.04em]">
            配置范围
          </p>
          <div
            aria-label="配置范围"
            className="settings-scope-switcher"
            role="radiogroup"
          >
            {(["user", "project"] as const).map((item) => (
              <Button
                aria-checked={scope === item}
                className="settings-scope-button h-8 w-full justify-center px-2 text-xs"
                data-selected={scope === item ? "true" : undefined}
                disabled={scopeLocked}
                key={item}
                onClick={() => onChangeScope(item)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                    return;
                  }
                  event.preventDefault();
                  const nextScope = item === "user" ? "project" : "user";
                  onChangeScope(nextScope);
                  scopeTabRefs.current[nextScope]?.focus();
                }}
                ref={(element) => {
                  scopeTabRefs.current[item] = element;
                }}
                role="radio"
                tabIndex={scope === item ? 0 : -1}
                type="button"
                variant="ghost"
              >
                {item === "user" ? "应用" : "当前项目"}
              </Button>
            ))}
          </div>
        </div>
        <nav aria-label="设置分类">
          <button
            aria-current={page === "statistics" ? "page" : undefined}
            className={cn(
              "mb-4",
              settingsSidebarItemClass,
              settingsSidebarItemState(page === "statistics"),
            )}
            onClick={() => {
              onSelectPage("statistics");
            }}
            type="button"
          >
            <ChartNoAxesCombinedIcon className="size-3.5" />
            统计
          </button>
          <p className={settingsSidebarGroupClass}>
            {scope === "project" ? "项目配置" : "应用配置"}
          </p>
          <div className="flex flex-col gap-0.5">
            {primaryConfigNavigation.map((item) => {
              const Icon = item.icon;
              const selected =
                page === "configuration" && activeConfigSection === item.id;
              return (
                <button
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    settingsSidebarItemClass,
                    settingsSidebarItemState(selected),
                  )}
                  key={item.id}
                  onClick={() => {
                    onSelectConfigSection(item.id);
                  }}
                  type="button"
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>

          <p className={settingsSidebarGroupClass}>扩展</p>
          <div className="flex flex-col gap-0.5">
            {extensionConfigNavigation.map((item) => {
              const Icon = item.icon;
              const selected =
                page === "configuration" && activeConfigSection === item.id;
              return (
                <button
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    settingsSidebarItemClass,
                    settingsSidebarItemState(selected),
                  )}
                  key={item.id}
                  onClick={() => {
                    onSelectConfigSection(item.id);
                  }}
                  type="button"
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </button>
              );
            })}
            {(["skills", "plugins", "hooks"] as const).map((kind) => {
              const Icon = kindIcon[kind];
              const selected = page === kind;
              return (
                <button
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    settingsSidebarItemClass,
                    settingsSidebarItemState(selected),
                  )}
                  key={kind}
                  onClick={() => {
                    onSelectPage(kind);
                  }}
                  type="button"
                >
                  <Icon className="size-3.5" />
                  {kindLabel[kind]}
                </button>
              );
            })}
          </div>

          <p className={settingsSidebarGroupClass}>安全</p>
          <button
            aria-current={page === "permissions" ? "page" : undefined}
            className={cn(
              settingsSidebarItemClass,
              settingsSidebarItemState(page === "permissions"),
            )}
            onClick={() => {
              onSelectPage("permissions");
            }}
            type="button"
          >
            <ShieldCheckIcon className="size-3.5" />
            权限
          </button>

          <p className={settingsSidebarGroupClass}>关于</p>
          <button
            aria-current={page === "about" ? "page" : undefined}
            className={cn(
              settingsSidebarItemClass,
              settingsSidebarItemState(page === "about"),
            )}
            onClick={() => {
              onSelectPage("about");
            }}
            type="button"
          >
            <InfoIcon className="size-3.5" />
            关于 MelodyWork
          </button>
        </nav>
      </div>
    </aside>
  );
}
