"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

const SPRING = {
  type: "spring",
  stiffness: 430,
  damping: 32,
  mass: 0.75,
} as const;
const INSTANT = { duration: 0 } as const;

export type PresencePerson = {
  id: string;
  name: string;
  src?: string;
};

export type PresenceAvatarSize = "xs" | "sm" | "md" | "lg";
export type PresenceAvatarOverlap = "tight" | "normal" | "loose";

export type PresenceAvatarsProps = {
  people: readonly PresencePerson[];
  max?: number;
  size?: PresenceAvatarSize;
  overlap?: PresenceAvatarOverlap;
  label?: string;
  announceAfter?: number;
  onOverflowSelect?: (people: PresencePerson[]) => void;
  renderAvatar?: (person: PresencePerson) => ReactNode;
  decorative?: boolean;
  className?: string;
};

const SIZE_CLASSES: Record<PresenceAvatarSize, string> = {
  xs: "size-5 text-[8px]",
  sm: "size-6 text-[9px]",
  md: "size-8 text-[11px]",
  lg: "size-10 text-xs",
};

const OVERFLOW_CLASSES: Record<PresenceAvatarSize, string> = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
};

const OVERLAP_CLASSES: Record<PresenceAvatarOverlap, string> = {
  tight: "-ml-2 first:ml-0",
  normal: "-ml-1.5 first:ml-0",
  loose: "-ml-1 first:ml-0",
};

const initials = (name: string) => {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length > 1) {
    return `${Array.from(words[0] ?? "")[0] ?? ""}${Array.from(words[1] ?? "")[0] ?? ""}`.toUpperCase();
  }
  return Array.from(words[0] ?? "?")
    .slice(0, 2)
    .join("")
    .toUpperCase();
};

function DefaultAvatar({
  person,
  size,
}: {
  person: PresencePerson;
  size: PresenceAvatarSize;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      aria-label={person.name}
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full border-2 border-background bg-muted font-semibold text-muted-foreground",
        SIZE_CLASSES[size],
      )}
      role="img"
      title={person.name}
    >
      {person.src && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
          src={person.src}
        />
      ) : (
        initials(person.name)
      )}
    </span>
  );
}

function useStablePeople(people: readonly PresencePerson[]) {
  const orderRef = useRef<string[]>([]);

  return useMemo(() => {
    const available = new Map(people.map((person) => [person.id, person]));
    const previousIds = new Set(orderRef.current);
    const retained = orderRef.current.filter((id) => available.has(id));
    const added = people
      .map((person) => person.id)
      .filter((id) => !previousIds.has(id));
    const order = [...added, ...retained];
    orderRef.current = order;
    return order.flatMap((id) => {
      const person = available.get(id);
      return person ? [person] : [];
    });
  }, [people]);
}

function usePresenceAnnouncement(
  people: readonly PresencePerson[],
  label: string,
  announceAfter: number,
) {
  const [announcement, setAnnouncement] = useState("");
  const previousIdsRef = useRef<string[]>([]);
  const previousNamesRef = useRef(new Map<string, string>());

  useEffect(() => {
    const currentIds = people.map((person) => person.id);
    const previousIds = previousIdsRef.current;
    const previousNames = previousNamesRef.current;
    const currentNames = new Map(
      people.map((person) => [person.id, person.name]),
    );
    previousIdsRef.current = currentIds;
    previousNamesRef.current = currentNames;

    if (previousIds.length === 0) return;

    const added = currentIds.filter((id) => !previousIds.includes(id));
    const removed = previousIds.filter((id) => !currentIds.includes(id));
    if (added.length === 0 && removed.length === 0) return;

    const timer = window.setTimeout(
      () => {
        const addedNames = added
          .map((id) => currentNames.get(id))
          .filter((name): name is string => Boolean(name));
        const removedNames = removed
          .map((id) => previousNames.get(id))
          .filter((name): name is string => Boolean(name));
        const parts = [
          addedNames.length > 0 ? `${addedNames.join("、")} 加入` : "",
          removedNames.length > 0 ? `${removedNames.join("、")} 离开` : "",
        ].filter(Boolean);
        setAnnouncement(`${label}：${parts.join("；")}。`);
      },
      Math.max(0, announceAfter),
    );

    return () => window.clearTimeout(timer);
  }, [announceAfter, label, people]);

  return announcement;
}

/**
 * A compact, accessible presence roster adapted from Interior's Presence
 * Avatars. The caller can provide a local avatar renderer for generated
 * avatars while this component owns stable ordering and enter/leave motion.
 */
export function PresenceAvatars({
  people,
  max = 5,
  size = "sm",
  overlap = "normal",
  label = "参与者",
  announceAfter = 900,
  onOverflowSelect,
  renderAvatar,
  decorative = false,
  className,
}: PresenceAvatarsProps) {
  const reduced = useReducedMotion();
  const stablePeople = useStablePeople(people);
  const visibleLimit = Math.max(1, Math.floor(max));
  const visible = stablePeople.slice(0, visibleLimit);
  const hidden = stablePeople.slice(visibleLimit);
  const announcement = usePresenceAnnouncement(people, label, announceAfter);
  const transition = reduced ? INSTANT : SPRING;

  if (stablePeople.length === 0) return null;

  return (
    <div
      aria-hidden={decorative ? true : undefined}
      aria-label={
        decorative
          ? undefined
          : `${label}：${stablePeople.map((person) => person.name).join("、")}`
      }
      className={cn("flex min-w-0 items-center", className)}
      role={decorative ? undefined : "group"}
    >
      <AnimatePresence initial={false}>
        {visible.map((person) => (
          <motion.span
            animate={{ opacity: 1, scale: 1, x: 0 }}
            className={cn(
              "relative z-0 block shrink-0 rounded-full",
              OVERLAP_CLASSES[overlap],
            )}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.72, x: -4 }}
            initial={reduced ? false : { opacity: 0, scale: 0.72, x: 4 }}
            key={person.id}
            layout
            transition={transition}
          >
            {renderAvatar ? (
              renderAvatar(person)
            ) : (
              <DefaultAvatar person={person} size={size} />
            )}
          </motion.span>
        ))}
      </AnimatePresence>
      {hidden.length > 0 ? (
        <motion.span
          animate={{ opacity: 1, scale: 1 }}
          className={cn(
            "relative z-10 -ml-1.5 grid shrink-0 place-items-center rounded-full border-2 border-background bg-muted font-medium text-muted-foreground",
            OVERFLOW_CLASSES[size],
          )}
          initial={reduced ? false : { opacity: 0, scale: 0.72 }}
          layout
          transition={transition}
        >
          {onOverflowSelect ? (
            <button
              aria-label={`查看其余 ${hidden.length} 位${label}`}
              className="grid size-full place-items-center rounded-full outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOverflowSelect(hidden)}
              title={`其余 ${hidden.length} 位${label}`}
              type="button"
            >
              +{hidden.length}
            </button>
          ) : (
            <span aria-label={`另有 ${hidden.length} 位${label}`}>
              +{hidden.length}
            </span>
          )}
        </motion.span>
      ) : null}
      {!decorative ? (
        <span aria-live="polite" className="sr-only">
          {announcement}
        </span>
      ) : null}
    </div>
  );
}
