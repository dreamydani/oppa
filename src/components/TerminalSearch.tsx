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
    <div
      className="terminal-search-overlay"
      role="search"
      data-motion="pop"
      data-state="open"
    >
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
