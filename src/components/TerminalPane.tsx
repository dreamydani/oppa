import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  ptyWrite,
  onPtyData,
  onPtyExit,
} from "../lib/pty/transport";
import { useTerminalStore } from "../store/terminalStore";

// Renders the terminal view for ONE store session. The session itself is
// owned by the store (spawned by SessionLeaf via spawnSession), so this
// component never spawns or kills: it attaches listeners, ACKs, and resizes.
// Closing a pane (removing the leaf) is the store's job.
export function TerminalPane({ id }: { id: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(id);
  const parsedRef = useRef(0);
  // Subscribe to the STATUS string, not the session object: resizeSession
  // writes a fresh session object into the store on every ResizeObserver
  // callback, and a RO fires immediately on observe(). Depending on the
  // session object would make that resize write re-run the effect
  // (cleanup + new Terminal + new RO -> initial fire -> resize -> ...),
  // disposing the xterm and wiping output forever. The status primitive
  // (missing -> running -> error) still drives attach/teardown, while
  // resize writes leave it unchanged.
  const status = useTerminalStore((s) => s.sessions[id]?.status);
  const session = useTerminalStore((s) => s.sessions[id]);
  const ackSession = useTerminalStore((s) => s.ackSession);
  const resizeSession = useTerminalStore((s) => s.resizeSession);

  useEffect(() => {
    // Missing session: SessionLeaf is still spawning (or the leaf is a stale
    // placeholder) — nothing to attach to yet.
    if (!status || status !== "running") return;

    // Rebuild the terminal when the id changes; the previous one is disposed.
    idRef.current = id;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Consolas, monospace",
      theme: { background: "#0d1117" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);

    const unsubs: (() => void)[] = [];
    // Set in cleanup. All post-spawn continuations check it: React.StrictMode
    // double-invokes effects in dev (and any unmount can race the async
    // spawn/listen), so without this flag a second PTY session would leak, a
    // late `listen` registration would never be unsubscribed, and `term.write`
    // could run on a disposed terminal.
    let disposed = false;

    // ACK only when there is unacked parsed output; reset once the ACK fires.
    term.onWriteParsed(() => {
      if (parsedRef.current > 0) {
        ackSession(idRef.current, parsedRef.current);
        parsedRef.current = 0;
      }
    });

    onPtyData((p) => {
      if (disposed) return;
      if (p.id === idRef.current) {
        // Cumulative chars parsed since the last ACK, so a chunk that lands
        // before the previous onWriteParsed fired still gets ACKed.
        // p.data.length counts UTF-16 code units, which can drift from the
        // backend's byte count for non-ASCII output — acceptable for v1
        // ASCII shells.
        parsedRef.current += p.data.length;
        term.write(p.data);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unsubs.push(unlisten);
    });
    onPtyExit((p) => {
      if (disposed) return;
      if (p.id === idRef.current) {
        term.writeln(`\r\n[process exited: ${p.code ?? "error"}]`);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unsubs.push(unlisten);
    });
    term.onData((data) => ptyWrite(idRef.current, data));

    const ro = new ResizeObserver(() => {
      fit.fit();
      const { cols, rows } = term;
      resizeSession(idRef.current, cols, rows);
    });
    ro.observe(containerRef.current!);

    return () => {
      // Flag first: any continuation that resolves after this point must
      // unsubscribe/clean up rather than register or write to the pane.
      disposed = true;
      ro.disconnect();
      unsubs.forEach((u) => u());
      term.dispose();
    };
  }, [id, status, ackSession, resizeSession]);

  if (!session) {
    // Session id not in the store yet — an empty container; SessionLeaf's
    // spawn swaps this pane in with the real id.
    return <div className="terminal-pane" />;
  }

  if (session.status === "error") {
    // One-line inline error; the pane stays so the message remains visible
    // (a re-spawn/retry path is out of scope for v1).
    return (
      <div className="terminal-pane terminal-pane-error">
        [session failed to start]
      </div>
    );
  }

  return <div ref={containerRef} className="terminal-pane" />;
}
