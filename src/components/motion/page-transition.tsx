import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/utils";

export const MOTION_EASE = [0.23, 1, 0.32, 1] as const;
export const MOTION_LEAVE_EASE = [0.4, 0, 1, 1] as const;

export const pageEnterTransition = {
  duration: 0.28,
  ease: MOTION_EASE,
};

export const pageExitTransition = {
  duration: 0.16,
  ease: MOTION_LEAVE_EASE,
};

export const pageInitial = {
  opacity: 0,
  y: 10,
  scale: 0.985,
};

export const pageAnimate = {
  opacity: 1,
  y: 0,
  scale: 1,
};

export const pageExit = {
  opacity: 0,
  y: 6,
  scale: 0.99,
};

export const viewLayerTransition = {
  opacity: pageEnterTransition,
  y: pageEnterTransition,
  scale: pageEnterTransition,
};

export function MotionPage({
  children,
  className,
  ...props
}: HTMLMotionProps<"div">) {
  return (
    <motion.div
      animate={pageAnimate}
      className={cn("motion-page min-h-0", className)}
      exit={pageExit}
      initial={pageInitial}
      transition={pageEnterTransition}
      {...props}
    >
      {children}
    </motion.div>
  );
}
