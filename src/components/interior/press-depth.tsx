"use client";

import { motion, useReducedMotion } from "motion/react";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type {
  ComponentPropsWithoutRef,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export const PRESS_DEPTH_TRANSITION = {
  type: "spring",
  stiffness: 520,
  damping: 34,
  mass: 0.45,
} as const;
const INSTANT = { duration: 0 } as const;
const PRESS_DEPTH_RADIUS = 9;

export const PRESS_DEPTH_BACK_CLASSES = {
  default: "bg-stone-300 dark:bg-white/25",
  destructive: "bg-red-300/80 dark:bg-red-200/25",
  ghost: "bg-stone-300 dark:bg-white/25",
  link: "bg-stone-300/60 dark:bg-white/15",
  outline: "bg-stone-300 dark:bg-white/25",
  secondary: "bg-stone-300 dark:bg-white/25",
} as const;

export type PressOrigin = { x: number; y: number };

export type UsePressDepthOptions = {
  disabled?: boolean;
  onPressStart?: () => void;
  onPressEnd?: () => void;
};

export type PressDepthBindings = {
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
};

export type UsePressDepthResult = {
  bind: PressDepthBindings;
  origin: PressOrigin | null;
  pressed: boolean;
  ref: (node: HTMLElement | null) => void;
};

/**
 * Tracks pointer and keyboard presses for an arbitrary pressable surface.
 * The native element keeps ownership of click and form semantics; this hook
 * only owns the transient pressed state and the pointer-origin tilt.
 */
export function usePressDepth(
  options: UsePressDepthOptions = {},
): UsePressDepthResult {
  const { disabled = false, onPressEnd, onPressStart } = options;
  const [pressed, setPressed] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [origin, setOrigin] = useState<PressOrigin | null>(null);

  const node = useRef<HTMLElement | null>(null);
  const pointer = useRef<number | null>(null);
  const down = useRef(false);
  const began = useRef(onPressStart);
  const ended = useRef(onPressEnd);

  began.current = onPressStart;
  ended.current = onPressEnd;

  const setDown = useCallback((next: boolean) => {
    if (down.current === next) return;
    down.current = next;
    setPressed(next);
    if (next) began.current?.();
    else ended.current?.();
  }, []);

  const stop = useCallback(() => {
    pointer.current = null;
    setTracking(false);
    setOrigin(null);
    setDown(false);
  }, [setDown]);

  useEffect(() => {
    if (!tracking) return;

    const contains = (event: globalThis.PointerEvent) => {
      const element = node.current;
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    };

    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointer.current) return;
      setDown(contains(event));
    };
    const lift = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointer.current) return;
      stop();
    };
    const bail = () => stop();
    const hidden = () => {
      if (document.hidden) stop();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", lift);
    window.addEventListener("pointercancel", lift);
    window.addEventListener("blur", bail);
    document.addEventListener("visibilitychange", hidden);

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", lift);
      window.removeEventListener("pointercancel", lift);
      window.removeEventListener("blur", bail);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [setDown, stop, tracking]);

  useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);

  const ref = useCallback((next: HTMLElement | null) => {
    node.current = next;
  }, []);

  const bind: PressDepthBindings = {
    onBlur: () => stop(),
    onKeyDown: (event) => {
      if (disabled || event.repeat) return;
      if (event.key !== " " && event.key !== "Enter") return;
      setDown(true);
    },
    onKeyUp: (event) => {
      if (
        event.key !== " " &&
        event.key !== "Enter" &&
        event.key !== "Escape"
      ) {
        return;
      }
      setDown(false);
    },
    onPointerDown: (event) => {
      if (disabled) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      const rect = event.currentTarget.getBoundingClientRect();
      setOrigin({
        x: Math.max(
          -1,
          Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1),
        ),
        y: Math.max(
          -1,
          Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1),
        ),
      });
      pointer.current = event.pointerId;
      setTracking(true);
      setDown(true);
    },
  };

  return { bind, origin, pressed, ref };
}

type PressDepthVariant =
  "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
type PressDepthSize = "default" | "xs" | "sm" | "lg";

const PRESS_DEPTH_FACE_BASE =
  "relative inline-flex items-center justify-center rounded-[9px] border font-medium select-none outline-none transition-[color,background-color,border-color,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] group-focus-visible:ring-2 [&_svg]:pointer-events-none [&_svg]:shrink-0";
const PRESS_DEPTH_SIZE_CLASSES: Record<PressDepthSize, string> = {
  default: "h-9 gap-2 px-3.5 text-[13px] [&_svg:not([class*='size-'])]:size-4",
  lg: "h-9 gap-2 px-3.5 text-[13px] [&_svg:not([class*='size-'])]:size-4",
  sm: "h-7 gap-1.5 px-2.5 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
  xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
};
const PRESS_DEPTH_FACE_CLASSES: Record<PressDepthVariant, string> = {
  default:
    "border-stone-200 bg-white text-stone-700 group-focus-visible:ring-stone-400 dark:border-white/[0.16] dark:bg-[#1D1D1A] dark:text-stone-200 dark:group-focus-visible:ring-stone-500",
  destructive:
    "border-red-200 bg-red-50 text-red-700 hover:bg-red-100 group-focus-visible:ring-red-400 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/60 dark:group-focus-visible:ring-red-500",
  ghost:
    "border-transparent bg-transparent text-stone-700 group-focus-visible:ring-stone-400 dark:text-stone-200 dark:group-focus-visible:ring-stone-500",
  link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline group-focus-visible:ring-primary/40",
  outline:
    "border-stone-200 bg-white text-stone-700 group-focus-visible:ring-stone-400 dark:border-white/[0.16] dark:bg-[#1D1D1A] dark:text-stone-200 dark:group-focus-visible:ring-stone-500",
  secondary:
    "border-stone-200 bg-stone-100 text-stone-800 group-focus-visible:ring-stone-400 dark:border-white/[0.16] dark:bg-[#1D1D1A] dark:text-stone-200 dark:group-focus-visible:ring-stone-500",
};

export type PressDepthButtonProps = ComponentPropsWithoutRef<"button"> & {
  children?: ReactNode;
  depth?: number;
  size?: PressDepthSize;
  tilt?: number;
  variant?: PressDepthVariant;
};

/**
 * A tactile button that follows Interior's documented two-layer surface. The
 * outer button owns all native semantics while the animated face is the only
 * visible key surface.
 */
export const PressDepthButton = forwardRef<
  HTMLButtonElement,
  PressDepthButtonProps
>(function PressDepthButton(
  {
    children,
    className,
    depth,
    disabled = false,
    onBlur,
    onKeyDown,
    onKeyUp,
    onPointerDown,
    size = "default",
    style,
    tilt = 7,
    type = "button",
    variant = "default",
    ...props
  },
  forwardedRef,
) {
  const reduced = useReducedMotion();
  const { bind, origin, pressed, ref } = usePressDepth({ disabled });
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      ref(node);
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef, ref],
  );
  const lean = pressed && origin && !reduced ? origin : null;
  const depthAmount = depth ?? (size === "sm" || size === "xs" ? 2 : 4);
  const motionTransition = reduced ? INSTANT : PRESS_DEPTH_TRANSITION;
  const backClass =
    PRESS_DEPTH_BACK_CLASSES[
      variant as keyof typeof PRESS_DEPTH_BACK_CLASSES
    ] ?? PRESS_DEPTH_BACK_CLASSES.default;

  return (
    <button
      {...props}
      {...bind}
      ref={setRef}
      aria-disabled={disabled || undefined}
      data-pressed={pressed ? "" : undefined}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      disabled={disabled}
      onBlur={(event) => {
        bind.onBlur();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        bind.onKeyDown(event);
        onKeyDown?.(event);
      }}
      onKeyUp={(event) => {
        bind.onKeyUp(event);
        onKeyUp?.(event);
      }}
      onPointerDown={(event) => {
        bind.onPointerDown(event);
        onPointerDown?.(event);
      }}
      style={{
        borderRadius: PRESS_DEPTH_RADIUS,
        paddingBottom: depthAmount,
        touchAction: "manipulation",
        WebkitTapHighlightColor: "transparent",
        ...style,
      }}
      type={type}
      className="group/press-depth relative inline-flex shrink-0 select-none rounded-[9px] align-middle outline-none disabled:pointer-events-none disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 rounded-[9px]",
          backClass,
        )}
        style={{ borderRadius: PRESS_DEPTH_RADIUS, top: depthAmount }}
      />
      <motion.span
        animate={{
          rotateX: lean ? -lean.y * tilt : 0,
          rotateY: lean ? lean.x * tilt : 0,
          y: pressed ? depthAmount : 0,
        }}
        className={cn(
          PRESS_DEPTH_FACE_BASE,
          PRESS_DEPTH_SIZE_CLASSES[size],
          PRESS_DEPTH_FACE_CLASSES[variant],
          className,
        )}
        initial={false}
        style={{
          borderRadius: PRESS_DEPTH_RADIUS,
          transformPerspective: 340,
        }}
        transition={motionTransition}
      >
        <motion.span
          aria-hidden="true"
          animate={{ opacity: pressed ? 0 : 1 }}
          className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_1.5px_0_rgba(255,255,255,0.95),inset_0_-1px_0_rgba(28,25,23,0.06)] dark:shadow-[inset_0_1.5px_0_rgba(255,255,255,0.09)]"
          initial={false}
          transition={motionTransition}
        />
        {children}
      </motion.span>
    </button>
  );
});
