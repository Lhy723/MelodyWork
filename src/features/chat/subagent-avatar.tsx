import type { AgentSubagent } from "@/domain/acp";
import { cn } from "@/lib/utils";

type AvatarPalette = {
  surface: string;
  foreground: string;
  accent: string;
  detail: string;
};

const PALETTES: AvatarPalette[] = [
  {
    surface: "bg-sky-100 dark:bg-sky-950/80",
    foreground: "text-sky-800 dark:text-sky-200",
    accent: "fill-cyan-500/90 dark:fill-cyan-300/90",
    detail: "fill-sky-950/25 dark:fill-white/65",
  },
  {
    surface: "bg-violet-100 dark:bg-violet-950/80",
    foreground: "text-violet-800 dark:text-violet-200",
    accent: "fill-fuchsia-500/90 dark:fill-fuchsia-300/90",
    detail: "fill-violet-950/25 dark:fill-white/65",
  },
  {
    surface: "bg-amber-100 dark:bg-amber-950/80",
    foreground: "text-amber-800 dark:text-amber-200",
    accent: "fill-orange-500/90 dark:fill-orange-300/90",
    detail: "fill-amber-950/25 dark:fill-white/65",
  },
  {
    surface: "bg-emerald-100 dark:bg-emerald-950/80",
    foreground: "text-emerald-800 dark:text-emerald-200",
    accent: "fill-teal-500/90 dark:fill-teal-300/90",
    detail: "fill-emerald-950/25 dark:fill-white/65",
  },
  {
    surface: "bg-rose-100 dark:bg-rose-950/80",
    foreground: "text-rose-800 dark:text-rose-200",
    accent: "fill-rose-500/90 dark:fill-rose-300/90",
    detail: "fill-rose-950/25 dark:fill-white/65",
  },
  {
    surface: "bg-cyan-100 dark:bg-cyan-950/80",
    foreground: "text-cyan-800 dark:text-cyan-200",
    accent: "fill-blue-500/90 dark:fill-blue-300/90",
    detail: "fill-cyan-950/25 dark:fill-white/65",
  },
];

const SIZE_CLASSES = {
  xs: "size-5",
  sm: "size-6",
  md: "size-7",
  lg: "size-10",
} as const;

type PixelTone = "accent" | "detail" | "foreground";

const PIXEL_PATTERNS = [
  ["0001000", "0012100", "0123210", "1233321", "0123210", "0012100", "0001000"],
  ["0010000", "0111000", "1121100", "1111110", "0111000", "0010000", "0000000"],
  ["0011100", "0120210", "1200021", "1001001", "1200021", "0120210", "0011100"],
  ["1233321", "0123210", "0012100", "0001000", "0012100", "0123210", "1233321"],
  ["1000001", "2100012", "3210123", "0123210", "0012100", "0001000", "0000000"],
  ["1100110", "1200210", "1122110", "0001000", "0112211", "0120021", "0110011"],
] as const;

const getPixelCells = (pattern: readonly string[], mirrored: boolean) => {
  const cells: Array<{ x: number; y: number; tone: PixelTone }> = [];
  pattern.forEach((row, y) => {
    [...row].forEach((value, columnIndex) => {
      const tone =
        value === "1"
          ? "accent"
          : value === "2"
            ? "detail"
            : value === "3"
              ? "foreground"
              : null;
      if (!tone) return;
      cells.push({
        x: mirrored ? row.length - 1 - columnIndex : columnIndex,
        y,
        tone,
      });
    });
  });
  return cells;
};

const hashString = (value: string) => {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

export type SubagentAvatarProps = {
  subagent: Pick<AgentSubagent, "subagentId" | "description" | "subagentType">;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
  decorative?: boolean;
  seed?: string;
};

export const SUBAGENT_PLACEHOLDER: Pick<
  AgentSubagent,
  "subagentId" | "description" | "subagentType"
> = {
  subagentId: "__subagent-placeholder__",
  description: "Subagent",
  subagentType: "placeholder",
};

/**
 * Creates a local pixel-art avatar from a stable Subagent id. The hash
 * intentionally looks random while keeping an agent recognisable across
 * status updates, replay, and reopening a workspace.
 */
export function SubagentAvatar({
  subagent,
  size = "sm",
  className,
  decorative = false,
  seed,
}: SubagentAvatarProps) {
  const avatarSeed = seed ?? subagent.subagentId;
  const hash = hashString(avatarSeed);
  const palette = PALETTES[hash % PALETTES.length] ?? PALETTES[0];
  const pattern =
    PIXEL_PATTERNS[(hash >>> 4) % PIXEL_PATTERNS.length] ?? PIXEL_PATTERNS[0];
  const pixelCells = getPixelCells(pattern, ((hash >>> 11) & 1) === 1);
  const label =
    subagent.description.trim() || subagent.subagentType || "Subagent";
  return (
    <span
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      className={cn(
        "relative isolate grid shrink-0 place-items-center overflow-hidden rounded-[22%] border border-background/80 shadow-sm",
        SIZE_CLASSES[size],
        palette.surface,
        palette.foreground,
        className,
      )}
      data-avatar-seed={avatarSeed}
      role={decorative ? undefined : "img"}
      title={decorative ? undefined : label}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full"
        fill="none"
        shapeRendering="crispEdges"
        viewBox="0 0 28 28"
      >
        {pixelCells.map((cell) => (
          <rect
            className={
              cell.tone === "accent"
                ? palette.accent
                : cell.tone === "detail"
                  ? palette.detail
                  : palette.foreground
            }
            fill="currentColor"
            height="3"
            key={`${cell.x}-${cell.y}`}
            width="3"
            x={4 + cell.x * 3}
            y={4 + cell.y * 3}
          />
        ))}
      </svg>
    </span>
  );
}
