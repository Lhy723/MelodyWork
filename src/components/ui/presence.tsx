import { useEffect, useRef, useState, type ReactNode } from "react";

type MotionState = "open" | "closed";

interface PresenceProps {
  children: (state: MotionState) => ReactNode;
  exitDuration?: number;
  present: boolean;
}

function Presence({
  children,
  exitDuration = 220,
  present,
}: PresenceProps) {
  const [mounted, setMounted] = useState(present);
  const [visible, setVisible] = useState(false);
  const exitTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(exitTimer.current);

    if (present) {
      setMounted(true);
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }

    setVisible(false);
    exitTimer.current = window.setTimeout(
      () => setMounted(false),
      exitDuration,
    );

    return () => window.clearTimeout(exitTimer.current);
  }, [exitDuration, present]);

  if (!mounted) {
    return null;
  }

  return children(visible ? "open" : "closed");
}

export { Presence, type MotionState };
