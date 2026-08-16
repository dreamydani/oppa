import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  ptySpawn,
  ptyWrite,
  ptyResize,
  ptyAck,
  ptyKill,
  onPtyData,
  onPtyExit,
} from "../lib/pty/transport";

export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<string | null>(null);
  const parsedRef = useRef(0);

  useEffect(() => {
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
      if (idRef.current && parsedRef.current > 0) {
        ptyAck(idRef.current, parsedRef.current);
        parsedRef.current = 0;
      }
    });

    ptySpawn()
      .then((id) => {
        if (disposed) {
          // Cleanup already ran (StrictMode first pass / early unmount):
          // kill the session that was created after the fact instead of
          // wiring listeners to a dead pane.
          ptyKill(id).catch(() => {});
          return;
        }
        idRef.current = id;
        onPtyData((p) => {
          if (disposed) return;
          if (p.id === id) {
            // Cumulative chars parsed since the last ACK, so a chunk that
            // lands before the previous onWriteParsed fired still gets ACKed.
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
          if (p.id === id) {
            term.writeln(`\r\n[process exited: ${p.code ?? "error"}]`);
          }
        }).then((unlisten) => {
          if (disposed) unlisten();
          else unsubs.push(unlisten);
        });
        term.onData((data) => ptyWrite(id, data));
      })
      .catch((err: unknown) => {
        // Spawn failed — one-line error; the pane remains so the message stays
        // visible (a re-spawn/retry path is out of scope for v1).
        term.writeln(
          `\r\n[spawn failed: ${err instanceof Error ? err.message : String(err)}]`,
        );
      });

    const ro = new ResizeObserver(() => {
      fit.fit();
      const { cols, rows } = term;
      if (idRef.current) ptyResize(idRef.current, cols, rows);
    });
    ro.observe(containerRef.current!);

    return () => {
      // Flag first: any continuation that resolves after this point must
      // unsubscribe/clean up rather than register or write to the pane.
      disposed = true;
      ro.disconnect();
      unsubs.forEach((u) => u());
      if (idRef.current) ptyKill(idRef.current).catch(() => {});
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="terminal-pane" />;
}
