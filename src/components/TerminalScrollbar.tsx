import { useCallback, useEffect, useRef, useState } from "react";

export interface TerminalScrollbarProps {
  /** The `.xterm-viewport` element driving scroll position. */
  viewport: HTMLElement;
  /** Full-screen TUI apps use the alternate buffer — nothing to scroll. */
  forceHidden?: boolean;
}

const IDLE_HIDE_MS = 900;
const MIN_THUMB_PCT = 8;

/* Floating overlay scrollbar for a terminal pane. Replaces the native
   xterm-viewport scrollbar (hidden via CSS) so text reaches the pane's true
   right edge; the thumb overlaps content and fades when idle. */
export function TerminalScrollbar({ viewport, forceHidden = false }: TerminalScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumbPct, setThumbPct] = useState(100);
  const [topPct, setTopPct] = useState(0);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recentScroll, setRecentScroll] = useState(false);
  const recentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markScrollActivity = useCallback(() => {
    setRecentScroll(true);
    if (recentTimerRef.current) clearTimeout(recentTimerRef.current);
    recentTimerRef.current = setTimeout(() => setRecentScroll(false), IDLE_HIDE_MS);
  }, []);

  useEffect(() => () => {
    if (recentTimerRef.current) clearTimeout(recentTimerRef.current);
  }, []);

  // Keep thumb geometry in sync with the viewport's scroll state.
  useEffect(() => {
    const sync = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const canScroll = scrollHeight > clientHeight + 1;
      setHasOverflow(canScroll);
      if (!canScroll) return;
      const ratio = Math.min(1, clientHeight / scrollHeight);
      const pct = Math.max(MIN_THUMB_PCT, ratio * 100);
      setThumbPct(pct);
      const maxScroll = scrollHeight - clientHeight;
      setTopPct(maxScroll > 0 ? (scrollTop / maxScroll) * (100 - pct) : 0);
    };
    sync();
    viewport.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [viewport]);

  // Any native scroll (wheel, keys, search jump) counts as activity.
  useEffect(() => {
    viewport.addEventListener("scroll", markScrollActivity, { passive: true });
    return () => viewport.removeEventListener("scroll", markScrollActivity);
  }, [viewport, markScrollActivity]);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const track = trackRef.current;
    if (!track || !hasOverflow) return;
    setDragging(true);
    const applyPointerY = (clientY: number) => {
      const rect = track.getBoundingClientRect();
      const thumbH = Math.max(1, (rect.height * thumbPct) / 100);
      const maxTravel = rect.height - thumbH;
      const y = Math.min(maxTravel, Math.max(0, clientY - rect.top - thumbH / 2));
      const frac = maxTravel > 0 ? y / maxTravel : 0;
      const maxScroll = viewport.scrollHeight - viewport.clientHeight;
      viewport.scrollTop = frac * maxScroll;
      markScrollActivity();
    };
    const onMove = (ev: PointerEvent) => applyPointerY(ev.clientY);
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    applyPointerY(e.clientY);
  };

  // Track click jumps the thumb center to the click point (page-wise nav).
  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    startDrag(e);
  };

  if (!viewport || forceHidden || (!hasOverflow && !dragging)) return null;

  const shown = dragging || hovering || recentScroll;

  return (
    <div
      ref={trackRef}
      className={`terminal-scrollbar${shown ? " shown" : ""}`}
      data-testid="terminal-scrollbar"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onPointerDown={handleTrackPointerDown}
    >
      <div
        className="terminal-scrollbar-thumb"
        data-testid="terminal-scrollbar-thumb"
        style={{ height: `${thumbPct}%`, top: `${topPct}%` }}
      />
    </div>
  );
}
