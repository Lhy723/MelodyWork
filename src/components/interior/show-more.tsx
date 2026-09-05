"use client";

import {
  motion,
  useIsomorphicLayoutEffect,
  useReducedMotion,
} from "motion/react";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "@/lib/utils";

const DISCLOSE = {
  type: "spring",
  stiffness: 190,
  damping: 30,
  mass: 1,
} as const;

const SMALL = {
  type: "spring",
  stiffness: 700,
  damping: 46,
  mass: 0.5,
} as const;

const INSTANT = { duration: 0 } as const;

type Metrics = {
  line: number;
  full: number;
};

export type UseShowMoreOptions = {
  lines?: number;
  maxHeight?: number;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

export type UseShowMoreResult = {
  contentRef: RefObject<HTMLDivElement | null>;
  measured: boolean;
  expanded: boolean;
  open: boolean;
  toggle: () => void;
  setExpanded: (next: boolean) => void;
  height: number | null;
  collapsedHeight: number | null;
  fullHeight: number | null;
  expandable: boolean;
  capped: boolean;
  scrollable: boolean;
};

export function useShowMore({
  lines = 3,
  maxHeight = 320,
  defaultExpanded = false,
  expanded: expandedProp,
  onExpandedChange,
}: UseShowMoreOptions = {}): UseShowMoreResult {
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const expanded = expandedProp ?? uncontrolled;

  const notify = useRef(onExpandedChange);
  notify.current = onExpandedChange;

  const setExpanded = useCallback(
    (next: boolean) => {
      if (expandedProp === undefined) {
        setUncontrolled(next);
      }
      notify.current?.(next);
    },
    [expandedProp],
  );

  const toggle = useCallback(
    () => setExpanded(!expanded),
    [expanded, setExpanded],
  );

  useIsomorphicLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const read = () => {
      const styles = getComputedStyle(element);
      const parsedLineHeight = Number.parseFloat(styles.lineHeight);
      const parsedFontSize = Number.parseFloat(styles.fontSize);
      const line = Number.isFinite(parsedLineHeight)
        ? parsedLineHeight
        : Number.isFinite(parsedFontSize)
          ? parsedFontSize * 1.5
          : 24;
      const full = element.scrollHeight;

      setMetrics((previous) =>
        previous && previous.line === line && previous.full === full
          ? previous
          : { line, full },
      );
    };

    read();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const clamped = metrics ? metrics.line * lines : 0;
  const expandable = metrics ? metrics.full - clamped > 1 : true;
  const capped = metrics ? metrics.full > maxHeight : false;
  const collapsedHeight = metrics ? Math.min(clamped, metrics.full) : null;
  const fullHeight = metrics ? Math.min(metrics.full, maxHeight) : null;
  const open = expanded && expandable;

  return {
    capped,
    collapsedHeight,
    contentRef,
    expandable,
    expanded,
    fullHeight,
    height: open ? fullHeight : collapsedHeight,
    measured: metrics !== null,
    open,
    scrollable: open && capped,
    setExpanded,
    toggle,
  };
}

export type ShowMoreProps = UseShowMoreOptions & {
  children: ReactNode;
  moreLabel?: string;
  lessLabel?: string;
  label?: string;
  className?: string;
  veilClassName?: string;
};

/**
 * Reveals long text without reflowing its line layout. The outer disclosure
 * should remain responsible for larger sections; use this for the readable
 * body inside a card, such as a generated plan or a research note.
 */
export function ShowMore({
  children,
  moreLabel = "显示更多",
  lessLabel = "收起",
  label = "详细内容",
  lines = 3,
  maxHeight = 320,
  defaultExpanded,
  expanded,
  onExpandedChange,
  className,
  veilClassName,
}: ShowMoreProps) {
  const reduced = useReducedMotion();
  const regionId = useId();
  const regionRef = useRef<HTMLDivElement>(null);

  const {
    contentRef,
    open,
    toggle,
    height,
    expandable,
    capped,
    measured,
    scrollable,
  } = useShowMore({
    lines,
    maxHeight,
    defaultExpanded,
    expanded,
    onExpandedChange,
  });

  const press = () => {
    if (open) {
      regionRef.current?.scrollTo({ top: 0 });
    }
    toggle();
  };

  const veiled = expandable && (!open || scrollable);

  return (
    <div className={cn("relative min-w-0", className)} data-slot="show-more">
      <div className="relative">
        <motion.div
          ref={regionRef}
          id={regionId}
          role={scrollable ? "region" : undefined}
          aria-label={scrollable ? label : undefined}
          tabIndex={scrollable ? 0 : undefined}
          initial={false}
          animate={height === null ? {} : { height }}
          transition={reduced ? INSTANT : DISCLOSE}
          style={{
            maxHeight: height === null ? `${lines}lh` : undefined,
            overflowY: scrollable ? "auto" : "hidden",
            scrollbarGutter: capped ? "stable" : undefined,
          }}
          className="overflow-hidden overscroll-contain rounded-md outline-none focus-visible:bg-primary/[0.06] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
        >
          <div ref={contentRef}>{children}</div>
        </motion.div>
        <motion.div
          aria-hidden="true"
          initial={false}
          animate={{ opacity: veiled ? 1 : 0 }}
          transition={reduced ? INSTANT : SMALL}
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-card to-card/0",
            veilClassName,
          )}
        />
      </div>
      {measured && expandable ? (
        <div className="mt-2 flex h-7 items-center">
          <button
            type="button"
            onClick={press}
            aria-expanded={open}
            aria-controls={regionId}
            className="inline-flex h-7 select-none items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 text-xs font-medium text-muted-foreground outline-none transition-[background-color,border-color,box-shadow,color] duration-150 hover:border-border hover:bg-muted/70 hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="grid text-left">
              <motion.span
                aria-hidden={open}
                className="col-start-1 row-start-1"
                initial={false}
                animate={{ opacity: open ? 0 : 1 }}
                transition={reduced ? INSTANT : SMALL}
              >
                {moreLabel}
              </motion.span>
              <motion.span
                aria-hidden={!open}
                className="col-start-1 row-start-1"
                initial={false}
                animate={{ opacity: open ? 1 : 0 }}
                transition={reduced ? INSTANT : SMALL}
              >
                {lessLabel}
              </motion.span>
            </span>
            <motion.svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 256 256"
              fill="none"
              className="text-muted-foreground"
              initial={false}
              animate={{ rotate: open ? 180 : 0 }}
              transition={reduced ? INSTANT : SMALL}
            >
              <polyline
                points="208 96 128 176 48 96"
                stroke="currentColor"
                strokeWidth="16"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </motion.svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
