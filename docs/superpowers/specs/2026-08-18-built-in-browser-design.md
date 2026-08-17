# OPPA Built-in Developer Browser Design Specification

**Date:** 2026-08-18  
**Status:** Approved  
**Topic:** Built-in Developer Browser with Tauri 2 child webview, smart omnibox, device emulation toolbar, localhost auto-detection, and developer hub.

---

## 1. Overview & Goals

Integrate a built-in browser into OPPA designed specifically for developers:
1. **Full Viewport & Split Pane Modes**: Activate the `browser` tab in the top bar to switch into the full browser viewport, or split any terminal pane side-by-side with a live browser preview.
2. **Smart Omnibox**: Quick URL entry, port auto-expansion (`5173` -> `http://localhost:5173`), search fallback, Back/Forward/Reload navigation controls.
3. **Developer Quick-Launch Hub**: Default landing view showcasing running localhost dev servers, quick developer bookmarks (GitHub, Vercel, Tailwind Docs, MDN, DevDocs), and search.
4. **Device Emulation Toolbar**: One-click viewport switching between Responsive 100%, iPhone 15 Pro (393x852), iPad Air (820x1180), and Desktop (1280x800).
5. **Localhost & Port Auto-Detection**: PTY output parsing and status bar badges for live localhost servers.
6. **Architecture**: Tauri 2 child webview integration with coordinate tracking, modal auto-hiding, and DOM iframe fallback for test/dev environments.

---

## 2. Architecture & Data Flow

### A. Frontend Layer (React 19 & TypeScript)
- **Components**:
  - `src/components/browser/BrowserViewport.tsx`: Main browser wrapper handling layout, landing hub vs active URL, and device emulation container.
  - `src/components/browser/BrowserOmnibox.tsx`: Navigation buttons, URL input, lock indicator, and action buttons.
  - `src/components/browser/BrowserHub.tsx`: Developer landing view with active ports, bookmarks, and search.
  - `src/components/browser/DeviceToolbar.tsx`: Responsive device preset buttons.
- **Store Extensions (`src/store/terminalStore.ts`)**:
  - `activeAppMode: "terminal" | "browser"`
  - `browserUrl: string` (default `""` for hub screen)
  - `browserHistory: string[]`
  - `historyIndex: number`
  - `devicePreset: "responsive" | "iphone" | "ipad" | "desktop"`
  - `detectedPorts: Array<{ port: number; url: string; title: string; timestamp: number }>`
  - Actions: `setAppMode(mode)`, `setBrowserUrl(url)`, `navigateBrowser(url)`, `browserGoBack()`, `browserGoForward()`, `setDevicePreset(preset)`, `addDetectedPort(portInfo)`.

### B. Transport Layer (`src/lib/browser/transport.ts`)
- Wrapper for Tauri 2 invoke commands with web fallback:
  - `browserOpen(url, bounds)`
  - `browserNavigate(url)`
  - `browserSetBounds(bounds)`
  - `browserHide()` / `browserShow()`
  - `browserGoBack()` / `browserGoForward()` / `browserReload()`
  - `browserOpenDevTools()`

### C. Tauri 2 Backend Layer (`src-tauri/src/browser/`)
- `src-tauri/src/browser/manager.rs`: Webview lifecycle manager tracking the child webview instance on the main window.
- `src-tauri/src/browser/commands.rs`: Tauri IPC commands registered in `lib.rs`.

---

## 3. UI/UX Specification

### Top Bar & Switcher Interaction
- Clicking `browser` in the top bar switches `activeAppMode` to `"browser"`.
- The top bar active highlight moves to `browser`.
- Clicking `terminal` switches back to terminal mode.

### Omnibox Bar
- Height: `36px`, background: `var(--card, #222225)`, border-bottom: `1px solid var(--border)`.
- Left: Back (`←`), Forward (`→`), Reload (`↻`).
- Center: Omnibox input with lock icon (`🔒`), clear button (`✕`), and Enter submit.
- Right: Device preset buttons (Responsive, iPhone, iPad, Desktop), Open in Default Browser (`↗`), DevTools (`⚙`).

### Developer Landing Hub (Empty URL)
- Clean dark dashboard (`#18181b`):
  - Heading: "Developer Hub"
  - Active Dev Servers: Clickable cards for running localhost ports (e.g. `http://localhost:5173`).
  - Bookmarks Grid: Quick links for GitHub, Vercel, Tailwind CSS, MDN, DevDocs.
  - Search box.

---

## 4. Testing & Verification
- Unit tests for `BrowserViewport`, `BrowserOmnibox`, `BrowserHub`, `DeviceToolbar`, and store actions.
- Vitest suite `pnpm vitest run`.
- TypeScript build `pnpm build` and `cargo check`.
