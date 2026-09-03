"use client";

import {
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type HoldPhase = "idle" | "holding" | "committed";
type HoldToConfirmSize = "default" | "xs" | "sm" | "lg";
type HoldToConfirmVariant =
  "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";

export interface HoldToConfirmProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | "children"
  | "disabled"
  | "onBlur"
  | "onClick"
  | "onKeyDown"
  | "onKeyUp"
  | "onPointerCancel"
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
> {
  /** Action to run once the hold reaches the required duration. */
  onConfirm: () => void | Promise<void>;
  /** Optional callback for an intentional early release or cancellation. */
  onAbort?: () => void;
  children: ReactNode;
  confirmLabel?: ReactNode;
  disabled?: boolean;
  duration?: number;
  holdLabel?: ReactNode;
  moveTolerance?: number;
  resetAfter?: number;
  size?: HoldToConfirmSize;
  steps?: number;
  variant?: HoldToConfirmVariant;
}

const DEFAULT_DURATION = 1_400;
const DEFAULT_RESET_AFTER = 1_600;
const DEFAULT_MOVE_TOLERANCE = 8;

/**
 * A small destructive-action guardrail: the user must press and hold instead
 * of clicking once. Releasing early, moving too far, losing focus, or hiding
 * the document cancels the hold and returns the control to its idle state.
 */
export const HoldToConfirm = forwardRef<HTMLButtonElement, HoldToConfirmProps>(
  function HoldToConfirm(
    {
      children,
      className,
      confirmLabel = "已确认",
      disabled = false,
      duration = DEFAULT_DURATION,
      holdLabel = "松开即取消",
      moveTolerance = DEFAULT_MOVE_TOLERANCE,
      onAbort,
      onConfirm,
      resetAfter = DEFAULT_RESET_AFTER,
      size = "default",
      steps = 100,
      style,
      variant = "destructive",
      ...buttonProps
    },
    ref,
  ) {
    const reduced = useReducedMotion();
    const progress = useMotionValue(0);
    const fill = useTransform(progress, [0, 1], ["0%", "100%"]);
    const [phase, setPhase] = useState<HoldPhase>("idle");
    const [step, setStep] = useState(0);
    const phaseRef = useRef<HoldPhase>("idle");
    const onConfirmRef = useRef(onConfirm);
    const onAbortRef = useRef(onAbort);
    const disabledRef = useRef(disabled);
    const rafRef = useRef<number | null>(null);
    const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pointerIdRef = useRef<number | null>(null);
    const startPointRef = useRef({ x: 0, y: 0 });
    const startedAtRef = useRef(0);
    const lastStepRef = useRef(0);
    const keyRef = useRef<string | null>(null);

    useEffect(() => {
      onConfirmRef.current = onConfirm;
      onAbortRef.current = onAbort;
      disabledRef.current = disabled;
    }, [disabled, onAbort, onConfirm]);

    const clearAnimation = useCallback(() => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }, []);

    const clearResetTimer = useCallback(() => {
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    }, []);

    const reset = useCallback(() => {
      clearAnimation();
      clearResetTimer();
      pointerIdRef.current = null;
      keyRef.current = null;
      phaseRef.current = "idle";
      setPhase("idle");
      setStep(0);
      lastStepRef.current = 0;
      progress.set(0);
    }, [clearAnimation, clearResetTimer, progress]);

    const abort = useCallback(() => {
      if (phaseRef.current !== "holding") return;
      clearAnimation();
      pointerIdRef.current = null;
      keyRef.current = null;
      phaseRef.current = "idle";
      setPhase("idle");
      setStep(0);
      lastStepRef.current = 0;
      onAbortRef.current?.();
      progress.set(0);
    }, [clearAnimation, progress]);

    const commit = useCallback(() => {
      if (phaseRef.current !== "holding") return;
      clearAnimation();
      pointerIdRef.current = null;
      keyRef.current = null;
      phaseRef.current = "committed";
      setPhase("committed");
      setStep(Math.max(1, Math.round(steps)));
      progress.set(1);

      // Keep the component safe for async callers without creating an
      // unhandled rejection. The caller owns pending/error UI for the action.
      void Promise.resolve()
        .then(() => onConfirmRef.current())
        .catch(() => undefined);

      if (resetAfter > 0) {
        clearResetTimer();
        resetTimerRef.current = setTimeout(reset, resetAfter);
      }
    }, [clearAnimation, clearResetTimer, progress, reset, resetAfter, steps]);

    const tick = useCallback(
      (now: number) => {
        if (phaseRef.current !== "holding") return;
        const elapsed = Math.max(0, now - startedAtRef.current);
        const nextProgress = Math.min(1, elapsed / Math.max(1, duration));
        progress.set(nextProgress);

        const nextStep = Math.floor(nextProgress * Math.max(1, steps));
        if (nextStep !== lastStepRef.current) {
          lastStepRef.current = nextStep;
          setStep(nextStep);
        }

        if (nextProgress >= 1) {
          commit();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      },
      [commit, duration, progress, steps],
    );

    const begin = useCallback(
      (point?: { x: number; y: number }) => {
        if (disabledRef.current || phaseRef.current !== "idle") return false;
        clearAnimation();
        clearResetTimer();
        phaseRef.current = "holding";
        setPhase("holding");
        setStep(0);
        lastStepRef.current = 0;
        startPointRef.current = point ?? { x: 0, y: 0 };
        startedAtRef.current = performance.now();
        progress.set(0);
        rafRef.current = requestAnimationFrame(tick);
        return true;
      },
      [clearAnimation, clearResetTimer, progress, tick],
    );

    useEffect(() => {
      const cancelForEnvironment = () => {
        if (document.hidden || !document.hasFocus()) abort();
      };
      const handleVisibility = () => {
        if (document.hidden) abort();
      };
      document.addEventListener("visibilitychange", handleVisibility);
      window.addEventListener("blur", cancelForEnvironment);
      return () => {
        document.removeEventListener("visibilitychange", handleVisibility);
        window.removeEventListener("blur", cancelForEnvironment);
        clearAnimation();
        clearResetTimer();
      };
    }, [abort, clearAnimation, clearResetTimer]);

    const handlePointerDown = (
      event: React.PointerEvent<HTMLButtonElement>,
    ) => {
      if (
        event.button !== 0 ||
        !begin({ x: event.clientX, y: event.clientY })
      ) {
        return;
      }
      pointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (
      event: React.PointerEvent<HTMLButtonElement>,
    ) => {
      if (
        phaseRef.current !== "holding" ||
        pointerIdRef.current !== event.pointerId
      ) {
        return;
      }
      const { x, y } = startPointRef.current;
      if (Math.hypot(event.clientX - x, event.clientY - y) > moveTolerance) {
        abort();
      }
    };

    const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (phaseRef.current === "holding") abort();
      pointerIdRef.current = null;
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (keyRef.current === event.key) return;
      if (begin()) keyRef.current = event.key;
    };

    const handleKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (keyRef.current === event.key && phaseRef.current === "holding") {
        abort();
      }
      keyRef.current = null;
    };

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      // A native click can be emitted after pointerup or keyboard activation;
      // neither should bypass the hold gesture.
      event.preventDefault();
    };

    const handleBlur = () => {
      if (phaseRef.current === "holding") abort();
    };

    const label =
      phase === "holding"
        ? holdLabel
        : phase === "committed"
          ? confirmLabel
          : children;
    const percentage = Math.round((step / Math.max(1, steps)) * 100);

    return (
      <>
        <button
          {...buttonProps}
          aria-busy={phase === "holding" || disabled || undefined}
          aria-disabled={disabled || phase === "committed" || undefined}
          aria-label={buttonProps["aria-label"] ?? undefined}
          className={cn(
            buttonVariants({ variant, size }),
            "relative isolate overflow-hidden",
            className,
          )}
          disabled={disabled}
          onBlur={handleBlur}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onPointerCancel={abort}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          ref={ref}
          style={{ ...style, touchAction: "manipulation" }}
          type={buttonProps.type ?? "button"}
        >
          <motion.span
            animate={{ opacity: phase === "idle" ? 0 : 1 }}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 z-0 bg-current/15"
            initial={false}
            style={{ width: fill }}
            transition={reduced ? { duration: 0 } : { ease: "linear" }}
          />
          <span
            aria-hidden="true"
            className="invisible inline-grid place-items-center whitespace-nowrap"
          >
            <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5">
              {children}
            </span>
            <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5">
              {holdLabel}
            </span>
            <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5">
              {confirmLabel}
            </span>
          </span>
          <span className="absolute inset-0 z-10 inline-flex items-center justify-center gap-1.5 whitespace-nowrap">
            {label}
          </span>
        </button>
        <span aria-live="polite" className="sr-only" role="status">
          {phase === "holding"
            ? `${holdLabel} ${percentage}%`
            : phase === "committed"
              ? confirmLabel
              : ""}
        </span>
      </>
    );
  },
);

HoldToConfirm.displayName = "HoldToConfirm";
