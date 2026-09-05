import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { MelodyConfigValue } from "@/domain/config";
import { cn } from "@/lib/utils";

import type {
  CompatibilityGroup,
  ConfigValues,
  ConfigurationFormProps,
  SettingDefinition,
  SettingSection,
} from "./configuration-types";

export function valueAt(
  values: ConfigValues,
  path: string[],
): MelodyConfigValue | undefined {
  let current: MelodyConfigValue = values;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

export function hasValue(values: ConfigValues, path: string[]) {
  return valueAt(values, path) !== undefined;
}

export function SettingControl({
  definition,
  values,
  onChange,
}: {
  definition: SettingDefinition;
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  const explicit = valueAt(values, definition.path);
  const value = explicit ?? definition.defaultValue;

  if (definition.kind === "agents-skills-source") {
    const ignoreValue = valueAt(values, ["skills", "ignore"]);
    const ignored = Array.isArray(ignoreValue)
      ? ignoreValue.filter((item): item is string => typeof item === "string")
      : [];
    const managedPaths = new Set(["~/.agents", ".agents"]);
    const checked = !ignored.some((path) => managedPaths.has(path));
    return (
      <Switch
        aria-label={definition.label}
        checked={checked}
        onCheckedChange={(next) => {
          const preserved = ignored.filter((path) => !managedPaths.has(path));
          const updated = next
            ? preserved
            : [...preserved, "~/.agents", ".agents"];
          onChange(["skills", "ignore"], updated.length > 0 ? updated : null);
        }}
      />
    );
  }

  if (definition.kind === "boolean") {
    const checked = Boolean(value);
    return (
      <Switch
        aria-label={definition.label}
        checked={checked}
        onCheckedChange={(next) => onChange(definition.path, next)}
      />
    );
  }

  if (definition.kind === "select") {
    const selectedValue =
      typeof explicit === "string"
        ? explicit
        : (definition.clearValue ?? (typeof value === "string" ? value : ""));
    return (
      <Select
        onValueChange={(next) =>
          onChange(
            definition.path,
            next === definition.clearValue ? null : next,
          )
        }
        value={selectedValue}
      >
        <SelectTrigger aria-label={definition.label} className="w-44">
          <SelectValue placeholder="使用默认值" />
        </SelectTrigger>
        <SelectContent>
          {definition.options?.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (definition.kind === "string-list" || definition.kind === "key-value") {
    const textValue =
      definition.kind === "string-list"
        ? Array.isArray(explicit)
          ? explicit
              .filter((item): item is string => typeof item === "string")
              .join("\n")
          : ""
        : explicit && typeof explicit === "object" && !Array.isArray(explicit)
          ? Object.entries(explicit)
              .map(([key, item]) => `${key}=${String(item)}`)
              .join("\n")
          : "";
    return (
      <textarea
        aria-label={definition.label}
        className="min-h-20 w-64 resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-xs outline-none transition-[color,background-color,border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        onChange={(event) => {
          if (definition.kind === "string-list") {
            const next = event.target.value
              .split(/\r?\n|,/)
              .map((item) => item.trim())
              .filter(Boolean);
            onChange(definition.path, next.length > 0 ? next : null);
            return;
          }
          const next: Record<string, string | number> = {};
          for (const line of event.target.value.split(/\r?\n/)) {
            const [key, item] = line.split(/=(.*)/s);
            if (!key?.trim() || item === undefined) {
              continue;
            }
            if (!definition.numberValues) {
              next[key.trim()] = item.trim();
              continue;
            }
            const number = Number(item.trim());
            if (Number.isFinite(number)) {
              next[key.trim()] = number;
            }
          }
          onChange(definition.path, Object.keys(next).length > 0 ? next : null);
        }}
        placeholder={
          definition.placeholder ??
          (definition.kind === "key-value" ? "名称=值" : undefined)
        }
        value={textValue}
      />
    );
  }

  return (
    <Input
      aria-label={definition.label}
      className="w-52"
      max={definition.max}
      min={definition.min}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(
          definition.path,
          definition.kind === "number"
            ? raw === ""
              ? null
              : Number(raw)
            : raw === ""
              ? null
              : raw,
        );
      }}
      placeholder={definition.placeholder ?? "使用默认值"}
      step={definition.step}
      type={
        definition.secret
          ? "password"
          : definition.kind === "number"
            ? "number"
            : "text"
      }
      value={
        explicit === undefined || explicit === null
          ? ""
          : typeof explicit === "string" || typeof explicit === "number"
            ? explicit
            : ""
      }
    />
  );
}

export function SettingsList({
  section,
  values,
  onChange,
}: {
  section: SettingSection;
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {section.settings.map((definition, index) => (
        <div
          className={cn(
            "flex min-h-16 items-center gap-5 px-4 py-3",
            index > 0 && "border-t",
          )}
          key={definition.path.join(".")}
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">{definition.label}</p>
            <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
              {definition.description}
              {definition.defaultValue !== undefined &&
              !hasValue(values, definition.path)
                ? ` 默认：${String(definition.defaultValue)}`
                : ""}
            </p>
          </div>
          <SettingControl
            definition={definition}
            onChange={onChange}
            values={values}
          />
        </div>
      ))}
    </div>
  );
}

export function CompatibilitySettings({
  groups,
  section,
  values,
  onChange,
}: {
  groups: readonly CompatibilityGroup[];
  section: SettingSection;
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  return (
    <div className="grid gap-6">
      {groups.map((group) => {
        const settings = section.settings.filter(
          (definition) => definition.path[1] === group.id,
        );
        return (
          <section key={group.id}>
            <h4 className="font-medium text-sm">{group.label}</h4>
            <p className="mt-0.5 mb-2 text-muted-foreground text-xs">
              {group.description}
            </p>
            <SettingsList
              onChange={onChange}
              section={{
                ...section,
                id: group.id,
                label: group.label,
                settings,
              }}
              values={values}
            />
          </section>
        );
      })}
    </div>
  );
}
