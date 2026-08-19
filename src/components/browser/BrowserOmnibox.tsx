import { useState, useEffect, useRef, type FormEvent, type ReactElement } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import type { BrowserSearchEngine } from "../../lib/settings/types";
import * as browserTransport from "../../lib/browser/transport";

export function normalizeUrl(
  input: string,
  searchEngine: BrowserSearchEngine = "duckduckgo",
): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // Pure digits: treat as localhost port (e.g. "5173" -> "http://localhost:5173")
  if (/^\d+$/.test(trimmed)) {
    return `http://localhost:${trimmed}`;
  }

  // Already has explicit protocol
  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed) || /^about:/i.test(trimmed)) {
    return trimmed;
  }

  // Localhost or loopback without protocol
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed) || /^127\.0\.0\.1(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  // Domain-like input (e.g. "github.com", "vitejs.dev/guide")
  if (/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  // Search engine fallback queries
  switch (searchEngine) {
    case "google":
      return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
    case "bing":
      return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`;
    case "duckduckgo":
    default:
      return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  }
}

export function BrowserOmnibox(): ReactElement {
  const browserUrl = useTerminalStore((s) => s.browserUrl);
  const browserHistory = useTerminalStore((s) => s.browserHistory);
  const historyIndex = useTerminalStore((s) => s.historyIndex);
  const navigateBrowser = useTerminalStore((s) => s.navigateBrowser);
  const storeGoBack = useTerminalStore((s) => s.browserGoBack);
  const storeGoForward = useTerminalStore((s) => s.browserGoForward);
  const storeReload = useTerminalStore((s) => s.browserReload);
  const searchEngine = useTerminalStore((s) => s.settings.general.browserSearchEngine);

  const [inputValue, setInputValue] = useState(browserUrl);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInputValue(browserUrl);
  }, [browserUrl]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < browserHistory.length - 1;

  const handleGoBack = () => {
    if (!canGoBack) return;
    storeGoBack();
    void browserTransport.browserGoBack();
  };

  const handleGoForward = () => {
    if (!canGoForward) return;
    storeGoForward();
    void browserTransport.browserGoForward();
  };

  const handleReload = () => {
    storeReload();
    void browserTransport.browserReload();
  };

  const handleHome = () => {
    navigateBrowser("");
    void browserTransport.browserNavigate("");
  };

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const targetUrl = normalizeUrl(inputValue, searchEngine);
    navigateBrowser(targetUrl);
    void browserTransport.browserNavigate(targetUrl);
  };

  const handleClear = () => {
    setInputValue("");
    inputRef.current?.focus();
  };

  const handleOpenExternal = () => {
    if (!browserUrl) return;
    window.open(browserUrl, "_blank");
  };

  const handleOpenDevTools = () => {
    void browserTransport.browserOpenDevTools();
  };

  const isSecure =
    browserUrl.startsWith("https:") ||
    browserUrl.startsWith("http://localhost") ||
    browserUrl.startsWith("http://127.0.0.1");

  const isInsecure = browserUrl.startsWith("http:") && !isSecure;

  return (
    <div className="browser-omnibox-bar">
      <div className="omnibox-nav-controls">
        <button
          type="button"
          className="omnibox-btn"
          title="Back"
          aria-label="Back"
          disabled={!canGoBack}
          onClick={handleGoBack}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>

        <button
          type="button"
          className="omnibox-btn"
          title="Forward"
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={handleGoForward}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>

        <button
          type="button"
          className="omnibox-btn"
          title="Reload"
          aria-label="Reload"
          onClick={handleReload}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
          </svg>
        </button>

        <button
          type="button"
          className="omnibox-btn"
          title="Home"
          aria-label="Home"
          onClick={handleHome}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </button>
      </div>

      <form className="omnibox-input-wrapper" onSubmit={handleSubmit}>
        <div className="omnibox-protocol-indicator">
          {isSecure ? (
            <span
              className="protocol-icon secure"
              data-testid="protocol-indicator-secure"
              title="Secure Connection / Localhost"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
          ) : isInsecure ? (
            <span
              className="protocol-icon insecure"
              data-testid="protocol-indicator-insecure"
              title="Insecure HTTP Connection"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </span>
          ) : (
            <span className="protocol-icon neutral" title="Search or enter URL">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
          )}
        </div>

        <input
          ref={inputRef}
          type="text"
          className="omnibox-input"
          value={inputValue}
          placeholder="Search or enter URL (e.g. 5173 or localhost:3000)"
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleSubmit();
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />

        {inputValue ? (
          <button
            type="button"
            className="omnibox-clear-btn"
            title="Clear"
            aria-label="Clear input"
            onClick={handleClear}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        ) : null}
      </form>

      <div className="omnibox-action-controls">
        <button
          type="button"
          className="omnibox-btn"
          title="Open in default browser"
          aria-label="Open in default browser"
          disabled={!browserUrl}
          onClick={handleOpenExternal}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>

        <button
          type="button"
          className="omnibox-btn"
          title="Toggle Developer Tools"
          aria-label="Toggle Developer Tools"
          onClick={handleOpenDevTools}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </div>
  );
}
