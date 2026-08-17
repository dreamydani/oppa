# Rich xterm.js Addons & WebGL Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade OPPA's frontend terminal engine with WebGL GPU acceleration, context-loss fallback, Unicode 11 wide character width calculation, interactive WebLinks with Tauri opener, and an in-pane search bar overlay triggered by `Ctrl+F` / `Cmd+F`.

**Architecture:** Load `@xterm/addon-unicode11`, `@xterm/addon-web-links`, `@xterm/addon-search`, and `@xterm/addon-webgl` in `TerminalPane.tsx`. Create a lightweight floating `TerminalSearch.tsx` React overlay communicating with the pane's `SearchAddon`.

**Tech Stack:** React 19, TypeScript, xterm.js, `@xterm/addon-webgl`, `@xterm/addon-canvas`, `@xterm/addon-search`, `@xterm/addon-unicode11`, `@xterm/addon-web-links`, `@tauri-apps/plugin-opener`, Vitest, `@testing-library/react`.

## Global Constraints

- **Resilient Rendering**: WebGL context loss or initialization failures must never crash the terminal session; degrade cleanly to canvas or DOM.
- **TDD**: Write failing tests first, verify failure, implement, verify pass, and commit.
- **No Unused Code**: Clean, concise code following existing patterns in `src/components/`.

---

### Task 1: Add Dependencies & Implement `TerminalSearch.tsx`

**Files:**
- Modify: `package.json`
- Create: `src/components/TerminalSearch.tsx`
- Create: `src/components/TerminalSearch.test.tsx`

**Interfaces:**
- Produces: `export function TerminalSearch({ searchAddon, onClose, initialQuery }: TerminalSearchProps): React.ReactElement`
- Types: `interface TerminalSearchProps { searchAddon: SearchAddon; onClose: () => void; initialQuery?: string; }`

- [ ] **Step 1: Install required xterm addon packages**

Run: `pnpm add @xterm/addon-search @xterm/addon-unicode11 @xterm/addon-web-links @xterm/addon-canvas`

- [ ] **Step 2: Write failing unit test in `src/components/TerminalSearch.test.tsx`**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TerminalSearch } from "./TerminalSearch";
import type { SearchAddon } from "@xterm/addon-search";

describe("TerminalSearch", () => {
  const mockSearchAddon = {
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
  } as unknown as SearchAddon;

  it("renders search input and auto-focuses", () => {
    const onClose = vi.fn();
    render(<TerminalSearch searchAddon={mockSearchAddon} onClose={onClose} />);
    const input = screen.getByPlaceholderText("Find...");
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
  });

  it("calls findNext on input change and Enter", () => {
    const onClose = vi.fn();
    render(<TerminalSearch searchAddon={mockSearchAddon} onClose={onClose} />);
    const input = screen.getByPlaceholderText("Find...");
    fireEvent.change(input, { target: { value: "error" } });
    expect(mockSearchAddon.findNext).toHaveBeenCalledWith("error", { regex: false, caseSensitive: false });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSearchAddon.findNext).toHaveBeenCalledTimes(2);
  });

  it("calls findPrevious on Shift+Enter or Previous button", () => {
    const onClose = vi.fn();
    render(<TerminalSearch searchAddon={mockSearchAddon} onClose={onClose} initialQuery="test" />);
    const input = screen.getByPlaceholderText("Find...");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mockSearchAddon.findPrevious).toHaveBeenCalledWith("test", { regex: false, caseSensitive: false });
  });

  it("calls onClose on Escape key or Close button", () => {
    const onClose = vi.fn();
    render(<TerminalSearch searchAddon={mockSearchAddon} onClose={onClose} />);
    const input = screen.getByPlaceholderText("Find...");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/components/TerminalSearch.test.tsx`
Expected: FAIL (file not found)

- [ ] **Step 4: Implement `src/components/TerminalSearch.tsx`**

```tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import type { SearchAddon } from "@xterm/addon-search";

export interface TerminalSearchProps {
  searchAddon: SearchAddon;
  onClose: () => void;
  initialQuery?: string;
}

export function TerminalSearch({
  searchAddon,
  onClose,
  initialQuery = "",
}: TerminalSearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const executeSearch = useCallback(
    (direction: "next" | "prev", text: string, isCase: boolean, isRegex: boolean) => {
      if (!text) {
        searchAddon.clearDecorations?.();
        return;
      }
      const opts = { caseSensitive: isCase, regex: isRegex };
      if (direction === "next") {
        searchAddon.findNext(text, opts);
      } else {
        searchAddon.findPrevious(text, opts);
      }
    },
    [searchAddon]
  );

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newQuery = e.target.value;
    setQuery(newQuery);
    executeSearch("next", newQuery, caseSensitive, regex);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      executeSearch(e.shiftKey ? "prev" : "next", query, caseSensitive, regex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const toggleCase = () => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    executeSearch("next", query, next, regex);
  };

  const toggleRegex = () => {
    const next = !regex;
    setRegex(next);
    executeSearch("next", query, caseSensitive, next);
  };

  return (
    <div className="terminal-search-overlay" role="search">
      <input
        ref={inputRef}
        type="text"
        className="terminal-search-input"
        placeholder="Find..."
        value={query}
        onChange={handleQueryChange}
        onKeyDown={handleKeyDown}
        aria-label="Find in terminal"
      />
      <button
        type="button"
        className="terminal-search-btn"
        onClick={() => executeSearch("prev", query, caseSensitive, regex)}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        ▲
      </button>
      <button
        type="button"
        className="terminal-search-btn"
        onClick={() => executeSearch("next", query, caseSensitive, regex)}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        ▼
      </button>
      <button
        type="button"
        className={`terminal-search-btn ${caseSensitive ? "active" : ""}`}
        onClick={toggleCase}
        title="Match Case (Alt+C)"
        aria-label="Match Case"
      >
        Aa
      </button>
      <button
        type="button"
        className={`terminal-search-btn ${regex ? "active" : ""}`}
        onClick={toggleRegex}
        title="Use Regular Expression (Alt+R)"
        aria-label="Use Regular Expression"
      >
        .*
      </button>
      <button
        type="button"
        className="terminal-search-btn terminal-search-close"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close search"
      >
        ✕
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/components/TerminalSearch.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/components/TerminalSearch.tsx src/components/TerminalSearch.test.tsx
git commit -m "feat(ui): add TerminalSearch overlay component with xterm search integration"
```

---

### Task 2: Integrate WebGL, Unicode 11, WebLinks & Search into `TerminalPane.tsx`

**Files:**
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/components/TerminalPane.test.tsx`

**Interfaces:**
- Consumes: `@xterm/addon-webgl`, `@xterm/addon-canvas`, `@xterm/addon-unicode11`, `@xterm/addon-web-links`, `@xterm/addon-search`, `@tauri-apps/plugin-opener`
- Produces: WebGL hardware-accelerated terminal with Unicode 11 width sizing, clickable web links, and `Ctrl+F` search trigger

- [ ] **Step 1: Update `src/components/TerminalPane.tsx`**

```tsx
import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import {
  ptyWrite,
  onPtyData,
  onPtyExit,
} from "../lib/pty/transport";
import { useTerminalStore } from "../store/terminalStore";
import { TerminalSearch } from "./TerminalSearch";

export function TerminalPane({ id }: { id: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const idRef = useRef(id);
  const parsedRef = useRef(0);

  const status = useTerminalStore((s) => s.sessions[id]?.status);
  const session = useTerminalStore((s) => s.sessions[id]);
  const ackSession = useTerminalStore((s) => s.ackSession);
  const resizeSession = useTerminalStore((s) => s.resizeSession);

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
      theme: { background: "#0d1117" },
      allowProposedApi: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    const search = new SearchAddon();
    const webLinks = new WebLinksAddon(handleLinkClick);

    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.loadAddon(search);
    term.loadAddon(webLinks);
    searchAddonRef.current = search;

    term.open(containerRef.current!);

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

    // Attach keyboard shortcut for Ctrl+F / Cmd+F
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setIsSearchOpen(true);
        return false;
      }
      if (event.key === "Escape" && isSearchOpen) {
        event.preventDefault();
        closeSearch();
        return false;
      }
      return true;
    });

    term.onWriteParsed(() => {
      if (parsedRef.current > 0) {
        ackSession(idRef.current, parsedRef.current);
        parsedRef.current = 0;
      }
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
      disposed = true;
      ro.disconnect();
      unsubs.forEach((u) => u());
      term.dispose();
      termRef.current = null;
      searchAddonRef.current = null;
    };
  }, [id, status, ackSession, resizeSession, handleLinkClick, closeSearch]);

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
    <div className="terminal-pane-wrapper" style={{ position: "relative", width: "100%", height: "100%" }}>
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
```

- [ ] **Step 2: Update `src/components/TerminalPane.test.tsx` to verify new addons and search integration**

Run: `pnpm vitest run src/components/TerminalPane.test.tsx`

- [ ] **Step 3: Commit**

```bash
git add src/components/TerminalPane.tsx src/components/TerminalPane.test.tsx
git commit -m "feat(ui): load WebGL, Unicode11, WebLinks and search in TerminalPane"
```

---

### Task 3: CSS Styles & Full Project Verification

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Add search overlay styles in `src/App.css`**

```css
.terminal-pane-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.terminal-search-overlay {
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.terminal-search-input {
  background: #0d1117;
  border: 1px solid #30363d;
  color: #c9d1d9;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  outline: none;
  width: 160px;
}

.terminal-search-input:focus {
  border-color: #58a6ff;
}

.terminal-search-btn {
  background: transparent;
  border: none;
  color: #8b949e;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.terminal-search-btn:hover {
  background: #21262d;
  color: #c9d1d9;
}

.terminal-search-btn.active {
  background: #1f6feb33;
  color: #58a6ff;
  border: 1px solid #1f6feb;
}

.terminal-search-close:hover {
  color: #f85149;
}
```

- [ ] **Step 2: Run full verification suite**

Run:
1. `pnpm vitest run`
2. `pnpm build`
3. `cargo check` in `src-tauri`
4. `cargo test -p oppa --lib` in `src-tauri`

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "feat(ui): add styling for terminal search overlay"
```
