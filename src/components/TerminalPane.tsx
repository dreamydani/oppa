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
  onPtyExit,
} from "../lib/pty/transport";
import { saveScrollback } from "../lib/layout/transport";
import { subscribePtyData } from "../lib/pty/dataMultiplexer";
import { AckCoalescer } from "../lib/pty/ackCoalescer";
import { onNextFrame } from "../lib/layout/frameScheduler";
import {
  acquireGlSlot,
  releaseGlSlot,
  touchGlSlot,
} from "../lib/terminal/webglRegistry";
import { useTerminalStore, markScrollbackDirty } from "../store/terminalStore";
import type { Path } from "../store/terminalStore";
import { focus } from "../lib/pane-manager/layout";
import { planFullBleed } from "../lib/terminal/fullBleedFit";
import {
  notifyResizeActivity,
  requestFit,
  onResizeStreamEnd,
} from "../lib/terminal/fitCoordinator";
import {
  beginResizeStream,
  updateResizeStream,
  endResizeStream,
  isResizeStreamActive,
} from "../lib/terminal/resizeStreamOverlay";
import {
  setFocusedPane,
  setHoveredPane,
  getPanePriority,
  getFocusedPane,
} from "../lib/terminal/panePriority";
import { createThrottledWriteQueue } from "../lib/terminal/writeQueue";
import { serializeScrollbackBounded, maybeWriteTruncationMarker, XTERM_SCROLLBACK_LINES } from "../lib/terminal/scrollbackBudget";
import { detectGpuTier, GpuTier } from "../lib/terminal/gpuTier";
import { prefersReducedMotion } from "../lib/motion/reducedMotion";
import {
  isLayoutAnimating,
  runWhenLayoutIdle,
} from "../lib/layout/layoutAnimationGate";
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
  // Set by the mount effect; focus changes upgrade the renderer via registry.
  const ensureWebglRef = useRef<(() => void) | null>(null);
  // Per-pane write throttle: focused writes are immediate, background panes
  // flush at the capped rate. Created in the mount effect.
  const writeQueueRef = useRef<ReturnType<typeof createThrottledWriteQueue> | null>(null);

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
      // 4px pairs with the symmetric 4px left pad in TerminalPane.css so the
      // grid sits centered with hairline gaps on both sides.
      overviewRuler: { width: 4 },
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

    registerSerializer(id, () => serializeScrollbackBounded(() => serialize.serialize()));

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

    // GPU renderer lifecycle under a process-wide context budget: every pane
    // loads WebGL at mount (registry downgrades LRU panes to Canvas — never
    // DOM — when a new pane needs a slot, and focus upgrades back). Renderer
    // swaps re-measure cell metrics, so each swap schedules a refit: the
    // stretch plan must match the renderer that will draw it.
    let activeRenderer: "webgl" | "canvas" | null = null;
    let webglAddon: WebglAddon | null = null;
    let canvasAddon: CanvasAddon | null = null;
    const refitAfterRendererSwap = () => {
      onNextFrame(() => {
        if (disposed) return;
        runWhenLayoutIdle(commitFit);
      });
    };
    const downgradeToCanvas = () => {
      if (disposed || activeRenderer !== "webgl") return;
      try {
        webglAddon?.dispose();
      } catch {}
      webglAddon = null;
      try {
        canvasAddon = new CanvasAddon();
        term.loadAddon(canvasAddon);
        activeRenderer = "canvas";
        refitAfterRendererSwap();
      } catch {}
    };
    const ensureWebgl = (): void => {
      if (disposed || activeRenderer === "webgl") return;
      const upgradedFromCanvas = activeRenderer === "canvas";
      acquireGlSlot(id, downgradeToCanvas);
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => {
          try {
            gl.dispose();
          } catch {}
          downgradeToCanvas();
        });
        if (upgradedFromCanvas) {
          try {
            canvasAddon?.dispose();
          } catch {}
          canvasAddon = null;
        }
        term.loadAddon(gl);
        webglAddon = gl;
        activeRenderer = "webgl";
        if (upgradedFromCanvas) {
          refitAfterRendererSwap();
        }
      } catch {
        // Already on Canvas (mount + focus both miss WebGL): creating another
        // would leak the loaded one — and its later dispose would rebuild the
        // DOM renderer off a dead linkifier (the same unmount crash).
        if (activeRenderer === "canvas") return;
        try {
          canvasAddon = new CanvasAddon();
          term.loadAddon(canvasAddon);
          activeRenderer = "canvas";
        } catch {}
      }
    };
    ensureWebglRef.current = ensureWebgl;
    // Mount-time load is mandatory: skipping it leaves unfocused panes on
    // the DOM renderer (different cell metrics, worse glyphs) until focus.
    ensureWebgl();

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

    // Startup quality settle: several transients land after the first fit
    // (root UI zoom applied by a parent effect, drawer geometry, font swap,
    // warm-reattach replay). Checkpoints revalidate the stretch plan until
    // things converge; each is a near-free no-op when nothing changed, and
    // they defer while a layout animation is in flight.
    for (const settleDelayMs of [150, 450, 900]) {
      const settleTimer = setTimeout(() => {
        if (disposed) return;
        runWhenLayoutIdle(commitFit);
      }, settleDelayMs);
      unsubs.push(() => clearTimeout(settleTimer));
    }

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

        // One IPC call for the whole burst instead of one per line.
        if (lines > 0) {
          ptyWrite(idRef.current, code.repeat(lines));
        }
        return false;
      }

      return true;
    });

    const flushScrollback = () => {
      const buffer = serializeScrollbackBounded(() =>
        serializeAddonRef.current?.serialize() ?? "",
      );
      if (buffer) {
        useTerminalStore.getState().cacheScrollback(idRef.current, buffer);
        void saveScrollback(idRef.current, buffer).catch(() => {});
      }
    };

    // Coalesce ACKs: xterm fires onWriteParsed per write batch; acking each
    // one floods the IPC channel. Frame-cadence flushes keep the daemon's
    // watermark math identical while cutting invoke count ~10x.
    const ackCoalescer = new AckCoalescer((bytes) => {
      void ackSession(idRef.current, bytes).catch(() => {});
    });

    term.onWriteParsed(() => {
      if (parsedRef.current > 0) {
        ackCoalescer.add(parsedRef.current);
        parsedRef.current = 0;
      }
    });

    // Routed through the shared multiplexer: one global listener dispatches
    // per session id (O(1)) instead of every pane filtering every event.
    const writeQueue = createThrottledWriteQueue(
      getPanePriority(id),
      (data) => {
        if (!disposed) term.write(data);
      },
      GpuTier[detectGpuTier()].backgroundFps,
    );
    writeQueueRef.current = writeQueue;
    let truncationMarked = false;
    unsubs.push(
      subscribePtyData(id, (p) => {
        if (disposed) return;
        parsedRef.current +=
          typeof p.bytes === "number" ? p.bytes : new TextEncoder().encode(p.data).length;
        // Cheap Set.add: the next layout save re-serializes this buffer only.
        markScrollbackDirty(id);
        // Once the buffer reaches the scrollback plateau (rows + cap), xterm
        // has started evicting the oldest lines — write a one-time marker so
        // that silent history drop is visible to the user.
        if (!truncationMarked) {
          truncationMarked = maybeWriteTruncationMarker(
            {
              bufferLength: term.buffer.active.length,
              write: (data) => writeQueue.push(data),
            },
            XTERM_SCROLLBACK_LINES + term.rows,
            truncationMarked,
          );
        }
        writeQueue.push(p.data);
      }),
    );

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
    // During a layout animation (drawer slide, etc.) container sizes change
    // every frame; defer so the grid commits exactly once after it ends.
    // Otherwise route through the shared coordinator: coalesced passes and
    // leading-edge/settle semantics for continuous resizes (drags).
    let fitDeferredWhileAnimating = false;
    let pendingFitCancel: (() => void) | null = null;
    // Freeze+stretch: while a resize stream is CONTINUING (a drag in
    // progress), pin the last-rendered frame and stretch it to fill rather
    // than reflow the grid every frame — the "flash" on resize. Discrete
    // resizes (fresh stream) commit normally; the settle fit is the crisp
    // swap, applied after the overlay comes off.
    const stretchOverlay = () => {
      // Reduced motion: skip the stretch and commit directly — a stale
      // scaled frame is more jarring than an instant reflow.
      if (prefersReducedMotion()) return;
      const el = term.element;
      if (!el) return;
      const parentEl = el.parentElement;
      if (!parentEl) return;
      const rect = parentEl.getBoundingClientRect();
      if (!isResizeStreamActive(idRef.current)) {
        beginResizeStream(idRef.current, el);
      }
      updateResizeStream(idRef.current, { width: rect.width, height: rect.height });
    };
    const scheduleStableFit = (): boolean => {
      const fresh = notifyResizeActivity();
      pendingFitCancel?.();
      pendingFitCancel = requestFit(id, runStableFit);
      return fresh;
    };
    const ro = new ResizeObserver(() => {
      if (!isLayoutAnimating()) {
        const fresh = scheduleStableFit();
        if (!fresh) stretchOverlay();
        return;
      }
      if (fitDeferredWhileAnimating) return;
      fitDeferredWhileAnimating = true;
      runWhenLayoutIdle(() => {
        fitDeferredWhileAnimating = false;
        if (!disposed) scheduleStableFit();
      });
    });
    ro.observe(containerRef.current!);
    commitFitRef.current = commitFit;

    // Stream settle removes the freeze+stretch overlay and commits the real
    // fit exactly once — the crisp swap that follows the stretch.
    const streamEndUnsub = onResizeStreamEnd(() => {
      if (disposed) return;
      endResizeStream(idRef.current);
      runWhenLayoutIdle(commitFit);
    });

    return () => {
      cancelAnimationFrame(stableRaf);
      cancelAnimationFrame(followUpRaf);
      pendingFitCancel?.();
      pendingFitCancel = null;
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      commitFitRef.current = null;
      flushScrollback();
      ackCoalescer.dispose();
      writeQueue.dispose();
      writeQueueRef.current = null;
      releaseGlSlot(idRef.current);
      ensureWebglRef.current = null;
      unregisterSerializer(idRef.current);
      streamEndUnsub();
      endResizeStream(idRef.current);
      disposed = true;
      ro.disconnect();
      unsubs.forEach((u) => u());
      // Renderer addons must go before term.dispose(): xterm clears the
      // linkifier first while renderer-addon disposal rebuilds the DOM
      // renderer off it — the reverse order throws "reading
      // 'onShowLinkUnderline'" on every pane close. Double-dispose is safe
      // (xterm's AddonManager skips already-disposed addons).
      try {
        webglAddon?.dispose();
      } catch {}
      webglAddon = null;
      try {
        canvasAddon?.dispose();
      } catch {}
      canvasAddon = null;
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

  // Focus drives the GL budget: refresh recency so this pane is never the
  // LRU victim while active, upgrade back to WebGL if it was downgraded, and
  // revalidate stretch+grid — a cheap no-op chain when healthy, a self-heal
  // when any input (renderer, geometry, font) went stale since the last fit.
  // It also drives the render-priority registry: the focused pane owns the
  // full frame budget, background panes render at the capped rate.
  useEffect(() => {
    // A pane losing focus clears its own registry entry only; another pane's
    // focus change owns the rest.
    const wasFocused = !isFocused && getFocusedPane() === id;
    setFocusedPane(isFocused ? id : wasFocused ? null : getFocusedPane());
    writeQueueRef.current?.setPriority(getPanePriority(id));
    if (!isFocused) return;
    touchGlSlot(id);
    ensureWebglRef.current?.();
    runWhenLayoutIdle(() => commitFitRef.current?.());
  }, [isFocused, id]);

  // Hover bump: pointerenter/leave on the pane surface raises a background
  // pane to full rate while the cursor is over it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onEnter = () => {
      setHoveredPane(id);
      writeQueueRef.current?.setPriority(getPanePriority(id));
    };
    const onLeave = () => {
      setHoveredPane(null);
      writeQueueRef.current?.setPriority(getPanePriority(id));
    };
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [id]);

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
