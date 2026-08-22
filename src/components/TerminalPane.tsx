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
import { planFullBleed } from "../lib/terminal/fullBleedFit";
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
  // Latest commitFit from the mount effect; shared fit paths outside it
  // (appearance changes) must go through the same full-bleed + PTY pipeline.
  const commitFitRef = useRef<(() => void) | null>(null);
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

  // Fit-rounding leftover strips (right/bottom of the grid) stay invisible
  // only while every wrapper layer carries the live session background —
  // including .pane-leaf so corners and the ruler band blend in.
  const paintSessionSurface = useCallback((css: string | undefined) => {
    const value = typeof css === "string" ? css : "";
    const container = containerRef.current;
    if (!container) return;
    container.style.setProperty("--session-term-bg", value);
    container.parentElement?.style.setProperty("--session-term-bg", value);
    container.closest<HTMLElement>(".pane-leaf")?.style.setProperty("--session-term-bg", value);
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!status || status !== "running") return;

    idRef.current = id;
    const currentAppearance = appearanceRef.current;
    const currentTheme = getTerminalTheme(currentAppearance.themeName);
    const term = new Terminal({
      cursorBlink: currentAppearance.cursorBlink,
      cursorStyle: currentAppearance.cursorStyle,
      fontSize: currentAppearance.fontSize,
      fontFamily: currentAppearance.fontFamily,
      lineHeight: currentAppearance.lineHeight,
      scrollback: 10000,
      smoothScrollDuration: 0,
      altClickMovesCursor: true,
      // Slim VS Code-style scrollbar: xterm's DOM slider reserves this width
      // (default 14) and overlays the canvas edge; FitAddon ignores it.
      overviewRuler: { width: 7 },
      theme: currentTheme,
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

    const unsubs: (() => void)[] = [];
    let disposed = false;

    // Debounce PTY resize to avoid ConPTY prompt-redraw storms during drag.
    // Duplicate suppression: mount/settle/appearance refits often land on the
    // same grid the daemon already has — only notify on real geometry changes.
    const resizeDebounceMs = 100;
    let lastSentCols = useTerminalStore.getState().sessions[id]?.cols ?? -1;
    let lastSentRows = useTerminalStore.getState().sessions[id]?.rows ?? -1;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const schedulePtyResize = () => {
      const { cols, rows } = term;
      if (cols === lastSentCols && rows === lastSentRows) return;
      // Coalesce without pushing the deadline back: the callback reads the
      // live grid at fire time, so later commits never need a fresh timer.
      if (resizeTimer) return;
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        resizeSession(idRef.current, term.cols, term.rows);
      }, resizeDebounceMs);
    };

    let followUpRaf = 0;

    // Pane budget measured the same way FitAddon sees it (parent content box
    // minus xterm padding minus the reserved scrollbar/ruler band).
    const readFitBudget = (): { widthCss: number; heightCss: number } | null => {
      const parentEl = term.element?.parentElement;
      if (!parentEl) return null;
      const rect = parentEl.getBoundingClientRect();
      let widthCss = rect.width;
      let heightCss = rect.height;
      if (!(widthCss > 0) || !(heightCss > 0)) {
        const style = window.getComputedStyle(parentEl);
        widthCss = parseFloat(style.getPropertyValue("width"));
        heightCss = parseFloat(style.getPropertyValue("height"));
      }
      if (!(widthCss > 0) || !(heightCss > 0)) return null;

      const xtermStyle = term.element ? window.getComputedStyle(term.element) : null;
      const padHor = xtermStyle
        ? (parseInt(xtermStyle.paddingLeft) || 0) + (parseInt(xtermStyle.paddingRight) || 0)
        : 0;
      const padVer = xtermStyle
        ? (parseInt(xtermStyle.paddingTop) || 0) + (parseInt(xtermStyle.paddingBottom) || 0)
        : 0;
      const rulerWidth =
        term.options.scrollback === 0 ? 0 : term.options.overviewRuler?.width || 14;
      return {
        widthCss: Math.max(0, widthCss - padHor - rulerWidth),
        heightCss: Math.max(0, heightCss - padVer),
      };
    };

    // Stretch-to-fill: nudge letterSpacing/lineHeight so cols*cellW and
    // rows*cellH consume the pane exactly — no right/bottom rounding gap.
    // Anchored to the CONFIGURED lineHeight so repeated plans never ratchet.
    const applyFullBleed = (): boolean => {
      try {
        const dpr = window.devicePixelRatio || 1;
        const cssDims = (
          term as unknown as {
            _core?: {
              _renderService?: {
                dimensions?: {
                  css?: {
                    char?: { width?: number; height?: number };
                    cell?: { width?: number; height?: number };
                  };
                };
              };
            };
          }
        )._core?._renderService?.dimensions?.css;
        if (!cssDims?.char?.width || !cssDims?.char?.height) return false;
        const budget = readFitBudget();
        if (!budget) return false;
        const plan = planFullBleed({
          availableWidthCss: budget.widthCss,
          availableHeightCss: budget.heightCss,
          devicePixelRatio: dpr,
          charWidthDevice: Math.round(cssDims.char.width * dpr),
          charHeightDevice: Math.round(cssDims.char.height * dpr),
          currentLetterSpacingPx:
            typeof term.options.letterSpacing === "number" ? term.options.letterSpacing : 0,
          currentLineHeight: appearanceRef.current.lineHeight,
        });
        const prevSpacing =
          typeof term.options.letterSpacing === "number" ? term.options.letterSpacing : 0;
        const prevLineHeight =
          typeof term.options.lineHeight === "number" ? term.options.lineHeight : 1;
        const changed =
          Math.abs(prevSpacing - plan.letterSpacingPx) > 1e-6 ||
          Math.abs(prevLineHeight - plan.lineHeight) > 1e-6;
        if (!changed) return false;
        term.options.letterSpacing = plan.letterSpacingPx;
        term.options.lineHeight = plan.lineHeight;
        // Renderer dimension recompute can trail the option write by a frame;
        // refit once more so cols/rows land on the stretched metrics.
        cancelAnimationFrame(followUpRaf);
        followUpRaf = requestAnimationFrame(() => {
          if (!disposed) commitFit();
        });
        return true;
      } catch {
        return false;
      }
    };

    // Single commit path for EVERY fit in this pane: stretch metrics first,
    // then fit the grid, then always tell the daemon (closes the desync holes
    // where settle/font/appearance fits never resized the PTY).
    const commitFit = () => {
      applyFullBleed();
      try {
        fit.fit();
      } catch {}
      schedulePtyResize();
    };

    // Fit before anything renders so cell metrics settle at the real
    // container size; attaching the GPU renderer before replay avoids the
    // canvas-fallback glyph mismatch seen on cold-restored panes.
    commitFit();

    const state = useTerminalStore.getState();
    const restoredScrollback = state.restoredScrollbacks[id];
    const cachedScrollback = state.cachedScrollbacks[id];

    // Pane surface adopts the active terminal theme's background so the
    // fit-rounding leftover below the last row is seamless (no two-tone gap).
    paintSessionSurface(currentTheme.background);

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

    if (restoredScrollback) {
      term.reset();
      term.write(restoredScrollback);
      clearRestoredScrollback(id);
    } else if (cachedScrollback) {
      term.write(cachedScrollback);
    }

    // Re-assert appearance + refit after replay: large writes land while
    // layout is still settling and can leave stale glyph metrics behind.
    term.options.fontSize = currentAppearance.fontSize;
    term.options.fontFamily = currentAppearance.fontFamily;
    term.options.lineHeight = currentAppearance.lineHeight;
    commitFit();

    // Font-metrics race fix: panes mounting during startup measure their cell
    // grid before the custom mono font has loaded, so glyphs render slightly
    // cramped/small inside fallback-sized cells. Once fonts are ready, swap
    // the metrics and refit — content is preserved, only measurements change.
    let fontSettleCancelled = false;
    // Guarded: test DOMs may lack the FontFaceSet API entirely
    document.fonts?.ready?.then(() => {
      if (fontSettleCancelled) return;
      term.options.fontSize = appearanceRef.current.fontSize;
      term.options.fontFamily = appearanceRef.current.fontFamily;
      commitFit();
    });
    unsubs.push(() => {
      fontSettleCancelled = true;
    });

    // Settle-time refit: App applies root UI zoom in a parent effect AFTER
    // this child effect runs, which shifts measured widths. A short delayed
    // refit absorbs that pass without dropping any PTY output.
    const settleTimer = setTimeout(() => {
      if (disposed) return;
      commitFit();
    }, 150);
    unsubs.push(() => clearTimeout(settleTimer));

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
    });

    onPtyData((p) => {
      if (disposed) return;
      if (p.id === idRef.current) {
        parsedRef.current += typeof p.bytes === "number" ? p.bytes : new TextEncoder().encode(p.data).length;
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

    // Stable-fit guard (Orca pattern): Windows can report a one-column gutter
    // wobble between frames, so commit a fit only after the proposed grid
    // repeats on consecutive frames (or hits the frame cap) — otherwise
    // split views vibrate with rapid SIGWINCH loops.
    let stableRaf = 0;
    const proposeGrid = (): { cols: number; rows: number } | null => {
      try {
        return fit.proposeDimensions() ?? null;
      } catch {
        return null;
      }
    };
    const runStableFit = () => {
      cancelAnimationFrame(stableRaf);
      let previous = proposeGrid();
      let frame = 0;
      const step = () => {
        if (disposed) return;
        const next = proposeGrid();
        if (!next) {
          commitFit();
          return;
        }
        const matchesTerminal = term.cols === next.cols && term.rows === next.rows;
        const stable =
          matchesTerminal ||
          ++frame >= 8 ||
          (!!previous && next.cols === previous.cols && next.rows === previous.rows);
        if (!stable) {
          previous = next;
          stableRaf = requestAnimationFrame(step);
          return;
        }
        const stretched = applyFullBleed();
        if (!matchesTerminal || stretched) fit.fit();
        schedulePtyResize();
      };
      step();
    };
    const ro = new ResizeObserver(runStableFit);
    ro.observe(containerRef.current!);
    commitFitRef.current = commitFit;

    return () => {
      cancelAnimationFrame(stableRaf);
      cancelAnimationFrame(followUpRaf);
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      commitFitRef.current = null;
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
    paintSessionSurface(theme.background);
    commitFitRef.current?.();
  }, [appearance, paintSessionSurface]);

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
    session.status === "spawning" ||
    session.status === "sleeping"
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
