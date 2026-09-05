"use client";

import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { cn } from "@/lib/utils";

const CROSSFADE = {
  type: "spring",
  stiffness: 260,
  damping: 34,
  mass: 0.8,
} as const;
const INSTANT = { duration: 0 } as const;
const SPIN = { duration: 0.7, ease: "linear", repeat: Infinity } as const;

export type LoadMoreStatus = "idle" | "loading" | "error" | "end";

export type UseLoadMoreOptions = {
  onLoad: () => unknown;
  hasMore?: boolean;
  auto?: boolean;
  rootRef?: RefObject<Element | null>;
  rootMargin?: string;
  maxAutoLoads?: number;
  onError?: (error: unknown) => void;
};

export type UseLoadMoreReturn = {
  status: LoadMoreStatus;
  paused: boolean;
  sentinelRef: RefObject<HTMLDivElement | null>;
  load: () => void;
};

export function useLoadMore({
  onLoad,
  hasMore = true,
  auto = true,
  rootRef,
  rootMargin = "600px 0px",
  maxAutoLoads = 3,
  onError,
}: UseLoadMoreOptions): UseLoadMoreReturn {
  const [phase, setPhase] = useState<"idle" | "loading" | "error">("idle");
  const [ended, setEnded] = useState(false);
  const [paused, setPaused] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const sequence = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const autoRuns = useRef(0);
  const done = useRef(false);
  const blocked = useRef(false);

  const fetchMore = useRef(onLoad);
  fetchMore.current = onLoad;
  const fail = useRef(onError);
  fail.current = onError;
  const more = useRef(hasMore);
  more.current = hasMore;

  const reobserve = useCallback(() => {
    const io = observer.current;
    const element = sentinelRef.current;
    if (io && element) {
      io.unobserve(element);
      io.observe(element);
    }
  }, []);

  const run = useCallback(
    (manual: boolean) => {
      if (busy.current || done.current || !more.current) return;

      if (manual) {
        autoRuns.current = 0;
        blocked.current = false;
        setPaused(false);
      } else {
        if (blocked.current) return;
        if (autoRuns.current >= maxAutoLoads) {
          setPaused(true);
          return;
        }
        autoRuns.current += 1;
      }

      busy.current = true;
      const id = ++sequence.current;
      setPhase("loading");

      Promise.resolve()
        .then(() => fetchMore.current())
        .then(
          (result) => {
            busy.current = false;
            if (!alive.current || id !== sequence.current) return;
            setPhase("idle");
            if (result === false) {
              done.current = true;
              setEnded(true);
              return;
            }
            reobserve();
          },
          (error: unknown) => {
            busy.current = false;
            if (!alive.current || id !== sequence.current) return;
            blocked.current = true;
            fail.current?.(error);
            setPhase("error");
          },
        );
    },
    [maxAutoLoads, reobserve],
  );

  useEffect(() => {
    if (hasMore) {
      done.current = false;
      setEnded(false);
    }
  }, [hasMore]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!auto || ended) return;
    const element = sentinelRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        if (entry.isIntersecting) {
          run(false);
          return;
        }
        autoRuns.current = 0;
        setPaused(false);
      },
      { root: rootRef?.current ?? null, rootMargin, threshold: 0 },
    );

    observer.current = io;
    io.observe(element);

    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, [auto, ended, rootMargin, rootRef, run]);

  const load = useCallback(() => run(true), [run]);
  const status: LoadMoreStatus = ended || !hasMore ? "end" : phase;

  return { status, paused, sentinelRef, load };
}

function ChevronMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-3 shrink-0"
      fill="none"
      viewBox="0 0 11 11"
    >
      <path
        d="M2.6 4.2 5.5 7.1 8.4 4.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-3 shrink-0"
      fill="none"
      viewBox="0 0 11 11"
    >
      <path
        d="M2.2 5.7 4.5 8 8.8 3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function AlertMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-3 shrink-0"
      fill="none"
      viewBox="0 0 11 11"
    >
      <path
        d="M5.5 2.4v3.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
      <rect
        fill="currentColor"
        height="1.6"
        rx="0.4"
        width="1.6"
        x="4.7"
        y="7.5"
      />
    </svg>
  );
}

function SpinnerMark({ spinning }: { spinning: boolean }) {
  return (
    <motion.svg
      animate={spinning ? { rotate: 360 } : { rotate: 0 }}
      aria-hidden="true"
      className="size-3 shrink-0"
      fill="none"
      initial={false}
      style={{ transformOrigin: "50% 50%" }}
      transition={spinning ? SPIN : INSTANT}
      viewBox="0 0 11 11"
    >
      <circle
        cx="5.5"
        cy="5.5"
        opacity="0.25"
        r="3.9"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M5.5 1.6a3.9 3.9 0 0 1 3.9 3.9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </motion.svg>
  );
}

export type LoadMoreLabels = Record<LoadMoreStatus, string>;

const DEFAULT_LABELS: LoadMoreLabels = {
  idle: "加载更多",
  loading: "正在加载",
  error: "加载失败，重试",
  end: "已全部加载",
};

const ORDER: LoadMoreStatus[] = ["idle", "loading", "error", "end"];

const TONE: Record<LoadMoreStatus, string> = {
  idle: "text-foreground/80",
  loading: "text-muted-foreground",
  error: "text-destructive",
  end: "text-muted-foreground",
};

export type LoadMoreProps = {
  onLoad: () => unknown;
  hasMore?: boolean;
  auto?: boolean;
  rootRef?: RefObject<Element | null>;
  rootMargin?: string;
  maxAutoLoads?: number;
  labels?: Partial<LoadMoreLabels>;
  onError?: (error: unknown) => void;
  className?: string;
};

export function LoadMore({
  onLoad,
  hasMore = true,
  auto = true,
  rootRef,
  rootMargin = "600px 0px",
  maxAutoLoads = 3,
  labels,
  onError,
  className,
}: LoadMoreProps) {
  const reduced = useReducedMotion();
  const { status, sentinelRef, load } = useLoadMore({
    onLoad,
    hasMore,
    auto,
    rootRef,
    rootMargin,
    maxAutoLoads,
    onError,
  });

  const fade = reduced ? INSTANT : CROSSFADE;
  const text: LoadMoreLabels = { ...DEFAULT_LABELS, ...labels };
  const icons: Record<LoadMoreStatus, ReactNode> = {
    idle: <ChevronMark />,
    loading: <SpinnerMark spinning={status === "loading" && !reduced} />,
    error: <AlertMark />,
    end: <CheckMark />,
  };
  const inert = status === "loading" || status === "end";

  return (
    <div className={cn("relative flex w-full justify-center", className)}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        ref={sentinelRef}
      />

      <button
        aria-busy={status === "loading" || undefined}
        aria-disabled={inert || undefined}
        aria-label={text[status]}
        className={cn(
          "group relative inline-flex h-8 select-none items-center justify-center rounded-lg px-3 text-[12.5px] font-medium outline-none transition-[background-color,box-shadow,transform] duration-150 focus-visible:bg-primary/[0.06] focus-visible:shadow-[inset_0_0_0_1px_hsl(var(--ring))] dark:focus-visible:bg-primary/[0.1]",
          inert
            ? "cursor-default"
            : "cursor-pointer hover:bg-muted/60 active:translate-y-px",
        )}
        onClick={(event) => {
          if (inert) {
            event.preventDefault();
            return;
          }
          load();
        }}
        style={{ touchAction: "manipulation" }}
        type="button"
      >
        <motion.span
          animate={{ y: status === "loading" ? 1 : 0 }}
          aria-hidden="true"
          className="relative grid place-items-center"
          initial={false}
          transition={reduced ? INSTANT : CROSSFADE}
        >
          {ORDER.map((state) => (
            <motion.span
              animate={
                state === status
                  ? { opacity: 1, y: 0, filter: "blur(0px)" }
                  : { opacity: 0, y: 3, filter: "blur(3px)" }
              }
              className={cn(
                "col-start-1 row-start-1 flex items-center gap-1.5 whitespace-nowrap",
                TONE[state],
              )}
              initial={false}
              key={state}
              transition={fade}
            >
              {icons[state]}
              {text[state]}
            </motion.span>
          ))}
        </motion.span>
      </button>

      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {status === "error" || status === "end" ? text[status] : ""}
      </span>
    </div>
  );
}
