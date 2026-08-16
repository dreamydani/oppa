import { useEffect, useRef } from "react";
import { useTerminalStore } from "../store/terminalStore";
import { TerminalPane } from "./TerminalPane";

// A leaf in the layout tree guarantees a live session: if the leaf id has no
// session in the store yet (a fresh root `""` or a placeholder from a future
// persisted-layout restore), spawn one and swap the leaf id to the real
// session id. Rendering the terminal is delegated to TerminalPane.
export function SessionLeaf({ id }: { id: string }) {
  const session = useTerminalStore((s) => s.sessions[id]);
  const spawnSession = useTerminalStore((s) => s.spawnSession);
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
      useTerminalStore.setState((state) => ({
        // Only swap when the leaf is still the placeholder — the layout may
        // have changed (split/close) while the spawn was in flight.
        layout:
          state.layout.type === "leaf" && state.layout.id === id
            ? { type: "leaf", id: realId }
            : state.layout,
      }));
    });
  }, [id, session, spawnSession]);

  if (session) return <TerminalPane id={session.id} />;

  // Placeholder while the spawn is in flight (or the leaf has no session yet).
  return (
    <div ref={nodeRef} className="session-leaf-loading" data-placeholder-id={id} />
  );
}
