"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import type { AriaAttributes } from "react";

import { cn } from "@/lib/utils";

const FILL = {
  type: "spring",
  stiffness: 210,
  damping: 34,
  mass: 0.9,
} as const;
const CROSSFADE = {
  type: "spring",
  stiffness: 260,
  damping: 34,
  mass: 0.8,
} as const;
const INSTANT = { duration: 0 } as const;

export type ProgressBarSize = "default" | "compact";

export type ProgressBarProps = {
  value: number | null;
  max?: number;
  label?: string;
  pendingLabel?: string;
  completeLabel?: string;
  className?: string;
  showLabel?: boolean;
  size?: ProgressBarSize;
};

const SIZE_CLASSES: Record<
  ProgressBarSize,
  { container: string; track: string; fill: string }
> = {
  default: {
    container:
      "rounded-[4px] bg-muted/60 p-[2px] shadow-[inset_0_1px_2px_rgba(28,25,23,0.1),inset_0_0_0_1px_rgba(28,25,23,0.06)] dark:bg-[#1D1D1A] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)]",
    track: "h-[8px] rounded-[2px]",
    fill: "rounded-[2px] bg-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(28,25,23,0.2)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),inset_0_-1px_0_rgba(0,0,0,0.25)]",
  },
  compact: {
    container:
      "rounded-[4px] bg-muted/55 p-px shadow-[inset_0_1px_2px_rgba(28,25,23,0.08)] dark:bg-[#1D1D1A] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.38)]",
    track: "h-[6px] rounded-[2px]",
    fill: "rounded-[2px] bg-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-1px_0_rgba(28,25,23,0.16)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),inset_0_-1px_0_rgba(0,0,0,0.22)]",
  },
};

/**
 * Shows measured progress while gracefully handing off from an unknown
 * amount of work to a determinate value. The optional compact presentation
 * keeps the bar usable inside existing metric cards without duplicating their
 * labels or captions.
 */
export function ProgressBar({
  value,
  max = 100,
  label = "Progress",
  pendingLabel = "Working",
  completeLabel = "Complete",
  className,
  showLabel = true,
  size = "default",
}: ProgressBarProps) {
  const reduced = useReducedMotion();
  const labelId = useId();
  const safeMax = max > 0 ? max : 100;
  const indeterminate = value === null;
  const fraction =
    value === null ? 0 : Math.min(1, Math.max(0, value / Math.max(1, safeMax)));
  const percent = Math.round(fraction * 100);
  const complete = !indeterminate && fraction >= 1;
  const measured: AriaAttributes = indeterminate
    ? {}
    : {
        "aria-valuenow": Math.round(fraction * safeMax * 100) / 100,
        "aria-valuetext": `${percent}%`,
      };
  const classes = SIZE_CLASSES[size];
  const transition = reduced ? INSTANT : CROSSFADE;

  return (
    <div className={cn("w-full", className)}>
      {showLabel ? (
        <div className="flex items-baseline justify-between gap-3">
          <span
            className="truncate font-medium text-foreground/80 text-[13px]"
            id={labelId}
          >
            {label}
          </span>
          <span
            aria-hidden="true"
            className="grid shrink-0 justify-items-end text-muted-foreground"
          >
            <motion.span
              animate={{ opacity: indeterminate ? 1 : 0 }}
              className="col-start-1 row-start-1 whitespace-nowrap font-medium text-[12px] leading-5"
              initial={false}
              transition={transition}
            >
              {pendingLabel}
            </motion.span>
            <motion.span
              animate={{ opacity: indeterminate ? 0 : 1 }}
              className="col-start-1 row-start-1 whitespace-nowrap font-mono font-medium text-[12px] leading-5 tabular-nums"
              initial={false}
              transition={transition}
            >
              {percent}%
            </motion.span>
          </span>
        </div>
      ) : (
        <span className="sr-only" id={labelId}>
          {label}
        </span>
      )}

      <div
        {...measured}
        aria-labelledby={labelId}
        aria-valuemax={safeMax}
        aria-valuemin={0}
        className={cn(showLabel ? "mt-2" : "mt-0", classes.container)}
        data-slot="progress-bar"
        role="progressbar"
      >
        <div className={cn("relative w-full overflow-hidden", classes.track)}>
          <motion.span
            aria-hidden="true"
            animate={{ scaleX: indeterminate ? 0 : fraction }}
            className={cn("absolute inset-0 block origin-left", classes.fill)}
            initial={false}
            transition={reduced ? INSTANT : FILL}
          />

          {indeterminate ? (
            <motion.span
              aria-hidden="true"
              animate={
                reduced ? { opacity: 0.7, x: "0%" } : { opacity: 1, x: "250%" }
              }
              className={cn(
                "absolute inset-y-0 left-0 block w-2/5",
                classes.fill,
              )}
              initial={
                reduced ? { opacity: 0.7, x: "0%" } : { opacity: 0, x: "-100%" }
              }
              transition={
                reduced
                  ? INSTANT
                  : {
                      x: {
                        duration: 1.25,
                        ease: "easeInOut",
                        repeat: Infinity,
                      },
                      opacity: { duration: 0.18 },
                    }
              }
            />
          ) : null}
        </div>
      </div>

      <span aria-live="polite" className="sr-only" role="status">
        {complete ? completeLabel : indeterminate ? pendingLabel : ""}
      </span>
    </div>
  );
}
