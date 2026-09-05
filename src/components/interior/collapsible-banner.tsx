"use client";

import { ChevronDownIcon, InfoIcon, XIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const DISCLOSE = {
  type: "spring",
  stiffness: 190,
  damping: 30,
  mass: 1,
} as const;
const NUDGE = {
  type: "spring",
  stiffness: 700,
  damping: 46,
  mass: 0.5,
} as const;
const INSTANT = { duration: 0 } as const;
const EASE = [0.23, 1, 0.32, 1] as const;

export type BannerState = "open" | "folded" | "dismissed";

export type CollapsibleBannerTone =
  "default" | "info" | "warning" | "danger" | "success";

export type UseCollapsibleBannerOptions = {
  state?: BannerState;
  defaultState?: BannerState;
  onStateChange?: (state: BannerState) => void;
  onDismiss?: () => void;
};

export type UseCollapsibleBannerResult = {
  state: BannerState;
  open: boolean;
  folded: boolean;
  dismissed: boolean;
  fold: () => void;
  expand: () => void;
  toggle: () => void;
  dismiss: () => void;
  restore: () => void;
};

export function useCollapsibleBanner({
  state: controlled,
  defaultState = "open",
  onStateChange,
  onDismiss,
}: UseCollapsibleBannerOptions = {}): UseCollapsibleBannerResult {
  const [uncontrolled, setUncontrolled] = useState<BannerState>(defaultState);
  const state = controlled ?? uncontrolled;
  const changed = useRef(onStateChange);
  const closed = useRef(onDismiss);
  changed.current = onStateChange;
  closed.current = onDismiss;

  const commit = useCallback(
    (next: BannerState) => {
      if (controlled === undefined) {
        setUncontrolled(next);
      }
      changed.current?.(next);
    },
    [controlled],
  );
  const fold = useCallback(() => commit("folded"), [commit]);
  const expand = useCallback(() => commit("open"), [commit]);
  const restore = useCallback(() => commit("open"), [commit]);
  const toggle = useCallback(
    () => commit(state === "open" ? "folded" : "open"),
    [commit, state],
  );
  const dismiss = useCallback(() => {
    commit("dismissed");
    closed.current?.();
  }, [commit]);

  return {
    state,
    open: state === "open",
    folded: state === "folded",
    dismissed: state === "dismissed",
    fold,
    expand,
    toggle,
    dismiss,
    restore,
  };
}

const TONE_CLASSES: Record<
  CollapsibleBannerTone,
  { icon: string; surface: string }
> = {
  default: {
    icon: "bg-muted text-muted-foreground",
    surface: "border-border/70 bg-card text-card-foreground",
  },
  info: {
    icon: "bg-blue-500/10 text-blue-600 dark:text-blue-300",
    surface: "border-blue-500/25 bg-blue-500/5 text-foreground",
  },
  warning: {
    icon: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    surface: "border-amber-500/30 bg-amber-500/8 text-foreground",
  },
  danger: {
    icon: "bg-destructive/10 text-destructive",
    surface: "border-destructive/30 bg-destructive/5 text-destructive",
  },
  success: {
    icon: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    surface:
      "border-emerald-500/25 bg-emerald-500/5 text-emerald-950 dark:text-emerald-100",
  },
};

export type CollapsibleBannerProps = {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  tone?: CollapsibleBannerTone;
  dismissible?: boolean;
  state?: BannerState;
  defaultState?: BannerState;
  onStateChange?: (state: BannerState) => void;
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissedMessage?: string;
  role?: "region" | "status" | "alert";
  ariaLive?: "off" | "polite" | "assertive";
  className?: string;
};

/**
 * Keeps a persistent notice available while letting its details fold away.
 * Use it for page-level warnings and errors that have useful context or an
 * action; short-lived success feedback belongs in Live Activity instead.
 */
export function CollapsibleBanner({
  title,
  description,
  children,
  action,
  icon,
  tone = "default",
  dismissible = true,
  state: controlled,
  defaultState = "open",
  onStateChange,
  onDismiss,
  dismissLabel = "关闭通知",
  dismissedMessage = "通知已关闭。",
  role = "region",
  ariaLive,
  className,
}: CollapsibleBannerProps) {
  const reduced = useReducedMotion();
  const uid = useId();
  const bodyId = `${uid}-body`;
  const titleId = `${uid}-title`;
  const { state, open, dismissed, toggle, fold, dismiss } =
    useCollapsibleBanner({
      state: controlled,
      defaultState,
      onStateChange,
      onDismiss,
    });
  const hasBody = Boolean(description || children || action);
  const toneClasses = TONE_CLASSES[tone];
  const disclose = reduced
    ? INSTANT
    : {
        height: DISCLOSE,
        opacity: { duration: 0.14, ease: EASE },
        y: DISCLOSE,
      };

  return (
    <>
      <motion.div
        animate={{ height: dismissed ? 0 : "auto", opacity: dismissed ? 0 : 1 }}
        aria-hidden={dismissed ? true : undefined}
        initial={false}
        inert={dismissed}
        style={{ overflow: "hidden" }}
        transition={
          reduced
            ? INSTANT
            : { height: DISCLOSE, opacity: { duration: 0.14, ease: EASE } }
        }
      >
        <div
          aria-atomic={ariaLive ? "true" : undefined}
          aria-labelledby={titleId}
          aria-live={ariaLive}
          className={cn(
            "rounded-xl border px-3 py-2.5",
            toneClasses.surface,
            className,
          )}
          role={role}
        >
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-md",
                toneClasses.icon,
              )}
            >
              {icon ?? <InfoIcon className="size-3.5" />}
            </span>

            {hasBody ? (
              <button
                aria-controls={bodyId}
                aria-expanded={open}
                className="group flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:bg-primary/8 focus-visible:ring-1 focus-visible:ring-ring"
                onClick={toggle}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !open) return;
                  event.stopPropagation();
                  fold();
                }}
                type="button"
              >
                <span
                  className="min-w-0 flex-1 truncate font-medium text-sm"
                  id={titleId}
                >
                  {title}
                </span>
                <motion.span
                  aria-hidden="true"
                  animate={{ rotate: open ? 180 : 0 }}
                  className="flex shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                  initial={false}
                  transition={reduced ? INSTANT : NUDGE}
                >
                  <ChevronDownIcon className="size-3.5" />
                </motion.span>
              </button>
            ) : (
              <span
                className="min-w-0 flex-1 truncate font-medium text-sm"
                id={titleId}
              >
                {title}
              </span>
            )}

            {dismissible ? (
              <button
                aria-label={dismissLabel}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={dismiss}
                type="button"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>

          {hasBody ? (
            <motion.div
              animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
              aria-hidden={!open}
              id={bodyId}
              inert={!open}
              initial={false}
              style={{ overflow: "hidden" }}
              transition={disclose}
            >
              <motion.div
                animate={{ y: open ? 0 : -6 }}
                className="pt-1 pl-[36px] pr-1"
                initial={false}
                transition={reduced ? INSTANT : DISCLOSE}
              >
                {description ? (
                  <p className="text-muted-foreground text-xs leading-5">
                    {description}
                  </p>
                ) : null}
                {children}
                {action ? <div className="mt-2">{action}</div> : null}
              </motion.div>
            </motion.div>
          ) : null}
        </div>
      </motion.div>
      <span aria-live="polite" className="sr-only" role="status">
        {state === "dismissed" ? dismissedMessage : ""}
      </span>
    </>
  );
}
