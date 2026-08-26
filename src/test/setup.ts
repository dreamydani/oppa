import React from "react";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Module-init subscriptions call listen() at import time even in suites that
// never mock the pty transport; outside a webview that throws synchronously,
// so default every suite to a resolving no-op listener.
vi.mock("@tauri-apps/api/event", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/event")>();
  return {
    ...actual,
    listen: vi.fn().mockResolvedValue(() => {}),
  };
});

// Mock @monaco-editor/react for fast and deterministic DOM unit testing
vi.mock("@monaco-editor/react", () => {
  return {
    __esModule: true,
    default: ({ value, language, theme, onChange, onMount, options }: any) => {
      React.useEffect(() => {
        if (onMount) {
          onMount(
            {
              addCommand: vi.fn(),
            },
            {
              KeyMod: { CtrlCmd: 2048 },
              KeyCode: { KeyS: 49 },
            },
          );
        }
      }, [onMount]);

      return React.createElement(
        "div",
        {
          "data-testid": "monaco-editor-mock",
          "data-language": language,
          "data-theme": theme,
          "data-word-wrap": options?.wordWrap,
        },
        React.createElement("textarea", {
          "aria-label": "Code Editor",
          value: value ?? "",
          readOnly: options?.readOnly,
          wrap: options?.wordWrap === "on" ? "soft" : "off",
          "data-word-wrap": options?.wordWrap,
          onChange: (e: any) => onChange && onChange(e.target.value),
        }),
      );
    },
    DiffEditor: ({ original, modified, language, theme, options }: any) => {
      return React.createElement(
        "div",
        {
          "data-testid": "monaco-diff-mock",
          "data-language": language,
          "data-theme": theme,
          "data-side-by-side": options?.renderSideBySide ? "true" : "false",
        },
        React.createElement("div", { "data-testid": "diff-original" }, original),
        React.createElement("div", { "data-testid": "diff-modified" }, modified),
      );
    },
  };
});

// Local-Monaco wiring (localMonaco.ts) must never pull the real package or
// spin real workers inside vitest: stub the package, the loader, and the
// single worker-boundary module.
vi.mock("monaco-editor", () => ({
  __esModule: true,
  default: {},
  Environment: {},
  languages: {},
  editor: {},
}));
vi.mock("@monaco-editor/loader", () => ({
  __esModule: true,
  default: { config: vi.fn() },
}));
vi.mock("../lib/monaco/monacoWorkers", () => ({
  __esModule: true,
  editorWorker: class MockWorker {},
  jsonWorker: class MockWorker {},
  cssWorker: class MockWorker {},
  htmlWorker: class MockWorker {},
  tsWorker: class MockWorker {},
}));

afterEach(() => {
  cleanup();
});
