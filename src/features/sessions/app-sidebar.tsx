import {
  AudioLinesIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectRecord, SessionRecord } from "@/domain/workspace";
import { cn } from "@/lib/utils";

interface AppSidebarProps {
  activeProject?: ProjectRecord;
  activeSessionId?: string;
  loading: boolean;
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  onChooseProject: () => void;
  onOpenGit: () => void;
  onOpenSettings: () => void;
  onNewSession: () => void;
  onSelectProject: (project: ProjectRecord) => void;
  onSelectSession: (session: SessionRecord) => void;
}

const relativeTime = (timestamp: number) => {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (elapsed < 60) {
    return "Now";
  }
  if (elapsed < 86_400) {
    return `${Math.max(1, Math.floor(elapsed / 3_600))}h`;
  }
  if (elapsed < 172_800) {
    return "Yesterday";
  }
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};

export function AppSidebar({
  activeProject,
  activeSessionId,
  loading,
  projects,
  sessions,
  onChooseProject,
  onNewSession,
  onOpenGit,
  onOpenSettings,
  onSelectProject,
  onSelectSession,
}: AppSidebarProps) {
  return (
    <aside className="flex min-h-0 w-64 shrink-0 flex-col border-r bg-sidebar p-3 text-sidebar-foreground">
      <div className="flex h-11 items-center gap-2 px-2 font-semibold">
        <AudioLinesIcon aria-hidden="true" className="size-5" />
        <span>MelodyWork</span>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="mt-2 h-11 justify-between rounded-xl px-3"
            variant="ghost"
          >
            <span className="min-w-0 truncate">
              {activeProject?.name ?? "Select workspace"}
            </span>
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {projects.map((project) => (
            <DropdownMenuItem
              key={project.id}
              onSelect={() => onSelectProject(project)}
            >
              <FolderOpenIcon />
              <span className="truncate">{project.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onChooseProject}>
            <PlusIcon />
            Open workspace…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        className="mt-3 justify-start"
        disabled={loading || !activeProject}
        onClick={onNewSession}
        variant="outline"
      >
        <PlusIcon data-icon="inline-start" />
        New session
      </Button>

      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <p className="px-2 pb-2 font-medium text-muted-foreground text-xs">
          Sessions
        </p>
        <nav
          aria-label="Sessions"
          className="flex min-h-0 flex-col gap-1 overflow-y-auto"
        >
          {sessions.map((session) => {
            const selected = session.id === activeSessionId;
            return (
              <button
                className={cn(
                  "flex min-h-12 w-full items-center gap-2 rounded-xl px-2.5 text-left text-sm transition-colors",
                  selected
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
                key={session.id}
                onClick={() => onSelectSession(session)}
                title={session.title}
                type="button"
              >
                <MessageSquareIcon
                  aria-hidden="true"
                  className="size-4 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {relativeTime(session.updatedAt)}
                </span>
              </button>
            );
          })}
          {!loading && sessions.length === 0 ? (
            <p className="px-3 py-6 text-center text-muted-foreground text-xs">
              No sessions yet.
            </p>
          ) : null}
        </nav>
      </div>

      <nav aria-label="Workspace" className="flex flex-col gap-1 border-t pt-3">
        <Button className="justify-start" onClick={onOpenGit} variant="ghost">
          <GitBranchIcon data-icon="inline-start" />
          Git
        </Button>
        <Button
          className="justify-start"
          onClick={onOpenSettings}
          variant="ghost"
        >
          <SettingsIcon data-icon="inline-start" />
          Settings
        </Button>
      </nav>
    </aside>
  );
}
