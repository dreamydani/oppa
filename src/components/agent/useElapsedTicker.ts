import { useEffect, useState } from "react";

// Time-in-state needs periodic refresh, but one interval per pill would
// multiply with fleet size. One shared tick drives every mounted pill.
const TICK_MS = 30_000;

// Compact elapsed label: now (<1m), Nm, Nh, Nd.
export function formatElapsed(now: number, startedAt: number): string {
  const ms = now - startedAt;
  if (ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Shared 30s tick; all pills re-render together from one interval. */
export function useElapsedTicker(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
