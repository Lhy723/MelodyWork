import {
  DownloadIcon,
  GitCompareArrowsIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileWorkspace } from "@/features/files/file-workspace";
import { ChangeReview } from "@/features/git/change-review";
import { GitWorkspace } from "@/features/git/git-workspace";
import { AppSidebar } from "@/features/sessions/app-sidebar";
import { SettingsWorkspace } from "@/features/settings/settings-workspace";
import { TerminalPanel } from "@/features/terminal/terminal-panel";
import { useAgentBridge } from "@/hooks/use-agent-bridge";
import { useGitChanges } from "@/hooks/use-git-changes";
import { useSessionPersistence } from "@/hooks/use-session-persistence";
import { useWorkspace } from "@/hooks/use-workspace";
import { useAgentStore } from "@/stores/agent-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  checkAppUpdate,
  type AppUpdateStatus,
} from "@/lib/melody-bridge";

import { AgentComposer } from "./agent-composer";
import { AgentTimeline } from "./agent-timeline";

const statusLabel = {
  stopped: "Preview",
  starting: "Starting",
  running: "Connected",
  missing: "Sidecar missing",
  failed: "Bridge error",
} as const;

const sessionStatusLabel = (
  agentPhase: keyof typeof statusLabel,
  sessionPhase: ReturnType<typeof useAgentStore.getState>["acpPhase"],
) => {
  if (agentPhase !== "running") {
    return statusLabel[agentPhase];
  }
  if (sessionPhase === "initializing" || sessionPhase === "creating") {
    return "Starting session";
  }
  if (sessionPhase === "prompting") {
    return "Working";
  }
  return sessionPhase === "ready" ? "Connected" : statusLabel.running;
};

export function AgentWorkspace() {
  useWorkspace();

  const projects = useWorkspaceStore((state) => state.projects);
  const sessions = useWorkspaceStore((state) => state.sessions);
  const activeProject = useWorkspaceStore((state) => state.activeProject);
  const activeSession = useWorkspaceStore((state) => state.activeSession);
  const workspaceLoading = useWorkspaceStore((state) => state.loading);
  const chooseProject = useWorkspaceStore((state) => state.chooseProject);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const createSession = useWorkspaceStore((state) => state.createSession);
  const selectSession = useWorkspaceStore((state) => state.selectSession);

  useAgentBridge(activeSession);
  useSessionPersistence();

  const cwd = activeSession?.cwd ?? activeProject?.path ?? ".";
  const status = useAgentStore((state) => state.status);
  const acpPhase = useAgentStore((state) => state.acpPhase);
  const timeline = useAgentStore((state) => state.timeline);
  const chatStatus = useAgentStore((state) => state.chatStatus);
  const submitPrompt = useAgentStore((state) => state.submitPrompt);
  const resolvePermission = useAgentStore(
    (state) => state.resolvePermission,
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus>();
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const git = useGitChanges(cwd);

  useEffect(() => {
    void checkAppUpdate()
      .then(setAppUpdate)
      .catch(() => undefined);
  }, []);

  const installAppUpdate = async () => {
    setInstallingUpdate(true);
    try {
      setAppUpdate(await checkAppUpdate(true));
    } finally {
      setInstallingUpdate(false);
    }
  };

  return (
    <main className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
      <AppSidebar
        activeProject={activeProject}
        activeSessionId={activeSession?.id}
        loading={workspaceLoading}
        onChooseProject={() => void chooseProject()}
        onNewSession={() => void createSession()}
        onOpenGit={() => setGitOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onSelectProject={(project) => void selectProject(project)}
        onSelectSession={selectSession}
        projects={projects}
        sessions={sessions}
      />
      <section className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold text-base">
              {activeSession?.title ?? "Opening workspace…"}
            </h1>
            <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-current"
              />
              {sessionStatusLabel(status.phase, acpPhase)}
            </div>
          </div>
          <Button onClick={() => setReviewOpen(true)} variant="outline">
            <GitCompareArrowsIcon data-icon="inline-start" />
            {git.loading ? "Checking changes" : `${git.changes.length} changes`}
          </Button>
          {appUpdate?.available ? (
            <Button
              disabled={installingUpdate}
              onClick={() => void installAppUpdate()}
              variant="outline"
            >
              <DownloadIcon />
              {installingUpdate
                ? "Installing update"
                : `Update to ${appUpdate.version}`}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="Session actions"
                size="icon"
                variant="ghost"
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setFilesOpen(true)}>
                Open files
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTerminalOpen(true)}>
                Open terminal
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setGitOpen(true)}>
                Open Git
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <AgentTimeline
          entries={timeline}
          onPermission={resolvePermission}
        />
        <AgentComposer onSubmit={submitPrompt} status={chatStatus} />
        {reviewOpen ? (
          <ChangeReview
            changes={git.changes}
            cwd={cwd}
            error={git.error}
            loading={git.loading}
            onClose={() => setReviewOpen(false)}
            onRefresh={() => void git.refresh()}
          />
        ) : null}
        {gitOpen ? (
          <GitWorkspace
            changes={git.changes}
            cwd={cwd}
            onClose={() => setGitOpen(false)}
            onRefreshChanges={() => void git.refresh()}
          />
        ) : null}
        {filesOpen ? (
          <FileWorkspace
            onClose={() => setFilesOpen(false)}
            root={cwd}
          />
        ) : null}
        {terminalOpen ? (
          <TerminalPanel
            cwd={cwd}
            onClose={() => setTerminalOpen(false)}
          />
        ) : null}
        {settingsOpen ? (
          <SettingsWorkspace
            cwd={cwd}
            onClose={() => setSettingsOpen(false)}
            projectId={activeProject?.id ?? "preview-project"}
          />
        ) : null}
      </section>
    </main>
  );
}
