"use client";

import { motion, useReducedMotion } from "motion/react";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

const CELL = {
  type: "spring",
  stiffness: 520,
  damping: 34,
  mass: 0.45,
} as const;
const CROSSFADE = {
  type: "spring",
  stiffness: 260,
  damping: 34,
  mass: 0.8,
} as const;
const INSTANT = { duration: 0 } as const;

export type LoadingButtonStatus = "idle" | "pending" | "success" | "error";

export type UseLoadingActionOptions = {
  action: () => unknown;
  resetAfter?: number;
  onError?: (error: unknown) => void;
};

/**
 * Runs one async action at a time and exposes a short-lived success/error
 * state for the button face. The action itself remains the source of truth for
 * data updates; this hook only owns the interaction state.
 */
export function useLoadingAction({
  action,
  resetAfter = 1400,
  onError,
}: UseLoadingActionOptions) {
  const [status, setStatus] = useState<LoadingButtonStatus>("idle");
  const phase = useRef<LoadingButtonStatus>("idle");
  const runId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const actionRef = useRef(action);
  const errorRef = useRef(onError);

  useEffect(() => {
    actionRef.current = action;
    errorRef.current = onError;
  });

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    runId.current += 1;
    clearTimer();
    phase.current = "idle";
    setStatus("idle");
  }, [clearTimer]);

  const run = useCallback(() => {
    if (phase.current === "pending") return;

    clearTimer();
    const id = ++runId.current;
    phase.current = "pending";
    setStatus("pending");

    const settle = (next: "success" | "error") => {
      if (!alive.current || id !== runId.current) return;
      clearTimer();
      phase.current = next;
      setStatus(next);
      timer.current = setTimeout(() => {
        if (!alive.current || id !== runId.current) return;
        phase.current = "idle";
        setStatus("idle");
      }, resetAfter);
    };

    Promise.resolve()
      .then(() => actionRef.current())
      .then(
        () => settle("success"),
        (error: unknown) => {
          errorRef.current?.(error);
          settle("error");
        },
      );
  }, [clearTimer, resetAfter]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  return {
    pending: status === "pending",
    reset,
    run,
    status,
  };
}

function Spinner({ still }: { still: boolean }) {
  return (
    <motion.svg
      aria-hidden="true"
      className="size-3 shrink-0"
      animate={still ? undefined : { rotate: 360 }}
      fill="none"
      transition={
        still ? undefined : { duration: 0.85, repeat: Infinity, ease: "linear" }
      }
      viewBox="0 0 12 12"
    >
      <circle
        cx="6"
        cy="6"
        r="4.5"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="1.5"
      />
      <path
        d="M10.5 6A4.5 4.5 0 0 0 6 1.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </motion.svg>
  );
}

function CheckMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-3 shrink-0"
      fill="none"
      viewBox="0 0 12 12"
    >
      <path
        d="M2.6 6.3 4.9 8.6 9.4 3.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
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
      viewBox="0 0 12 12"
    >
      <path
        d="M6 2.9v3.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
      <path
        d="M6 9.05h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

type LoadingButtonSize = "default" | "xs" | "sm" | "lg";
type LoadingButtonVariant =
  "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";

const sizeClasses: Record<LoadingButtonSize, string> = {
  default: "h-8 gap-1.5 px-2.5 text-sm",
  xs: "h-6 gap-1 rounded-lg px-2 text-xs",
  sm: "h-7 gap-1 rounded-lg px-2.5 text-[0.8rem]",
  lg: "h-9 gap-1.5 px-2.5 text-sm",
};

const iconOnlySizeClasses: Record<LoadingButtonSize, string> = {
  default: "size-8",
  xs: "size-6 rounded-lg",
  sm: "size-7 rounded-lg",
  lg: "size-9",
};

const variantClasses: Record<LoadingButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/80",
  outline:
    "border-border bg-background hover:text-foreground dark:border-input dark:bg-input/30",
  secondary: "bg-secondary text-secondary-foreground",
  ghost: "border-transparent bg-transparent shadow-none hover:text-foreground",
  destructive:
    "border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
  link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline",
};

export type LoadingButtonProps = Omit<
  ComponentProps<typeof motion.button>,
  "children" | "disabled" | "onClick" | "type"
> & {
  children: string;
  disabled?: boolean;
  errorLabel?: string;
  icon?: ReactNode;
  iconOnly?: boolean;
  onAction: () => unknown;
  onError?: (error: unknown) => void;
  pendingLabel?: string;
  resetAfter?: number;
  size?: LoadingButtonSize;
  successLabel?: string;
  type?: "button" | "submit" | "reset";
  variant?: LoadingButtonVariant;
};

export const LoadingButton = forwardRef<HTMLButtonElement, LoadingButtonProps>(
  function LoadingButton(
    {
      children,
      className,
      disabled = false,
      errorLabel = "重试",
      icon,
      iconOnly = false,
      onAction,
      onError,
      pendingLabel = children,
      resetAfter = 1400,
      size = "default",
      successLabel = "已完成",
      type = "button",
      variant = "default",
      ...buttonProps
    },
    ref,
  ) {
    const reduced = useReducedMotion();
    const { pending, run, status } = useLoadingAction({
      action: onAction,
      onError,
      resetAfter,
    });
    const fade = reduced ? INSTANT : CROSSFADE;
    const label =
      status === "pending"
        ? pendingLabel
        : status === "success"
          ? successLabel
          : status === "error"
            ? errorLabel
            : children;
    const idleTone =
      variant === "default"
        ? "text-primary-foreground"
        : variant === "secondary"
          ? "text-secondary-foreground"
          : variant === "destructive"
            ? "text-destructive"
            : variant === "link"
              ? "text-primary"
              : "text-foreground";
    const pendingTone =
      variant === "default"
        ? "text-primary-foreground/80"
        : variant === "secondary"
          ? "text-secondary-foreground/80"
          : variant === "destructive"
            ? "text-destructive/80"
            : variant === "link"
              ? "text-primary/80"
              : "text-muted-foreground";
    const completedTone =
      variant === "default" || variant === "destructive"
        ? idleTone
        : "text-emerald-600 dark:text-emerald-400";
    const failedTone =
      variant === "default" || variant === "destructive"
        ? idleTone
        : "text-red-600 dark:text-red-400";
    const faces = [
      {
        icon: icon ? (
          <span className="[&>svg]:size-3 [&>svg]:shrink-0">{icon}</span>
        ) : null,
        key: "idle" as const,
        text: children,
        tone: idleTone,
      },
      {
        icon: <Spinner still={reduced === true || status !== "pending"} />,
        key: "pending" as const,
        text: pendingLabel,
        tone: pendingTone,
      },
      {
        icon: <CheckMark />,
        key: "success" as const,
        text: successLabel,
        tone: completedTone,
      },
      {
        icon: <AlertMark />,
        key: "error" as const,
        text: errorLabel,
        tone: failedTone,
      },
    ];

    return (
      <>
        <motion.button
          {...buttonProps}
          aria-busy={pending || undefined}
          aria-disabled={pending || undefined}
          aria-label={buttonProps["aria-label"] ?? label}
          className={cn(
            "group/button relative inline-flex shrink-0 select-none items-center justify-center rounded-lg border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
            iconOnly ? iconOnlySizeClasses[size] : sizeClasses[size],
            variantClasses[variant],
            className,
          )}
          disabled={disabled}
          onClick={(event) => {
            if (pending) {
              event.preventDefault();
              return;
            }
            if (type === "submit") {
              event.preventDefault();
            }
            run();
          }}
          ref={ref}
          style={{ borderRadius: 9, touchAction: "manipulation" }}
          transition={CELL}
          type={type}
          whileTap={disabled || pending || reduced ? undefined : { y: 1 }}
        >
          <span aria-hidden="true" className="relative grid place-items-center">
            {faces.map((face) => (
              <motion.span
                animate={
                  face.key === status
                    ? { opacity: 1, y: 0, filter: "blur(0px)" }
                    : { opacity: 0, y: 3, filter: "blur(3px)" }
                }
                className={cn(
                  "col-start-1 row-start-1 flex items-center justify-center gap-1.5 whitespace-nowrap",
                  face.tone,
                )}
                initial={false}
                key={face.key}
                transition={fade}
              >
                {face.icon}
                <span className={iconOnly ? "sr-only" : undefined}>
                  {face.text}
                </span>
              </motion.span>
            ))}
          </span>
        </motion.button>

        <span aria-live="polite" className="sr-only" role="status">
          {status === "success"
            ? successLabel
            : status === "error"
              ? errorLabel
              : ""}
        </span>
      </>
    );
  },
);

LoadingButton.displayName = "LoadingButton";
