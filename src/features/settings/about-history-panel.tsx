import {
  ChevronDownIcon,
  ExternalLinkIcon,
  HistoryIcon,
  RefreshCwIcon,
} from "lucide-react";

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
      <div className="divide-y">
        {releaseHistory.map((release) => {
          const version = releaseVersion(release.tagName);
          const isCurrent = version === currentVersion;
          return (
            <details className="group" key={release.tagName}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
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
                <div className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
                  <span>{formatReleaseDate(release.publishedAt)}</span>
                  <ChevronDownIcon className="size-4 transition-transform group-open:rotate-180" />
                </div>
              </summary>
              <div className="border-t bg-muted/20 px-5 py-4">
                <p className="whitespace-pre-wrap text-muted-foreground text-xs">
                  {release.body?.trim() || "此版本未提供更新说明。"}
                </p>
                <Button
                  className="mt-3"
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenRelease(release.url);
                  }}
                  size="xs"
                  variant="ghost"
                >
                  查看发布详情
                  <ExternalLinkIcon />
                </Button>
              </div>
            </details>
          );
        })}
      </div>
      {state === "error" ? (
        <p className="border-t px-5 py-3 text-muted-foreground text-xs">
          无法读取在线版本历史，当前显示内置记录。
        </p>
      ) : null}
    </section>
  );
}
