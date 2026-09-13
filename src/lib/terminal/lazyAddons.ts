// Dynamic-import accessors for the xterm addons that don't pay for
// themselves before first paint: the initial bundle ships xterm core + Fit +
// Unicode11 only, and these chunks load on demand (search on first Ctrl+F,
// serialize on first flush, renderers on first paint). Static imports of
// these five addons were ~40% of the terminal chunk.
import type { SearchAddon } from "@xterm/addon-search";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { CanvasAddon } from "@xterm/addon-canvas";

export type { SearchAddon, SerializeAddon, WebLinksAddon, WebglAddon, CanvasAddon };

// Per-process ctor caches: one module evaluation, N panes. The once() wrapper
// dedupes concurrent loads so N panes share one chunk fetch.
export function loadSearchAddonCtor(): Promise<typeof SearchAddon> {
  searchCache ??= import("@xterm/addon-search").then((m) => m.SearchAddon);
  return searchCache;
}

let searchCache: Promise<typeof SearchAddon> | null = null;

export function loadSerializeAddonCtor(): Promise<typeof SerializeAddon> {
  serializeCache ??= import("@xterm/addon-serialize").then((m) => m.SerializeAddon);
  return serializeCache;
}

let serializeCache: Promise<typeof SerializeAddon> | null = null;

export function loadWebLinksAddonCtor(): Promise<typeof WebLinksAddon> {
  webLinksCache ??= import("@xterm/addon-web-links").then((m) => m.WebLinksAddon);
  return webLinksCache;
}

let webLinksCache: Promise<typeof WebLinksAddon> | null = null;

export function loadWebglAddonCtor(): Promise<typeof WebglAddon> {
  webglCache ??= import("@xterm/addon-webgl").then((m) => m.WebglAddon);
  return webglCache;
}

let webglCache: Promise<typeof WebglAddon> | null = null;

export function loadCanvasAddonCtor(): Promise<typeof CanvasAddon> {
  canvasCache ??= import("@xterm/addon-canvas").then((m) => m.CanvasAddon);
  return canvasCache;
}

let canvasCache: Promise<typeof CanvasAddon> | null = null;

// Test seam: drop the ctor caches between tests.
export function resetLazyAddonCachesForTests(): void {
  searchCache = null;
  serializeCache = null;
  webLinksCache = null;
  webglCache = null;
  canvasCache = null;
}