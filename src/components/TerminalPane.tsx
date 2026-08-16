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

    // ACK only when there is unacked parsed output; reset once the ACK fires.
    term.onWriteParsed(() => {
      if (idRef.current && parsedRef.current > 0) {
        ptyAck(idRef.current, parsedRef.current);
        parsedRef.current = 0;
      }
    });

    ptySpawn()
      .then((id) => {
        idRef.current = id;
        onPtyData((p) => {
          if (p.id === id) {
            parsedRef.current = p.data.length;
            term.write(p.data);
          }
        }).then((unlisten) => unsubs.push(unlisten));
        onPtyExit((p) => {
          if (p.id === id) {
            term.writeln(`\r\n[process exited: ${p.code ?? "error"}]`);
          }
        }).then((unlisten) => unsubs.push(unlisten));
        term.onData((data) => ptyWrite(id, data));
      })
      .catch((err: unknown) => {
        // Spawn failed — one-line error; the pane stays so you can retry.
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
      ro.disconnect();
      unsubs.forEach((u) => u());
      if (idRef.current) ptyKill(idRef.current).catch(() => {});
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="terminal-pane" />;
}
