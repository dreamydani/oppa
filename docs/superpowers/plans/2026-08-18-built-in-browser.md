# OPPA Built-in Developer Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a built-in developer browser in OPPA with smart omnibox, device emulation toolbar, localhost dev-server auto-detection, developer hub start screen, top bar mode switching, and Tauri 2 webview backend.

**Architecture:** Extend `terminalStore.ts` with browser state and PTY localhost port detection. Create modular browser components in `src/components/browser/` (Omnibox, Hub, DeviceToolbar, BrowserViewport). Integrate with `TitleBar.tsx`, `App.tsx`, `TerminalPaneHeader.tsx`, and `StatusBar.tsx`. Implement Tauri 2 IPC commands in Rust (`src-tauri/src/browser/`).

**Tech Stack:** React 19, TypeScript, Tauri 2 (Rust), CSS, Vitest, `@testing-library/react`.

## Global Constraints

- **Theme Palette**: Obsidian `#000000` / `#09090b` topbar and footer, dark neutral `#18181b` / `#1c1c1f` content surfaces, card `#222225`, text `#ededec` / `#71717a`.
- **Top Bar Integration**: `browser` and `terminal` tabs in `TitleBar.tsx` switch `activeAppMode` with smooth visual active highlights.
- **Smart Omnibox**: Port shortcut expansion (e.g. `5173` -> `http://localhost:5173`), search fallback, navigation controls.
- **Testing**: TDD with `pnpm vitest run` and `cargo test -p oppa --lib`.

---

### Task 1: Store & Transport Layer for Browser State and Localhost Port Detection

**Files:**
- Create: `src/lib/browser/transport.ts`
- Create: `src/lib/browser/transport.test.ts`
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: PTY data events, Tauri 2 invoke APIs.
- Produces: `activeAppMode`, `browserUrl`, `browserHistory`, `historyIndex`, `devicePreset`, `detectedPorts`, and browser actions in `terminalStore.ts`.

- [ ] **Step 1: Write failing tests for browser store state and port detection**

In `src/store/terminalStore.test.ts`:
```ts
describe("Browser store state", () => {
  it("initializes activeAppMode to terminal and provides browser navigation actions", () => {
    const { activeAppMode, setAppMode, navigateBrowser, browserUrl, browserGoBack, browserGoForward } =
      useTerminalStore.getState();
    expect(activeAppMode).toBe("terminal");
    expect(browserUrl).toBe("");

    setAppMode("browser");
    expect(useTerminalStore.getState().activeAppMode).toBe("browser");

    navigateBrowser("http://localhost:5173");
    expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");
    expect(useTerminalStore.getState().browserHistory).toContain("http://localhost:5173");

    navigateBrowser("https://github.com");
    expect(useTerminalStore.getState().browserUrl).toBe("https://github.com");

    browserGoBack();
    expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");

    browserGoForward();
    expect(useTerminalStore.getState().browserUrl).toBe("https://github.com");
  });

  it("handles device presets (responsive, iphone, ipad, desktop)", () => {
    const { setDevicePreset } = useTerminalStore.getState();
    setDevicePreset("iphone");
    expect(useTerminalStore.getState().devicePreset).toBe("iphone");
    setDevicePreset("ipad");
    expect(useTerminalStore.getState().devicePreset).toBe("ipad");
  });

  it("tracks detected localhost ports from terminal output", () => {
    const { addDetectedPort, detectedPorts } = useTerminalStore.getState();
    addDetectedPort({ port: 5173, url: "http://localhost:5173", title: "Vite Dev Server", timestamp: Date.now() });
    expect(useTerminalStore.getState().detectedPorts.length).toBeGreaterThan(0);
    expect(useTerminalStore.getState().detectedPorts[0].port).toBe(5173);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement `src/lib/browser/transport.ts` and update `src/store/terminalStore.ts`**

Create `src/lib/browser/transport.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function browserOpen(url: string, bounds: BrowserBounds): Promise<void> {
  try {
    await invoke("browser_open", { url, ...bounds });
  } catch {
    // Non-Tauri fallback
  }
}

export async function browserNavigate(url: string): Promise<void> {
  try {
    await invoke("browser_navigate", { url });
  } catch {}
}

export async function browserSetBounds(bounds: BrowserBounds): Promise<void> {
  try {
    await invoke("browser_set_bounds", bounds);
  } catch {}
}

export async function browserHide(): Promise<void> {
  try {
    await invoke("browser_hide");
  } catch {}
}

export async function browserShow(): Promise<void> {
  try {
    await invoke("browser_show");
  } catch {}
}

export async function browserGoBack(): Promise<void> {
  try {
    await invoke("browser_go_back");
  } catch {}
}

export async function browserGoForward(): Promise<void> {
  try {
    await invoke("browser_go_forward");
  } catch {}
}

export async function browserReload(): Promise<void> {
  try {
    await invoke("browser_reload");
  } catch {}
}

export async function browserOpenDevTools(): Promise<void> {
  try {
    await invoke("browser_open_devtools");
  } catch {}
}
```

In `src/store/terminalStore.ts`, add browser state fields, navigation actions, and auto-port detection helper.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/store/terminalStore.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/browser/ src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat(browser): add browser store state, actions, and transport layer"
```

---

### Task 2: Browser Frontend Components (Omnibox, Hub, Device Toolbar & Viewport)

**Files:**
- Create: `src/components/browser/BrowserOmnibox.tsx`
- Create: `src/components/browser/BrowserHub.tsx`
- Create: `src/components/browser/DeviceToolbar.tsx`
- Create: `src/components/browser/BrowserViewport.tsx`
- Create: `src/components/browser/BrowserViewport.css`
- Create: `src/components/browser/BrowserOmnibox.test.tsx`
- Create: `src/components/browser/BrowserHub.test.tsx`
- Create: `src/components/browser/BrowserViewport.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore`, `browserNavigate`, `browserOpenDevTools`.
- Produces: `BrowserViewport` component.

- [ ] **Step 1: Write failing tests for BrowserOmnibox, BrowserHub, and BrowserViewport**

In `src/components/browser/BrowserOmnibox.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BrowserOmnibox } from "./BrowserOmnibox";
import { useTerminalStore } from "../../store/terminalStore";

describe("BrowserOmnibox", () => {
  it("renders navigation controls, URL input, and action buttons", () => {
    render(<BrowserOmnibox />);
    expect(screen.getByLabelText("Back")).toBeDefined();
    expect(screen.getByLabelText("Forward")).toBeDefined();
    expect(screen.getByLabelText("Reload")).toBeDefined();
    expect(screen.getByPlaceholderText(/search or enter url/i)).toBeDefined();
  });

  it("submits URL on Enter and expands port shortcuts", () => {
    render(<BrowserOmnibox />);
    const input = screen.getByPlaceholderText(/search or enter url/i);
    fireEvent.change(input, { target: { value: "5173" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/browser/`  
Expected: FAIL

- [ ] **Step 3: Implement browser components and styling**

Implement:
- `BrowserOmnibox.tsx`: Navigation controls, smart URL input (expanding `3000` -> `http://localhost:3000`), clear button, device presets, devtools toggle.
- `BrowserHub.tsx`: Dark developer hub start page with active localhost dev server cards, bookmarks (GitHub, Vercel, Tailwind, MDN, DevDocs), and search query handler.
- `DeviceToolbar.tsx`: Device preset selector (Responsive 100%, iPhone 393px, iPad 820px, Desktop 1280px).
- `BrowserViewport.tsx`: Coordinates tracking, device emulation framing, iframe / webview render area.
- `BrowserViewport.css`: Clean minimalist styling matching `--workspace-bg` and `--card`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/browser/`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/browser/
git commit -m "feat(browser): add BrowserViewport, Omnibox, Developer Hub, and Device Toolbar"
```

---

### Task 3: Top Bar Mode Switcher Activation & App Layout Integration

**Files:**
- Modify: `src/components/TitleBar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`
- Modify: `src/components/TitleBar.test.tsx`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore` (`activeAppMode`, `setAppMode`).
- Produces: Interactive top bar mode switching between Terminal and Browser workbenches.

- [ ] **Step 1: Write failing tests for mode switcher interactivity**

In `src/components/TitleBar.test.tsx`:
```tsx
it("toggles active mode when clicking browser and terminal tabs", () => {
  render(<TitleBar />);
  const browserTab = screen.getByText("browser");
  fireEvent.click(browserTab);
  expect(useTerminalStore.getState().activeAppMode).toBe("browser");

  const terminalTab = screen.getByText("terminal");
  fireEvent.click(terminalTab);
  expect(useTerminalStore.getState().activeAppMode).toBe("terminal");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/TitleBar.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Update `TitleBar.tsx` and `App.tsx`**

In `src/components/TitleBar.tsx`:
Make `browser` and `terminal` tabs clickable buttons calling `setAppMode("browser")` / `setAppMode("terminal")`, dynamically applying the `.active` class to whichever mode is active.

In `src/App.tsx`:
Render `<BrowserViewport />` when `activeAppMode === "browser"`, and the terminal pane grid / setup wizard when `activeAppMode === "terminal"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/TitleBar.test.tsx src/App.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TitleBar.tsx src/App.tsx src/App.css src/components/TitleBar.test.tsx src/App.test.tsx
git commit -m "feat(layout): connect TitleBar mode switcher and mount BrowserViewport in App"
```

---

### Task 4: Terminal Split-with-Browser & Localhost Status Bar Badges

**Files:**
- Modify: `src/components/TerminalPaneHeader.tsx`
- Modify: `src/components/layout/StatusBar.tsx`
- Modify: `src/components/layout/StatusBar.css`
- Test: `src/components/TerminalPaneHeader.test.tsx`
- Test: `src/components/layout/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore` (`detectedPorts`, `navigateBrowser`, `setAppMode`).
- Produces: "Split with Browser" action in terminal pane menu and live localhost badges in status bar.

- [ ] **Step 1: Write failing tests for TerminalPaneHeader and StatusBar badges**

In `src/components/layout/StatusBar.test.tsx`:
```tsx
it("renders live localhost badges when active ports are detected", () => {
  useTerminalStore.setState({
    detectedPorts: [{ port: 5173, url: "http://localhost:5173", title: "Vite", timestamp: Date.now() }],
  });
  render(<StatusBar />);
  expect(screen.getByText(/5173/)).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/layout/StatusBar.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement "Split with Browser" in pane header and status bar port badge**

Update `TerminalPaneHeader.tsx`:
Add "Open Browser" / "Split with Browser" to the `...` menu.

Update `StatusBar.tsx`:
Display detected ports with live indicator `⚡ localhost:5173`, clicking it navigates to `http://localhost:5173` and switches to browser view.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/TerminalPaneHeader.test.tsx src/components/layout/StatusBar.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalPaneHeader.tsx src/components/layout/StatusBar.tsx src/components/layout/StatusBar.css src/components/layout/StatusBar.test.tsx src/components/TerminalPaneHeader.test.tsx
git commit -m "feat(browser): add split-with-browser pane menu and live localhost status badges"
```

---

### Task 5: Tauri 2 Backend Browser Commands (Rust) & Final Verification

**Files:**
- Create: `src-tauri/src/browser/mod.rs`
- Create: `src-tauri/src/browser/commands.rs`
- Create: `src-tauri/src/browser/manager.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `cargo test -p oppa --lib`
- Test: `pnpm vitest run`

- [ ] **Step 1: Implement Rust browser commands and register in `src-tauri/src/lib.rs`**

Create `src-tauri/src/browser/` with commands:
- `browser_open`, `browser_navigate`, `browser_set_bounds`, `browser_hide`, `browser_show`, `browser_go_back`, `browser_go_forward`, `browser_reload`, `browser_open_devtools`.

- [ ] **Step 2: Run Rust cargo check and cargo test**

Run: `cargo test -p oppa --lib --manifest-path src-tauri/Cargo.toml`  
Expected: PASS

- [ ] **Step 3: Run full Vitest suite and production build**

Run: `pnpm vitest run && pnpm build`  
Expected: PASS with 0 errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/
git commit -m "feat(rust): add Tauri 2 child webview browser commands and manager"
```
