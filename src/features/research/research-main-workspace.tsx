import { AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";

import { MotionPage } from "@/components/motion/page-transition";
import type { ResearchPaper } from "@/domain/research";

import { CapabilitiesWorkspace } from "./research-capability-workspaces";
import {
  ExperimentWorkspace,
  KnowledgeWorkspace,
  SandboxWorkspace,
} from "./research-capability-resource-workspaces";
import {
  InboxWorkspace,
  LibraryWorkspace,
  PaperDetailWorkspace,
  SearchWorkspace,
  TrackingDetailWorkspace,
  TrackingWorkspace,
} from "./research-literature-workspaces";
import { ResearchOverviewWorkspace } from "./research-overview-workspace";
import { useResearchStore } from "./research-store";
import { ResearchViewLayer } from "./research-ui";

export type ResearchMainKind =
  | "overview"
  | "knowledge"
  | "library"
  | "experiments"
  | "sandbox"
  | "search"
  | "tracking"
  | "inbox"
  | "capabilities";
export type ResearchMainDetail =
  | {
      type: "paper";
      paper: ResearchPaper;
      returnTo?: { type: "tracking"; topicId: string };
    }
  | { type: "tracking"; topicId: string };
export function ResearchMainWorkspace({
  cwd,
  detail,
  kind,
  onNavigate,
  onAskPaper,
  onCloseDetail,
  onOpenPaper,
  onOpenTrackingTopic,
  projectId,
  projectName,
  root,
}: {
  cwd: string;
  detail?: ResearchMainDetail;
  kind: ResearchMainKind;
  onNavigate: (kind: ResearchMainKind) => void;
  onAskPaper?: (paper: ResearchPaper) => void;
  onCloseDetail: () => void;
  onOpenPaper: (paper: ResearchPaper) => void;
  onOpenTrackingTopic: (topicId: string) => void;
  projectId?: string;
  projectName: string;
  root: string;
}) {
  const setActiveProject = useResearchStore((state) => state.setActiveProject);
  const [visitedKinds, setVisitedKinds] = useState<Set<ResearchMainKind>>(
    () => new Set([kind]),
  );

  useEffect(() => {
    setActiveProject(projectId);
  }, [projectId, setActiveProject]);

  useEffect(() => {
    setVisitedKinds((current) => {
      if (current.has(kind)) return current;
      return new Set(current).add(kind);
    });
  }, [kind]);

  const detailActive = Boolean(detail);
  const renderedKinds = visitedKinds.has(kind)
    ? visitedKinds
    : new Set(visitedKinds).add(kind);

  return (
    <div className="relative size-full min-h-0">
      <ResearchViewLayer
        active={kind === "overview" && !detailActive}
        mounted={renderedKinds.has("overview")}
      >
        <ResearchOverviewWorkspace
          key={`overview:${projectId ?? "unscoped"}`}
          onNavigate={onNavigate}
          onOpenPaper={onOpenPaper}
          projectName={projectName}
        />
      </ResearchViewLayer>
      <ResearchViewLayer
        active={kind === "search" && !detailActive}
        mounted={renderedKinds.has("search")}
      >
        <SearchWorkspace
          key={`search:${projectId ?? "unscoped"}`}
          onOpenPaper={onOpenPaper}
          onNavigate={onNavigate}
          projectName={projectName}
        />
      </ResearchViewLayer>
      <ResearchViewLayer
        active={kind === "tracking" && !detailActive}
        mounted={renderedKinds.has("tracking")}
      >
        <TrackingWorkspace
          key={`tracking:${projectId ?? "unscoped"}`}
          onOpenTopic={onOpenTrackingTopic}
          onNavigate={onNavigate}
          projectName={projectName}
        />
      </ResearchViewLayer>
      <ResearchViewLayer
        active={kind === "inbox" && !detailActive}
        mounted={renderedKinds.has("inbox")}
      >
        <InboxWorkspace
          key={`inbox:${projectId ?? "unscoped"}`}
          onAskPaper={onAskPaper}
          onOpenPaper={onOpenPaper}
          onNavigate={onNavigate}
          projectName={projectName}
        />
      </ResearchViewLayer>

      <AnimatePresence initial={false} mode="wait">
        {kind === "knowledge" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`knowledge:${projectId ?? "unscoped"}`}
          >
            <KnowledgeWorkspace
              onOpenPaper={onOpenPaper}
              onNavigate={onNavigate}
              projectName={projectName}
            />
          </MotionPage>
        ) : null}
        {kind === "library" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`library:${projectId ?? "unscoped"}`}
          >
            <LibraryWorkspace
              onOpenPaper={onOpenPaper}
              onNavigate={onNavigate}
              projectName={projectName}
            />
          </MotionPage>
        ) : null}
        {kind === "experiments" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`experiments:${projectId ?? "unscoped"}`}
          >
            <ExperimentWorkspace projectName={projectName} root={root} />
          </MotionPage>
        ) : null}
        {kind === "sandbox" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`sandbox:${projectId ?? "unscoped"}`}
          >
            <SandboxWorkspace cwd={cwd} projectName={projectName} />
          </MotionPage>
        ) : null}
        {kind === "capabilities" && !detailActive ? (
          <MotionPage
            className="absolute inset-0"
            key={`capabilities:${projectId ?? "unscoped"}`}
          >
            <CapabilitiesWorkspace
              cwd={cwd}
              onNavigate={onNavigate}
              projectName={projectName}
            />
          </MotionPage>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false} mode="wait">
        {detail?.type === "paper" ? (
          <MotionPage
            className="absolute inset-0 z-20"
            key={`paper:${detail.paper.id}`}
          >
            <PaperDetailWorkspace
              initialPaper={detail.paper}
              onAskPaper={onAskPaper}
              onBack={onCloseDetail}
              projectName={projectName}
            />
          </MotionPage>
        ) : detail?.type === "tracking" ? (
          <MotionPage
            className="absolute inset-0 z-20"
            key={`tracking-detail:${detail.topicId}`}
          >
            <TrackingDetailWorkspace
              onBack={onCloseDetail}
              onOpenPaper={onOpenPaper}
              projectName={projectName}
              topicId={detail.topicId}
            />
          </MotionPage>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
