import { listen } from "@tauri-apps/api/event";
import {
  ArrowUpRightIcon,
  CameraIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toUserMessage } from "@/domain/app-error";
import {
  closePiBrowserTab,
  capturePiBrowserScreenshot,
  navigatePiBrowser,
  navigatePiBrowserLocalPreview,
  openPiBrowser,
  openPiBrowserTab,
  selectPiBrowserTab,
  setPiBrowserBounds,
  setPiBrowserPopupPolicy,
  snapshotPiBrowser,
  type PiBrowserStatus,
  type PiBrowserTabStatus,
  type PiBrowserSnapshot,
  type PiBrowserScreenshot,
} from "@/lib/melody-bridge-browser";
import { isTauriRuntime } from "@/lib/melody-bridge-runtime";

type BrowserChangedEvent = { sessionId: string; tabId: string };

function activeTab(status?: PiBrowserStatus): PiBrowserTabStatus | undefined {
  return status?.tabs.find((tab) => tab.id === status.activeTabId);
}

function tabLabel(tab: PiBrowserTabStatus): string {
  if (!tab.url || tab.url === "about:blank") return "新标签";
  try {
    return new URL(tab.url).hostname;
  } catch {
    return tab.url;
  }
}

interface BrowserPanelProps {
  active?: boolean;
  sessionId?: string;
}

export function BrowserPanel({ active = true, sessionId }: BrowserPanelProps) {
  const [url, setUrl] = useState("https://");
  const [snapshot, setSnapshot] = useState<PiBrowserSnapshot>();
  const [screenshot, setScreenshot] = useState<PiBrowserScreenshot>();
  const [browser, setBrowser] = useState<PiBrowserStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [localPreview, setLocalPreview] = useState(false);
  const [popupAllowed, setPopupAllowed] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const browserRef = useRef<PiBrowserStatus | undefined>(undefined);
  const browserTabsRef = useRef<PiBrowserStatus["tabs"]>([]);

  browserRef.current = browser;
  browserTabsRef.current = browser?.tabs ?? [];

  const applyStatus = (next: PiBrowserStatus) => {
    setBrowser(next);
    const selected = activeTab(next);
    if (selected?.url && selected.url !== "about:blank") setUrl(selected.url);
  };

  useEffect(() => {
    setSnapshot(undefined);
    setScreenshot(undefined);
    setError(undefined);
    if (!sessionId) {
      setBrowser(undefined);
      return;
    }
    if (!isTauriRuntime()) {
      setBrowser(undefined);
      setError("Melody Browser 仅在桌面应用中可用。");
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void openPiBrowser(sessionId)
      .then((next) => {
        if (!disposed) applyStatus(next);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(toUserMessage(cause));
      });
    void listen<BrowserChangedEvent>("melody://pi-browser-changed", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      void openPiBrowser(sessionId)
        .then((next) => {
          if (!disposed) applyStatus(next);
        })
        .catch((cause: unknown) => {
          if (!disposed) setError(toUserMessage(cause));
        });
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(toUserMessage(cause));
      });

    return () => {
      disposed = true;
      unlisten?.();
      const current = browserRef.current;
      for (const tab of current?.tabs ?? []) {
        void setPiBrowserBounds(sessionId, tab.id, {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          visible: false,
        });
        void setPiBrowserPopupPolicy(sessionId, tab.id, false);
      }
    };
  }, [sessionId]);

  useEffect(() => {
    setPopupAllowed(false);
    if (!sessionId) return;
    for (const tab of browserTabsRef.current) {
      void setPiBrowserPopupPolicy(sessionId, tab.id, false);
    }
  }, [active, sessionId, browser?.activeTabId]);

  useEffect(() => {
    if (!sessionId) return;
    if (!active) {
      for (const tab of browserRef.current?.tabs ?? []) {
        void setPiBrowserBounds(sessionId, tab.id, {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          visible: false,
        });
      }
      return;
    }
    if (!browser?.activeTabId) return;
    const tabId = browser.activeTabId;
    const syncBounds = () => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) {
        void setPiBrowserBounds(sessionId, tabId, {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          visible: false,
        }).catch((cause: unknown) => setError(toUserMessage(cause)));
        return;
      }
      const x = Math.max(0, rect.left);
      const y = Math.max(0, rect.top);
      const right = Math.min(window.innerWidth, rect.right);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      if (right - x < 1 || bottom - y < 1) {
        void setPiBrowserBounds(sessionId, tabId, {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          visible: false,
        }).catch((cause: unknown) => setError(toUserMessage(cause)));
        return;
      }
      void setPiBrowserBounds(sessionId, tabId, {
        x,
        y,
        width: right - x,
        height: bottom - y,
        visible: true,
      }).catch((cause: unknown) => setError(toUserMessage(cause)));
    };
    const observer = new ResizeObserver(syncBounds);
    if (viewportRef.current) observer.observe(viewportRef.current);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);
    syncBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
      void setPiBrowserBounds(sessionId, tabId, {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        visible: false,
      });
    };
  }, [active, sessionId, browser?.activeTabId]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const navigate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionId) return;
    void run(async () => {
      const next = localPreview
        ? await navigatePiBrowserLocalPreview(sessionId, url.trim())
        : await navigatePiBrowser(sessionId, url.trim());
      applyStatus(next);
      setSnapshot(undefined);
      setScreenshot(undefined);
    });
  };

  const addTab = () => {
    if (!sessionId) return;
    void run(async () => {
      applyStatus(await openPiBrowserTab(sessionId));
      setUrl("https://");
      setSnapshot(undefined);
      setScreenshot(undefined);
      setLocalPreview(false);
      setPopupAllowed(false);
    });
  };

  const refreshSnapshot = () => {
    if (!sessionId || !browser?.activeTabId) return;
    void run(async () => {
      setSnapshot(await snapshotPiBrowser(sessionId));
      applyStatus(await openPiBrowser(sessionId));
    });
  };

  const captureScreenshot = () => {
    if (!sessionId || !browser?.activeTabId) return;
    void run(async () => {
      setScreenshot(await capturePiBrowserScreenshot(sessionId));
    });
  };

  const selectTab = (tabId: string) => {
    if (!sessionId) return;
    void run(async () => {
      applyStatus(await selectPiBrowserTab(sessionId, tabId));
      setSnapshot(undefined);
      setScreenshot(undefined);
      setLocalPreview(false);
      setPopupAllowed(false);
    });
  };

  const closeTab = (tabId: string) => {
    if (!sessionId) return;
    void run(async () => {
      applyStatus(await closePiBrowserTab(sessionId, tabId));
      setSnapshot(undefined);
      setScreenshot(undefined);
      setLocalPreview(false);
      setPopupAllowed(false);
    });
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-2.5 p-3">
      <div
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
        aria-label="浏览器标签"
      >
        {browser?.tabs.map((tab) => (
          <div
            className={`flex max-w-48 shrink-0 items-center rounded-md border ${tab.active ? "border-border bg-background" : "border-transparent bg-muted/40"}`}
            key={tab.id}
          >
            <button
              aria-current={tab.active ? "page" : undefined}
              className="min-w-0 truncate px-2.5 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={busy}
              onClick={() => selectTab(tab.id)}
              title={tab.url}
              type="button"
            >
              {tabLabel(tab)}
            </button>
            <Button
              aria-label={`关闭标签 ${tabLabel(tab)}`}
              className="mr-0.5 size-6 shrink-0"
              disabled={busy}
              onClick={() => closeTab(tab.id)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          aria-label="新建浏览器标签"
          className="size-8 shrink-0"
          disabled={!sessionId || busy || (browser?.tabs.length ?? 0) >= 8}
          onClick={addTab}
          size="icon"
          type="button"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
      </div>

      <form className="flex items-center gap-2" onSubmit={navigate}>
        <Input
          aria-label="浏览器地址"
          autoCapitalize="off"
          autoComplete="url"
          className="min-w-0"
          disabled={!sessionId || busy}
          onChange={(event) => setUrl(event.currentTarget.value)}
          placeholder={
            localPreview ? "http://localhost:5173" : "https://example.com"
          }
          spellCheck={false}
          value={url}
        />
        <Button
          aria-label="导航"
          disabled={!sessionId || busy}
          size="icon"
          type="submit"
        >
          <ArrowUpRightIcon />
        </Button>
        <Button
          aria-label="读取页面摘要"
          disabled={!sessionId || !browser?.activeTabId || busy}
          onClick={refreshSnapshot}
          size="icon"
          type="button"
          variant="outline"
        >
          <RefreshCwIcon />
        </Button>
        <Button
          aria-label="截取浏览器视口"
          disabled={!sessionId || !browser?.activeTabId || busy}
          onClick={captureScreenshot}
          size="icon"
          title="仅截取当前嵌入式浏览器视口"
          type="button"
          variant="outline"
        >
          <CameraIcon />
        </Button>
      </form>

      <label className="flex w-fit items-center gap-2 text-muted-foreground text-xs">
        <input
          checked={localPreview}
          className="size-3.5 accent-primary"
          disabled={!sessionId || busy}
          onChange={(event) => setLocalPreview(event.currentTarget.checked)}
          type="checkbox"
        />
        允许访问本机 localhost 预览
      </label>
      <label className="flex w-fit items-center gap-2 text-muted-foreground text-xs">
        <input
          checked={popupAllowed}
          className="size-3.5 accent-primary"
          disabled={!sessionId || !browser?.activeTabId || busy}
          onChange={(event) => {
            const allow = event.currentTarget.checked;
            const tabId = browser?.activeTabId;
            if (!sessionId || !tabId) return;
            void run(async () => {
              await setPiBrowserPopupPolicy(sessionId, tabId, allow);
              setPopupAllowed(allow);
            });
          }}
          type="checkbox"
        />
        允许此标签打开登录弹窗
      </label>

      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-muted-foreground text-xs">
        网页直接显示在此面板；每个会话使用独立浏览器数据。Pi
        读取页面摘要后才能按短期引用操作；导航、点击和输入仍需单次授权，网页内容始终视为不可信输入。登录弹窗默认关闭；开启后只接受公开
        HTTPS 页面，且不向网页开放本机命令。
      </div>

      {!sessionId ? (
        <div className="grid min-h-0 flex-1 place-items-center text-center text-muted-foreground text-sm">
          请先打开一个会话，再使用浏览器。
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
          {error}
        </div>
      ) : null}

      <div
        aria-label="浏览器页面"
        className="relative min-h-24 flex-1 overflow-hidden rounded-md border border-border/60 bg-background"
        ref={viewportRef}
      >
        {sessionId && !browser?.activeTabId ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center text-muted-foreground text-sm">
            新建一个标签以打开网页。
          </div>
        ) : sessionId && activeTab(browser)?.url === "about:blank" ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center text-muted-foreground text-sm">
            输入公开 HTTPS 地址；仅在明确开启本地预览时允许 localhost。
          </div>
        ) : null}
      </div>

      {snapshot ? (
        <details className="max-h-36 shrink-0 overflow-auto rounded-md border border-border/60 bg-background px-3 py-2">
          <summary className="cursor-pointer truncate text-muted-foreground text-xs">
            {snapshot.title || "页面摘要"} · {snapshot.url}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-foreground text-xs">
            {snapshot.text || "页面还没有可读取的正文。"}
          </pre>
        </details>
      ) : null}

      {screenshot ? (
        <figure className="relative max-h-56 shrink-0 overflow-auto rounded-md border border-border/60 bg-background p-2">
          <button
            aria-label="关闭浏览器截图预览"
            className="absolute right-3 top-3 z-10 rounded-sm bg-background/90 p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setScreenshot(undefined)}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
          <img
            alt={`浏览器视口截图：${screenshot.url}`}
            className="mx-auto max-h-44 w-auto max-w-full object-contain"
            src={`data:${screenshot.mimeType};base64,${screenshot.data}`}
          />
          <figcaption className="mt-1 truncate text-muted-foreground text-xs">
            手动截取的 Browser 视口 · {screenshot.url}
          </figcaption>
        </figure>
      ) : null}
    </section>
  );
}
