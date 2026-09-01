import { GitBranchIcon, InfoIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import type { EnvironmentCapability } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

export function InfoRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1 border-b px-5 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <p className="font-medium text-sm">{label}</p>
        {description ? (
          <p className="mt-1 text-muted-foreground text-xs">{description}</p>
        ) : null}
      </div>
      <div className="min-w-0 text-left text-muted-foreground text-sm sm:text-right">
        {children}
      </div>
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="flex items-center gap-2 font-semibold text-base">
          {title}
        </h3>
        {description ? (
          <p className="mt-1 text-muted-foreground text-xs">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CapabilityCard({
  capability,
}: {
  capability: EnvironmentCapability;
}) {
  return (
    <div className="rounded-lg border bg-muted/35 p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
            capability.installed
              ? "bg-emerald-500/15 text-emerald-500"
              : "bg-muted text-muted-foreground",
          )}
        >
          {capability.installed ? (
            capability.name === "Git" ? (
              <GitBranchIcon className="size-3.5" />
            ) : (
              <TerminalIcon className="size-3.5" />
            )
          ) : (
            <InfoIcon className="size-3.5" />
          )}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-sm">{capability.name}</p>
            {capability.installed && capability.version ? (
              <Badge className="font-mono" variant="secondary">
                {capability.version}
              </Badge>
            ) : (
              <Badge variant="outline">未安装</Badge>
            )}
          </div>
          <p className="mt-1 text-muted-foreground text-xs">
            {capability.description}
          </p>
        </div>
      </div>
    </div>
  );
}

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"
        fillRule="evenodd"
      />
    </svg>
  );
}
