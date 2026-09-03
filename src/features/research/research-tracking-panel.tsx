import { PlusIcon, RadarIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { LoadingButton } from "@/components/interior/loading-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toUserMessage } from "@/domain/app-error";
import { RequestGate } from "@/domain/request-gate";

import { searchResearchPapers } from "./research-api";
import { useResearchStore } from "./research-store";

export function TrackingPanel() {
  const topics = useResearchStore((state) => state.trackingTopics);
  const addTrackingTopic = useResearchStore((state) => state.addTrackingTopic);
  const refreshTrackingTopic = useResearchStore(
    (state) => state.refreshTrackingTopic,
  );
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState<string>();
  const [error, setError] = useState<string>();
  const refreshGatesRef = useRef(new Map<string, RequestGate>());

  const refresh = async (id: string, topicQuery: string) => {
    const gate = refreshGatesRef.current.get(id) ?? new RequestGate();
    refreshGatesRef.current.set(id, gate);
    const requestToken = gate.begin();
    setRefreshing(id);
    setError(undefined);
    try {
      const result = await searchResearchPapers(topicQuery);
      if (!gate.isCurrent(requestToken)) return;
      refreshTrackingTopic(id, result.papers);
    } catch (reason) {
      if (!gate.isCurrent(requestToken)) return;
      setError(toUserMessage(reason));
      throw reason;
    } finally {
      if (gate.isCurrent(requestToken)) {
        setRefreshing((current) => (current === id ? undefined : current));
      }
    }
  };

  useEffect(
    () => () => {
      for (const gate of refreshGatesRef.current.values()) {
        gate.invalidate();
      }
    },
    [],
  );

  return (
    <div className="size-full overflow-y-auto">
      <div className="border-b p-3">
        <div className="flex items-center gap-2">
          <Input
            onChange={(event) => setTitle(event.target.value)}
            placeholder="追踪主题名称"
            value={title}
          />
          <Input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="实际检索词"
            value={query}
          />
          <Button
            disabled={!title.trim() || !query.trim()}
            onClick={() => {
              addTrackingTopic(title.trim(), query.trim());
              setTitle("");
              setQuery("");
            }}
            size="sm"
          >
            <PlusIcon />
            添加
          </Button>
        </div>
      </div>
      {error ? (
        <p
          aria-live="assertive"
          className="border-b bg-destructive/8 px-3 py-2 text-destructive text-xs"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {topics.length === 0 ? (
        <div className="grid min-h-48 place-items-center p-6 text-center">
          <div>
            <RadarIcon className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-3 text-muted-foreground text-xs">
              尚无追踪主题。添加后可手动刷新真实检索结果。
            </p>
          </div>
        </div>
      ) : (
        <div className="divide-y">
          {topics.map((topic) => (
            <div className="flex items-center gap-3 px-3 py-3" key={topic.id}>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-xs">{topic.title}</p>
                <p className="mt-1 truncate text-muted-foreground text-xs">
                  {topic.query}
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {topic.lastCheckedAt
                    ? `${new Date(topic.lastCheckedAt).toLocaleString()} · ${topic.latestCount} 条`
                    : "尚未检索"}
                </p>
              </div>
              <LoadingButton
                aria-label={`刷新 ${topic.title}`}
                disabled={refreshing !== undefined}
                errorLabel="重试"
                icon={<RefreshCwIcon />}
                iconOnly
                onAction={() => refresh(topic.id, topic.query)}
                pendingLabel="刷新中…"
                size="sm"
                successLabel="已刷新"
                variant="outline"
              >
                刷新
              </LoadingButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
