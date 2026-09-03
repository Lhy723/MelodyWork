"use client";

import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

import { cn } from "@/lib/utils";

const EASE = [0.23, 1, 0.32, 1] as const;
const BLOOM = { duration: 0.5, ease: "linear" } as const;
const BASE = 40;

export type RippleSpec = {
  id: number;
  x: number;
  y: number;
  scale: number;
  released: boolean;
};

export type UseRippleOptions = {
  disabled?: boolean;
  fade?: number;
  max?: number;
  minVisible?: number;
};

export type RippleBindings = {
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
};

/**
 * Tracks short-lived pointer/keyboard blooms for an arbitrary pressable
 * surface. The visual layer is kept separate so existing buttons can retain
 * their variants, semantics, and event handlers.
 */
export function useRipple({
  disabled = false,
  fade = 320,
  max = 4,
  minVisible = 220,
}: UseRippleOptions = {}) {
  const [ripples, setRipples] = useState<RippleSpec[]>([]);
  const list = useRef<RippleSpec[]>([]);
  const sequence = useRef(0);
  const born = useRef(new Map<number, number>());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>[]>());
  const pointers = useRef(new Map<number, number>());
  const keyed = useRef<number | null>(null);
  const limit = Math.max(1, max);

  const commit = useCallback((next: RippleSpec[]) => {
    list.current = next;
    setRipples(next);
  }, []);

  const forget = useCallback((id: number) => {
    timers.current.get(id)?.forEach(clearTimeout);
    timers.current.delete(id);
    born.current.delete(id);
  }, []);

  const spawn = useCallback(
    (element: HTMLElement, clientX?: number, clientY?: number) => {
      const rect = element.getBoundingClientRect();
      const x = Math.round(
        clientX === undefined ? rect.width / 2 : clientX - rect.left,
      );
      const y = Math.round(
        clientY === undefined ? rect.height / 2 : clientY - rect.top,
      );
      const reach = Math.max(
        Math.hypot(x, y),
        Math.hypot(rect.width - x, y),
        Math.hypot(x, rect.height - y),
        Math.hypot(rect.width - x, rect.height - y),
      );

      let next = list.current;
      while (next.length >= limit) {
        forget(next[0].id);
        next = next.slice(1);
      }

      const id = (sequence.current += 1);
      born.current.set(id, performance.now());
      commit([
        ...next,
        {
          id,
          x,
          y,
          scale: Math.round((reach * 200) / BASE) / 100,
          released: false,
        },
      ]);
      return id;
    },
    [commit, forget, limit],
  );

  const release = useCallback(
    (id: number) => {
      if (timers.current.has(id)) return;
      if (!list.current.some((ripple) => ripple.id === id)) return;

      const wait = Math.max(
        0,
        minVisible - (performance.now() - (born.current.get(id) ?? 0)),
      );
      const start = setTimeout(() => {
        commit(
          list.current.map((ripple) =>
            ripple.id === id ? { ...ripple, released: true } : ripple,
          ),
        );
      }, wait);
      const drop = setTimeout(() => {
        forget(id);
        commit(list.current.filter((ripple) => ripple.id !== id));
      }, wait + fade);

      timers.current.set(id, [start, drop]);
    },
    [commit, fade, forget, minVisible],
  );

  const releaseAll = useCallback(() => {
    pointers.current.forEach((id) => release(id));
    pointers.current.clear();
    if (keyed.current !== null) {
      release(keyed.current);
      keyed.current = null;
    }
  }, [release]);

  const endPointer = useCallback(
    (pointerId: number) => {
      const id = pointers.current.get(pointerId);
      if (id === undefined) return;
      pointers.current.delete(pointerId);
      release(id);
    },
    [release],
  );

  useEffect(() => {
    const cancel = () => releaseAll();
    const onVisibilityChange = () => {
      if (document.hidden) releaseAll();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [releaseAll]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((handles) => handles.forEach(clearTimeout));
      pending.clear();
    };
  }, []);

  const bindings: RippleBindings = {
    onBlur: () => releaseAll(),
    onKeyDown: (event) => {
      if (disabled || event.repeat || keyed.current !== null) return;
      if (event.key !== " " && event.key !== "Enter") return;
      keyed.current = spawn(event.currentTarget);
    },
    onKeyUp: (event) => {
      if (keyed.current === null) return;
      if (
        event.key !== " " &&
        event.key !== "Enter" &&
        event.key !== "Escape"
      ) {
        return;
      }
      release(keyed.current);
      keyed.current = null;
    },
    onLostPointerCapture: (event) => endPointer(event.pointerId),
    onPointerCancel: (event) => endPointer(event.pointerId),
    onPointerDown: (event) => {
      if (disabled) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (pointers.current.has(event.pointerId)) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pointers.current.set(
        event.pointerId,
        spawn(event.currentTarget, event.clientX, event.clientY),
      );
    },
    onPointerUp: (event) => endPointer(event.pointerId),
  };

  return { bindings, fadeDuration: fade / 1000, ripples };
}

export function RippleLayer({
  className,
  fadeDuration,
  ripples,
  tintClassName = "bg-current/10 dark:bg-current/15",
}: {
  className?: string;
  fadeDuration: number;
  ripples: RippleSpec[];
  tintClassName?: string;
}) {
  const reduced = useReducedMotion();

  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]",
        className,
      )}
    >
      {ripples.map((ripple) => (
        <motion.span
          animate={{ scale: ripple.scale, opacity: ripple.released ? 0 : 1 }}
          className={cn("absolute block rounded-full", tintClassName)}
          initial={{ scale: reduced ? ripple.scale : 0, opacity: 0 }}
          key={ripple.id}
          style={{
            height: BASE,
            left: ripple.x - BASE / 2,
            top: ripple.y - BASE / 2,
            width: BASE,
            willChange: "transform, opacity",
          }}
          transition={{
            opacity: {
              duration: ripple.released ? fadeDuration : 0.07,
              ease: ripple.released ? EASE : "linear",
            },
            scale: reduced ? { duration: 0 } : BLOOM,
          }}
        />
      ))}
    </span>
  );
}
