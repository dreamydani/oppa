import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import {
  ptyWrite,
  onPtyData,
  onPtyExit,
  saveScrollback,
} from "../lib/pty/transport";
import { useTerminalStore } from "../store/terminalStore";
import { TerminalSearch } from "./TerminalSearch";

// Renders the terminal view for ONE store session with WebGL acceleration,
// Unicode 11 width calculation, clickable web links, and in-pane search overlay.
export function TerminalPane({ id }: { id: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const isSearchOpenRef = useRef(false);
  isSearchOpenRef.current = isSearchOpen;

  const idRef = useRef(id);
  const parsedRef = useRef(0);

  const status = useTerminalStore((s) => s.sessions[id]?.status);
  const session = useTerminalStore((s) => s.sessions[id]);
  const ackSession = useTerminalStore((s) => s.ackSession);
  const resizeSession = useTerminalStore((s) => s.resizeSession);
  const registerSerializer = useTerminalStore((s) => s.registerSerializer);
  const unregisterSerializer = useTerminalStore((s) => s.unregisterSerializer);
  const clearRestoredScrollback = useTerminalStore((s) => s.clearRestoredScrollback);

  const handleLinkClick = useCallback((_event: MouseEvent, uri: string) => {
    openUrl(uri).catch(() => {
      window.open(uri, "_blank", "noopener,noreferrer");
    });
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!status || status !== "running") return;

    idRef.current = id;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Consolas, monospace",
      theme: {
        background: "#141414",
        foreground: "#ededec",
        cursor: "#ededec",
        selectionBackground: "rgba(255, 255, 255, 0.15)",
      },
      allowProposedApi: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    const search = new SearchAddon();
    const webLinks = new WebLinksAddon(handleLinkClick);
    const serialize = new SerializeAddon();
    serializeAddonRef.current = serialize;

    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.loadAddon(search);
    term.loadAddon(webLinks);
    term.loadAddon(serialize);
    searchAddonRef.current = search;

    registerSerializer(id, () => serialize.serialize());

    term.open(containerRef.current!);

    const restoredScrollback = useTerminalStore.getState().restoredScrollbacks[id];
    if (restoredScrollback) {
      term.write(restoredScrollback);
      term.writeln("\r\n\x1b[2m── [Session Restored] ──────────────────────────────────────\x1b[0m\r\n");
      clearRestoredScrollback(id);
    }

    // WebGL Hardware Acceleration with Canvas / DOM fallback
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        try {
          term.loadAddon(new CanvasAddon());
        } catch {}
      });
      term.loadAddon(webgl);
    } catch {
      try {
        term.loadAddon(new CanvasAddon());
      } catch {}
    }

    const unsubs: (() => void)[] = [];
    let disposed = false;

    // Attach keyboard shortcut for Ctrl+F / Cmd+F and Escape
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setIsSearchOpen(true);
        return false;
      }
      if (event.key === "Escape" && isSearchOpenRef.current) {
        event.preventDefault();
        closeSearch();
        return false;
      }
      return true;
    });

    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushScrollback = () => {
      const buffer = serializeAddonRef.current?.serialize();
      if (buffer) {
        useTerminalStore.getState().cacheScrollback(idRef.current, buffer);
        void saveScrollback(idRef.current, buffer).catch(() => {});
      }
    };

    term.onWriteParsed(() => {
      if (parsedRef.current > 0) {
        ackSession(idRef.current, parsedRef.current);
        parsedRef.current = 0;
      }
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flushScrollback, 500);
    });

    onPtyData((p) => {
      if (disposed) return;
      if (p.id === idRef.current) {
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
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushScrollback();
      unregisterSerializer(idRef.current);
      disposed = true;
      ro.disconnect();
      unsubs.forEach((u) => u());
      term.dispose();
      termRef.current = null;
      searchAddonRef.current = null;
      serializeAddonRef.current = null;
    };
  }, [
    id,
    status,
    ackSession,
    resizeSession,
    handleLinkClick,
    closeSearch,
    registerSerializer,
    unregisterSerializer,
    clearRestoredScrollback,
  ]);

  if (!session) {
    return <div className="terminal-pane" />;
  }

  if (session.status === "error") {
    return (
      <div className="terminal-pane terminal-pane-error">
        {session.error ?? "[session failed to start]"}
      </div>
    );
  }

  return (
    <div
      className="terminal-pane-wrapper"
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      {isSearchOpen && searchAddonRef.current && (
        <TerminalSearch
          searchAddon={searchAddonRef.current}
          onClose={closeSearch}
          initialQuery={termRef.current?.getSelection() || ""}
        />
      )}
      <div ref={containerRef} className="terminal-pane" />
    </div>
  );
}
