import { useEffect, useRef } from "react";
import { useTerminalStore } from "../store/terminalStore";
import type { Path } from "../store/terminalStore";
import { TerminalPane } from "./TerminalPane";

// A leaf in the layout tree guarantees a live session: if the leaf id has no
// session in the store yet (a fresh root `""` or a placeholder from a future
// persisted-layout restore), spawn one and swap the leaf id to the real
// session id. Rendering the terminal is delegated to TerminalPane.
export function SessionLeaf({ id, path }: { id: string; path?: Path }) {
  const session = useTerminalStore((s) => s.sessions[id]);
  const spawnSession = useTerminalStore((s) => s.spawnSession);
  const substituteSessionId = useTerminalStore((s) => s.substituteSessionId);
  const nodeRef = useRef<HTMLDivElement>(null);
  // StrictMode double-invokes effects in dev; the swap is idempotent (the
  // placeholder id is already gone after the first pass) but the spawn itself
  // must run exactly once.
  const startedRef = useRef(false);

  useEffect(() => {
    if (session || startedRef.current) return;
    startedRef.current = true;
    spawnSession().then((realId) => {
      // Only bind when this leaf is still on screen. A real unmount removes
      // the node (React also nulls the ref); StrictMode's dev-only effect
      // replay does not, so the swap survives the double-invoked mount.
      if (!nodeRef.current?.isConnected) return;
      // Substitute the resolved id for the placeholder wherever it still
      // occurs in the tree: a split/close during the in-flight spawn can
      // wrap the placeholder as a child (or clone it), so the swap cannot
      // assume the placeholder is still the root. When the placeholder is
      // already gone (e.g. the leaf was closed), this is a no-op.
      substituteSessionId(id, realId);
    });
  }, [id, session, spawnSession, substituteSessionId]);

  if (session) return <TerminalPane id={session.id} path={path} />;

  // Placeholder while the spawn is in flight (or the leaf has no session yet).
  return (
    <div
      ref={nodeRef}
      className="session-leaf-loading terminal-loading-skeleton"
      data-placeholder-id={id}
    >
      <div className="terminal-loading-shimmer" />
      <div className="terminal-loading-content">
        <span className="terminal-loading-spinner" />
        <span className="terminal-loading-text">Session loading...</span>
      </div>
    </div>
  );
}
