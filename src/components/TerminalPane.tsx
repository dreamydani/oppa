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
import type { Path } from "../store/terminalStore";
import { focus } from "../lib/pane-manager/layout";
import { getTerminalTheme } from "../lib/theme/terminalThemes";
import { TerminalSearch } from "./TerminalSearch";
import { TerminalPaneHeader } from "./TerminalPaneHeader";
import "./TerminalPane.css";

// Renders the terminal view for ONE store session with WebGL acceleration,
// Unicode 11 width calculation, clickable web links, and in-pane search overlay.
export function TerminalPane({ id, path }: { id: string; path?: Path }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const isSearchOpenRef = useRef(false);
  isSearchOpenRef.current = isSearchOpen;

  const idRef = useRef(id);
  const parsedRef = useRef(0);

  const status = useTerminalStore((s) => s.sessions[id]?.status);
  const session = useTerminalStore((s) => s.sessions[id]);
  const appearance = useTerminalStore((s) => s.settings.appearance);
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;

  const layout = useTerminalStore((s) => s.layout);
  const focusedPath = useTerminalStore((s) => s.focusedPath);
  const isFocused = path !== undefined
    ? path.join(".") === (focusedPath ?? []).join(".")
    : (layout ? focus(layout, focusedPath ?? []) === id : false);
  const ackSession = useTerminalStore((s) => s.ackSession);
  const resizeSession = useTerminalStore((s) => s.resizeSession);
  const registerSerializer = useTerminalStore((s) => s.registerSerializer);
  const unregisterSerializer = useTerminalStore((s) => s.unregisterSerializer);
  const clearRestoredScrollback = useTerminalStore((s) => s.clearRestoredScrollback);
  const dismissSessionRestoredBanner = useTerminalStore((s) => s.dismissSessionRestoredBanner);

  const handleLinkClick = useCallback((_event: MouseEvent, uri: string) => {
    openUrl(uri).catch(() => {
      window.open(uri, "_blank", "noopener,noreferrer");
    });
  }, []);

  const handleClear = useCallback(() => {
    termRef.current?.clear();
    useTerminalStore.getState().cacheScrollback(id, "");
    void saveScrollback(id, "").catch(() => {});
  }, [id]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!status || status !== "running") return;

    idRef.current = id;
    const currentAppearance = appearanceRef.current;
    const term = new Terminal({
      cursorBlink: currentAppearance.cursorBlink,
      cursorStyle: currentAppearance.cursorStyle,
      fontSize: currentAppearance.fontSize,
      fontFamily: currentAppearance.fontFamily,
      lineHeight: currentAppearance.lineHeight,
      scrollback: 10000,
      smoothScrollDuration: 0,
      altClickMovesCursor: true,
      theme: getTerminalTheme(currentAppearance.themeName),
      allowProposedApi: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitAddonRef.current = fit;
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

    const state = useTerminalStore.getState();
    const restoredScrollback = state.restoredScrollbacks[id];
    const cachedScrollback = state.cachedScrollbacks[id];
    if (restoredScrollback) {
      term.write(restoredScrollback);
      term.writeln("\r\n\x1b[2m── [Session Restored] ──────────────────────────────────────\x1b[0m\r\n");
      clearRestoredScrollback(id);
    } else if (cachedScrollback) {
      term.write(cachedScrollback);
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

    // Custom wheel handler:
    // When running full-screen interactive CLI apps (opencode, claude, gemini, less, vim, etc.)
    // in alternate screen buffer without mouse tracking, translate wheel up/down into
    // cursor arrow key escape sequences so scrolling works smoothly.
    let wheelDeltaAccumulator = 0;
    term.attachCustomWheelEventHandler((event: WheelEvent) => {
      // If mouse reporting mode is active, allow xterm's mouse event reporter to handle it
      if (term.modes.mouseTrackingMode !== "none") {
        return true;
      }

      // If in alternate buffer mode (full-screen CLI / TUI), translate wheel to Arrow keys
      if (term.buffer.active.type === "alternate") {
        if (event.deltaY === 0) return true;
        const isUp = event.deltaY < 0;
        const code = term.modes.applicationCursorKeysMode
          ? (isUp ? "\x1bOA" : "\x1bOB")
          : (isUp ? "\x1b[A" : "\x1b[B");

        const delta = Math.abs(event.deltaY);
        let lines = 1;
        if (event.deltaMode === 1) {
          // Line mode
          lines = Math.max(1, Math.min(5, Math.round(delta)));
        } else if (event.deltaMode === 2) {
          // Page mode
          lines = term.rows || 24;
        } else {
          // Pixel mode (trackpad / high-res wheel)
          wheelDeltaAccumulator += delta;
          const cellHeight = 16;
          lines = Math.floor(wheelDeltaAccumulator / cellHeight);
          if (lines >= 1) {
            wheelDeltaAccumulator %= cellHeight;
          } else {
            lines = 1;
            wheelDeltaAccumulator = 0;
          }
          lines = Math.min(5, Math.max(1, lines));
        }

        for (let i = 0; i < lines; i++) {
          ptyWrite(idRef.current, code);
        }
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

    term.onData((data) => {
      if (useTerminalStore.getState().sessions[idRef.current]?.isRestored) {
        dismissSessionRestoredBanner(idRef.current);
      }
      ptyWrite(idRef.current, data);
    });

    // Debounce PTY resize to avoid ConPTY prompt-redraw storms during drag
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const { cols, rows } = term;
        resizeSession(idRef.current, cols, rows);
      }, 100);
    });
    ro.observe(containerRef.current!);

    return () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      flushScrollback();
      unregisterSerializer(idRef.current);
      disposed = true;
      ro.disconnect();
      unsubs.forEach((u) => u());
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
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
    dismissSessionRestoredBanner,
  ]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const theme = getTerminalTheme(appearance.themeName);
    term.options.theme = theme;
    term.options.fontFamily = appearance.fontFamily;
    term.options.fontSize = appearance.fontSize;
    term.options.lineHeight = appearance.lineHeight;
    term.options.cursorStyle = appearance.cursorStyle;
    term.options.cursorBlink = appearance.cursorBlink;
    fitAddonRef.current?.fit();
  }, [appearance]);

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

  if (
    session.status === "loading" ||
    session.status === "restoring" ||
    session.status === "spawning"
  ) {
    return (
      <div
        className="terminal-pane-wrapper"
        style={{ position: "relative", width: "100%", height: "100%" }}
      >
        <TerminalPaneHeader id={id} path={path} onClear={handleClear} />
        <div className="terminal-loading-skeleton">
          <div className="terminal-loading-shimmer" />
          <div className="terminal-loading-content">
            <span className="terminal-loading-spinner" />
            <span className="terminal-loading-text">Session loading...</span>
            {(session.cwd || session.title) && (
              <span className="terminal-loading-subtext">
                {session.title || session.cwd}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="terminal-pane-wrapper"
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <TerminalPaneHeader id={id} path={path} onClear={handleClear} />
      {isSearchOpen && searchAddonRef.current && (
        <TerminalSearch
          searchAddon={searchAddonRef.current}
          onClose={closeSearch}
          initialQuery={termRef.current?.getSelection() || ""}
        />
      )}
      <div
        ref={containerRef}
        className={`terminal-pane${appearance.dimInactivePanes && !isFocused ? " dimmed" : ""}`}
      />
    </div>
  );
}
