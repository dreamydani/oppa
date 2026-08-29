// Exit presence: the reason almost nothing in this app animates out is that
// conditional rendering unmounts the node in the same commit that closes it,
// so there is no element left to animate. This holds the node mounted for the
// duration of the exit animation and reports a `state` to drive it.
//
// Pair with CSS `data-state` *animations*, not transitions: a transition cannot
// play on mount because there is no prior style to interpolate from, whereas a
// keyframe animation auto-plays. Both directions are therefore keyframes in the
// stylesheet and this hook only ever toggles an attribute.

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./reducedMotion";

export type PresenceState = "open" | "closed";

export interface ExitPresence {
  /** Render the node at all. */
  present: boolean;
  /** Drives `[data-state=...]` CSS. */
  state: PresenceState;
}

export function useExitPresence(open: boolean, exitMs: number): ExitPresence {
  // A closed first render must not mount: nothing is leaving, so there is
  // nothing to animate out.
  const [present, setPresent] = useState(open);
  const [state, setState] = useState<PresenceState>(open ? "open" : "closed");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read synchronously so the effect never has to derive state from setState.
  const mounted = useRef(open);

  useEffect(() => {
    const clear = () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
    };

    if (open) {
      // Reopening mid-exit: abandon the pending unmount, or a stale timer
      // tears down a panel the user just brought back.
      clear();
      if (!mounted.current) {
        mounted.current = true;
        setPresent(true);
      }
      setState("open");
      return clear;
    }

    if (!mounted.current) return;

    setState("closed");
    if (prefersReducedMotion() || exitMs <= 0) {
      clear();
      mounted.current = false;
      setPresent(false);
      return;
    }
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      mounted.current = false;
      setPresent(false);
    }, exitMs);
    return clear;
  }, [open, exitMs]);

  return { present, state };
}
