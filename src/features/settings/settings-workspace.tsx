import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toUserMessage } from "@/domain/app-error";
import type {
  MelodyConfigDocument,
  MelodyConfigPatch,
  MelodyConfigScope,
  MelodyConfigValue,
  MelodyExtension,
  MelodyExtensionKind,
} from "@/domain/config";
import type { PermissionRule } from "@/domain/permission";
import { MelodyCapabilityLifecycle } from "@/domain/melody-capability-lifecycle";
import { useAsyncOperation } from "@/hooks/use-async-operation";
import {
  deletePermissionRule,
  listInstalledMelodyPlugins,
  listMelodyExtensions,
  listMelodySkills,
  listPermissionRules,
  readMelodyConfig,
  setMelodyExtensionEnabled,
  updateMelodyConfig,
} from "@/lib/melody-bridge";
import { useAgentStore } from "@/stores/agent-store";

import { getConfigurationNavigation } from "./configuration-form";
import { SettingsContent } from "./settings-content";
import type { SettingsExtensionGroup } from "./settings-extension-page";
import {
  skillSourceGroupId,
  skillSourceGroups,
  type SkillSourceGroupId,
} from "./settings-extension-utils";
import { SettingsSidebar } from "./settings-sidebar";
import type { SettingsPage } from "./settings-types";

export type { SettingsPage } from "./settings-types";

const capabilityLifecycle = new MelodyCapabilityLifecycle({
  listDiscovered: listMelodyExtensions,
  listSkills: listMelodySkills,
  listInstalledPlugins: listInstalledMelodyPlugins,
  setEnabled: setMelodyExtensionEnabled,
});

interface SettingsWorkspaceProps {
  cwd: string;
  projectId: string;
  projectName?: string;
  initialPage?: SettingsPage;
  macSafeArea?: boolean;
  onClose: () => void;
}

export function SettingsWorkspace({
  cwd,
  projectId,
  initialPage = "configuration",
  onClose,
}: SettingsWorkspaceProps) {
  const availableModels = useAgentStore((state) => state.availableModels);
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [scope, setScope] = useState<MelodyConfigScope>("user");
  const [configSection, setConfigSection] = useState("general");
  const [document, setDocument] = useState<MelodyConfigDocument>();
  const [configValues, setConfigValues] = useState<
    Record<string, MelodyConfigValue>
  >({});
  const [configPatches, setConfigPatches] = useState<
    Record<string, MelodyConfigPatch>
  >({});
  const [extensions, setExtensions] = useState<MelodyExtension[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillStatus, setSkillStatus] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [selectedPlugin, setSelectedPlugin] = useState<MelodyExtension>();
  const [togglingExtensions, setTogglingExtensions] = useState<Set<string>>(
    () => new Set(),
  );
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const { state: configLoadState, run: runConfigLoad } = useAsyncOperation();
  const { state: extensionLoadState, run: runExtensionLoad } =
    useAsyncOperation();
  const { state: rulesLoadState, run: runRulesLoad } = useAsyncOperation();
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedSaveCountRef = useRef(0);
  const pendingConfigPatchesRef = useRef(configPatches);
  const scopeRef = useRef(scope);
  const cwdRef = useRef(cwd);
  pendingConfigPatchesRef.current = configPatches;
  scopeRef.current = scope;
  cwdRef.current = cwd;

  useEffect(() => {
    setPage(initialPage);
    setSelectedPlugin(undefined);
  }, [initialPage]);

  useEffect(
    () => () => {
      const pending = Object.values(pendingConfigPatchesRef.current);
      if (pending.length === 0) {
        return;
      }
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await updateMelodyConfig(scopeRef.current, cwdRef.current, pending);
        })
        .catch(() => undefined);
    },
    [],
  );

  const loadConfig = useCallback(
    (nextScope = scope) => {
      setError(undefined);
      void runConfigLoad(
        () => readMelodyConfig(nextScope, cwd),
        (nextDocument) => {
          setDocument(nextDocument);
          setConfigValues(nextDocument.values);
          setConfigPatches({});
        },
      ).catch(() => undefined);
    },
    [cwd, runConfigLoad, scope],
  );

  const loadExtensions = useCallback(async (): Promise<void> => {
    if (page !== "skills" && page !== "plugins" && page !== "hooks") {
      return;
    }
    const capabilityPage = page;
    setError(undefined);
    await runExtensionLoad(
      () => capabilityLifecycle.load(cwd, capabilityPage),
      setExtensions,
    );
  }, [cwd, page, runExtensionLoad]);

  const loadRules = useCallback(async (): Promise<void> => {
    setError(undefined);
    await runRulesLoad(() => listPermissionRules(projectId), setRules);
  }, [projectId, runRulesLoad]);

  const loading =
    page === "configuration"
      ? configLoadState.phase === "pending"
      : page === "permissions"
        ? rulesLoadState.phase === "pending"
        : page === "skills" || page === "plugins" || page === "hooks"
          ? extensionLoadState.phase === "pending"
          : false;
  const pageLoadError =
    page === "configuration"
      ? configLoadState.error
      : page === "permissions"
        ? rulesLoadState.error
        : page === "skills" || page === "plugins" || page === "hooks"
          ? extensionLoadState.error
          : undefined;
  const visibleError = pageLoadError ?? error;

  useEffect(() => {
    void loadConfig(scope);
  }, [loadConfig, scope]);

  useEffect(() => {
    void loadExtensions().catch(() => undefined);
  }, [loadExtensions]);

  useEffect(() => {
    if (page === "permissions") void loadRules().catch(() => undefined);
  }, [loadRules, page]);

  const removeRule = async (id: string) => {
    setError(undefined);
    try {
      await deletePermissionRule(projectId, id);
      setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (reason) {
      setError(toUserMessage(reason));
    }
  };

  const toggleExtension = async (
    extension: MelodyExtension,
    enabled: boolean,
  ) => {
    const key = `${extension.scope}:${extension.kind}:${extension.path}`;
    setError(undefined);
    setTogglingExtensions((current) => new Set(current).add(key));
    setExtensions((current) =>
      current.map((item) =>
        item.path === extension.path &&
        item.scope === extension.scope &&
        item.kind === extension.kind
          ? { ...item, enabled }
          : item,
      ),
    );
    try {
      const refreshed = await capabilityLifecycle.changeEnabled(
        cwd,
        extension,
        enabled,
      );
      if (refreshed) {
        setExtensions(refreshed);
      }
    } catch (reason) {
      setExtensions((current) =>
        current.map((item) =>
          item.path === extension.path &&
          item.scope === extension.scope &&
          item.kind === extension.kind
            ? { ...item, enabled: extension.enabled }
            : item,
        ),
      );
      setError(toUserMessage(reason));
    } finally {
      setTogglingExtensions((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const changeConfig = (path: string[], value: MelodyConfigValue) => {
    setConfigValues((current) => {
      const next = structuredClone(current);
      const [leaf] = path.slice(-1);
      if (!leaf) {
        return current;
      }
      let table = next;
      for (const key of path.slice(0, -1)) {
        const existing = table[key];
        if (
          !existing ||
          typeof existing !== "object" ||
          Array.isArray(existing)
        ) {
          table[key] = {};
        }
        table = table[key] as Record<string, MelodyConfigValue>;
      }
      if (value === null) {
        delete table[leaf];
      } else {
        table[leaf] = value;
      }
      return next;
    });
    setConfigPatches((current) => {
      const key = path.join("\u0000");
      const next = { ...current };
      if (
        value === null ||
        (typeof value === "object" && !Array.isArray(value))
      ) {
        for (const existingKey of Object.keys(next)) {
          if (existingKey.startsWith(`${key}\u0000`)) {
            delete next[existingKey];
          }
        }
      }
      next[key] = { path, value };
      return next;
    });
  };

  useEffect(() => {
    const entries = Object.entries(configPatches);
    if (entries.length === 0) {
      return;
    }
    const batch = Object.fromEntries(entries);
    const timer = window.setTimeout(() => {
      queuedSaveCountRef.current += 1;
      setSaving(true);
      setError(undefined);
      const operation = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            const nextDocument = await updateMelodyConfig(
              scope,
              cwd,
              Object.values(batch),
            );
            setDocument(nextDocument);
            setConfigPatches((current) => {
              const next = { ...current };
              for (const [key, patch] of entries) {
                if (current[key] === patch) {
                  delete next[key];
                }
              }
              return next;
            });
          } catch (reason) {
            setError(toUserMessage(reason));
          }
        })
        .finally(() => {
          queuedSaveCountRef.current -= 1;
          if (queuedSaveCountRef.current === 0) {
            setSaving(false);
          }
        });
      saveQueueRef.current = operation;
    }, 300);
    return () => window.clearTimeout(timer);
  }, [configPatches, cwd, scope]);

  const configNavigation = useMemo(
    () => getConfigurationNavigation(scope),
    [scope],
  );
  const extensionConfigNavigation = configNavigation.filter(
    (item) => item.id === "tools" || item.id === "mcp",
  );
  const primaryConfigNavigation = configNavigation.filter(
    (item) => item.id !== "tools" && item.id !== "mcp",
  );
  const activeConfigSection =
    configNavigation.find((item) => item.id === configSection)?.id ??
    configNavigation[0]?.id ??
    "general";
  const scopeLocked = saving || Object.keys(configPatches).length > 0;
  const changeScope = (nextScope: MelodyConfigScope) => {
    if (!scopeLocked && nextScope !== scope) {
      setScope(nextScope);
    }
  };
  const extensionKind: MelodyExtensionKind | undefined =
    page === "skills" || page === "plugins" || page === "hooks"
      ? page
      : undefined;
  const kindExtensions = useMemo(
    () =>
      extensionKind
        ? extensions.filter((extension) => extension.kind === extensionKind)
        : [],
    [extensionKind, extensions],
  );
  const visibleExtensions = useMemo(() => {
    if (extensionKind !== "skills") {
      return kindExtensions;
    }
    const query = skillQuery.trim().toLocaleLowerCase();
    return kindExtensions.filter((skill) => {
      if (
        skillStatus === "enabled"
          ? !skill.enabled
          : skillStatus === "disabled"
            ? skill.enabled
            : false
      ) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [
        skill.name,
        skill.description,
        skill.pluginName,
        skill.provider,
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [extensionKind, kindExtensions, skillQuery, skillStatus]);
  const visibleExtensionGroups = useMemo<SettingsExtensionGroup[]>(() => {
    if (extensionKind !== "skills") {
      return [
        {
          id: extensionKind ?? "extensions",
          label: undefined,
          description: undefined,
          items: visibleExtensions,
        },
      ];
    }
    const grouped = new Map<SkillSourceGroupId, MelodyExtension[]>();
    for (const skill of visibleExtensions) {
      const groupId = skillSourceGroupId(skill);
      grouped.set(groupId, [...(grouped.get(groupId) ?? []), skill]);
    }
    return skillSourceGroups.flatMap((group) => {
      const items = grouped.get(group.id);
      return items ? [{ ...group, items }] : [];
    });
  }, [extensionKind, visibleExtensions]);
  const settingsViewKey = selectedPlugin
    ? `${page}:${selectedPlugin.path}`
    : page === "configuration"
      ? `${page}:${scope}:${activeConfigSection}`
      : page;

  return (
    <section className="settings-workspace flex min-h-0 flex-1 flex-col bg-background">
      {visibleError ? (
        <p
          aria-live="assertive"
          className="motion-view-enter border-b bg-destructive/5 px-5 py-2 text-destructive text-sm"
          role="alert"
        >
          {visibleError}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <SettingsSidebar
          activeConfigSection={activeConfigSection}
          extensionConfigNavigation={extensionConfigNavigation}
          onChangeScope={changeScope}
          onClose={onClose}
          onSelectConfigSection={(section) => {
            setConfigSection(section);
            setPage("configuration");
            setSelectedPlugin(undefined);
          }}
          onSelectPage={(nextPage) => {
            setPage(nextPage);
            setSelectedPlugin(undefined);
          }}
          page={page}
          primaryConfigNavigation={primaryConfigNavigation}
          scope={scope}
          scopeLocked={scopeLocked}
        />

        <SettingsContent
          activeConfigSection={activeConfigSection}
          availableModels={availableModels}
          configDocument={document}
          configValues={configValues}
          cwd={cwd}
          extensionKind={extensionKind}
          kindExtensions={kindExtensions}
          loading={loading}
          onChangeConfig={changeConfig}
          onRefreshExtensions={loadExtensions}
          onRefreshRules={loadRules}
          onReloadConfig={() => loadConfig()}
          onRemoveRule={removeRule}
          onSelectedPluginChange={setSelectedPlugin}
          onSkillQueryChange={setSkillQuery}
          onSkillStatusChange={setSkillStatus}
          onToggleExtension={toggleExtension}
          page={page}
          reloadDisabled={loading || scopeLocked}
          rules={rules}
          scope={scope}
          selectedPlugin={selectedPlugin}
          settingsViewKey={settingsViewKey}
          skillQuery={skillQuery}
          skillStatus={skillStatus}
          togglingExtensions={togglingExtensions}
          visibleExtensions={visibleExtensions}
          visibleExtensionGroups={visibleExtensionGroups}
        />
      </div>
    </section>
  );
}
