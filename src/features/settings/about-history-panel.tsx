import { ExternalLinkIcon, HistoryIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Accordion, type AccordionItem } from "@/components/interior/accordion";
import { LoadingButton } from "@/components/interior/loading-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AppReleaseHistoryItem } from "@/lib/melody-bridge";

import { PanelHeader } from "./about-ui";
import { formatReleaseDate, releaseVersion } from "./about-types";

export function AboutHistoryPanel({
  currentVersion,
  releaseHistory,
  state,
  onRefresh,
  onOpenRelease,
}: {
  currentVersion: string;
  releaseHistory: AppReleaseHistoryItem[];
  state: "idle" | "loading" | "ready" | "error";
  onRefresh: () => Promise<void>;
  onOpenRelease: (url: string) => void;
}) {
  const preferredRelease =
    releaseHistory.find(
      (release) => releaseVersion(release.tagName) === currentVersion,
    ) ?? releaseHistory[0];
  const releaseIds = useMemo(
    () => releaseHistory.map((release) => release.tagName),
    [releaseHistory],
  );
  const previousReleaseIds = useRef<string[] | null>(null);
  const [openReleaseIds, setOpenReleaseIds] = useState<string[]>(() =>
    preferredRelease ? [preferredRelease.tagName] : [],
  );

  useEffect(() => {
    const listChanged =
      previousReleaseIds.current !== null &&
      (previousReleaseIds.current.length !== releaseIds.length ||
        previousReleaseIds.current.some(
          (id, index) => id !== releaseIds[index],
        ));
    previousReleaseIds.current = releaseIds;

    setOpenReleaseIds((current) => {
      const available = new Set(releaseIds);
      const retained = current.filter((id) => available.has(id));
      if (retained.length > 0 && !listChanged) return retained.slice(0, 1);
      const next =
        releaseHistory.find(
          (release) => releaseVersion(release.tagName) === currentVersion,
        ) ?? releaseHistory[0];
      return next ? [next.tagName] : [];
    });
  }, [currentVersion, releaseHistory, releaseIds]);

  const releaseItems: AccordionItem[] = releaseHistory.map((release) => {
    const version = releaseVersion(release.tagName);
    const isCurrent = version === currentVersion;

    return {
      id: release.tagName,
      meta: formatReleaseDate(release.publishedAt),
      title: (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{release.tagName}</span>
            {isCurrent ? <Badge>当前</Badge> : null}
            {release.isPrerelease ? (
              <Badge variant="outline">测试版</Badge>
            ) : null}
          </div>
          <p className="mt-1 truncate text-muted-foreground text-xs">
            {release.name}
          </p>
        </div>
      ),
      content: (
        <>
          <p className="whitespace-pre-wrap text-muted-foreground text-xs">
            {release.body?.trim() || "此版本未提供更新说明。"}
          </p>
          <Button
            className="mt-3"
            onClick={() => onOpenRelease(release.url)}
            size="xs"
            variant="ghost"
          >
            查看发布详情
            <ExternalLinkIcon />
          </Button>
        </>
      ),
    };
  });

  return (
    <section
      aria-labelledby="about-history-title"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <PanelHeader
        action={
          <LoadingButton
            disabled={state === "loading"}
            errorLabel="重试"
            icon={<RefreshCwIcon />}
            onAction={onRefresh}
            pendingLabel="刷新中…"
            size="sm"
            successLabel="已刷新"
            variant="secondary"
          >
            刷新
          </LoadingButton>
        }
        description="查看已发布版本和对应的更新说明。"
        title={
          <>
            <HistoryIcon className="size-4 text-muted-foreground" />
            <span id="about-history-title">版本历史</span>
          </>
        }
      />
      <Accordion
        className="rounded-none border-0 bg-transparent shadow-none"
        maxPanelHeight={280}
        onOpenChange={setOpenReleaseIds}
        open={openReleaseIds}
        items={releaseItems}
        type="single"
      />
      {state === "error" ? (
        <p className="border-t px-5 py-3 text-muted-foreground text-xs">
          无法读取在线版本历史，当前显示内置记录。
        </p>
      ) : null}
    </section>
  );
}
