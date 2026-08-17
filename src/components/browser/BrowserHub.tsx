import { useState, type FormEvent, type ReactElement } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { normalizeUrl } from "./BrowserOmnibox";
import * as browserTransport from "../../lib/browser/transport";

interface Bookmark {
  name: string;
  url: string;
  description: string;
  iconName: string;
}

const DEVELOPER_BOOKMARKS: Bookmark[] = [
  {
    name: "GitHub",
    url: "https://github.com",
    description: "Code hosting & collaboration",
    iconName: "github",
  },
  {
    name: "Vercel",
    url: "https://vercel.com",
    description: "Deploy web applications & APIs",
    iconName: "vercel",
  },
  {
    name: "Tailwind CSS",
    url: "https://tailwindcss.com",
    description: "Utility-first CSS framework",
    iconName: "tailwind",
  },
  {
    name: "MDN Web Docs",
    url: "https://developer.mozilla.org",
    description: "Web standards & JavaScript reference",
    iconName: "mdn",
  },
  {
    name: "DevDocs",
    url: "https://devdocs.io",
    description: "Fast, searchable API documentation",
    iconName: "devdocs",
  },
];

function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function BrowserHub(): ReactElement {
  const detectedPorts = useTerminalStore((s) => s.detectedPorts);
  const navigateBrowser = useTerminalStore((s) => s.navigateBrowser);
  const [searchInput, setSearchInput] = useState("");

  const handleNavigate = (url: string) => {
    const target = normalizeUrl(url);
    if (target) {
      navigateBrowser(target);
      void browserTransport.browserNavigate(target);
    }
  };

  const handleSearchSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    if (searchInput.trim()) {
      handleNavigate(searchInput);
    }
  };

  return (
    <div className="browser-hub-container">
      <div className="browser-hub-hero">
        <div className="hub-badge">
          <span className="hub-badge-dot" />
          <span>Built-in Browser</span>
        </div>
        <h1 className="browser-hub-title">Developer Hub</h1>
        <p className="browser-hub-tagline">Quick-launch dev servers and documentation</p>

        <form className="hub-search-form" onSubmit={handleSearchSubmit}>
          <div className="hub-search-input-wrapper">
            <span className="hub-search-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="text"
              className="hub-search-input"
              value={searchInput}
              placeholder="Search or enter URL (e.g. 5173 or localhost:3000)"
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSearchSubmit();
                }
              }}
              autoFocus
            />
            <button type="submit" className="hub-search-btn">
              Go
            </button>
          </div>
        </form>
      </div>

      <div className="browser-hub-sections">
        {/* Active Local Servers */}
        <section className="hub-section">
          <div className="hub-section-header">
            <h2 className="hub-section-title">Active Local Servers</h2>
            {detectedPorts.length > 0 && (
              <span className="hub-count-badge">{detectedPorts.length} detected</span>
            )}
          </div>

          {detectedPorts.length > 0 ? (
            <div className="hub-server-grid">
              {detectedPorts.map((item) => (
                <button
                  key={`${item.port}-${item.timestamp}`}
                  type="button"
                  className="hub-server-card"
                  onClick={() => handleNavigate(item.url)}
                >
                  <div className="server-card-top">
                    <div className="server-status-indicator">
                      <span className="pulse-dot" />
                      <span className="server-port-tag">:{item.port}</span>
                    </div>
                    <span className="server-timestamp">{formatTimeAgo(item.timestamp)}</span>
                  </div>
                  <div className="server-title">{item.title}</div>
                  <div className="server-url">{item.url}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="hub-empty-state">
              <div className="hub-empty-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              </div>
              <p className="hub-empty-text">
                Run your dev server in the terminal (e.g. pnpm dev) to see it here automatically.
              </p>
            </div>
          )}
        </section>

        {/* Quick Developer Bookmarks */}
        <section className="hub-section">
          <div className="hub-section-header">
            <h2 className="hub-section-title">Quick Bookmarks</h2>
          </div>

          <div className="hub-bookmark-grid">
            {DEVELOPER_BOOKMARKS.map((bookmark) => (
              <button
                key={bookmark.name}
                type="button"
                className="hub-bookmark-card"
                onClick={() => handleNavigate(bookmark.url)}
              >
                <div className="bookmark-card-top">
                  <span className="bookmark-name">{bookmark.name}</span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="bookmark-arrow"
                  >
                    <path d="M7 17L17 7M17 7H7M17 7V17" />
                  </svg>
                </div>
                <p className="bookmark-description">{bookmark.description}</p>
                <span className="bookmark-url">{bookmark.url}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
