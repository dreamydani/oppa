import { describe, it, expect, vi } from "vitest";
import {
  mapToMonacoLanguage,
  defineOppaMonacoThemes,
  OPPA_DARK_THEME,
  OPPA_LIGHT_THEME,
} from "./monacoTheme";

describe("monacoTheme", () => {
  describe("mapToMonacoLanguage", () => {
    it("maps common web extensions properly", () => {
      expect(mapToMonacoLanguage("index.html")).toBe("html");
      expect(mapToMonacoLanguage("app.js")).toBe("javascript");
      expect(mapToMonacoLanguage("Component.tsx")).toBe("typescript");
      expect(mapToMonacoLanguage("styles.css")).toBe("css");
      expect(mapToMonacoLanguage("data.json")).toBe("json");
    });

    it("maps backend and systems languages properly", () => {
      expect(mapToMonacoLanguage("main.rs")).toBe("rust");
      expect(mapToMonacoLanguage("script.py")).toBe("python");
      expect(mapToMonacoLanguage("query.sql")).toBe("sql");
      expect(mapToMonacoLanguage("server.go")).toBe("go");
    });

    it("maps markdown and configs properly", () => {
      expect(mapToMonacoLanguage("README.md")).toBe("markdown");
      expect(mapToMonacoLanguage("config.yaml")).toBe("yaml");
      expect(mapToMonacoLanguage("Cargo.toml")).toBe("toml");
      expect(mapToMonacoLanguage("run.sh")).toBe("shell");
    });

    it("falls back to fallbackLang or plaintext when extension is unknown", () => {
      expect(mapToMonacoLanguage("notes.unknown", "custom-lang")).toBe("custom-lang");
      expect(mapToMonacoLanguage("file_without_ext")).toBe("plaintext");
    });
  });

  describe("defineOppaMonacoThemes", () => {
    it("registers oppa-dark and oppa-light with monaco.editor", () => {
      const defineTheme = vi.fn();
      const mockMonaco = {
        editor: {
          defineTheme,
        },
      };

      defineOppaMonacoThemes(mockMonaco);
      expect(defineTheme).toHaveBeenCalledWith(
        OPPA_DARK_THEME,
        expect.objectContaining({
          base: "vs-dark",
          colors: expect.objectContaining({
            "editor.background": "#141414",
          }),
        }),
      );
      expect(defineTheme).toHaveBeenCalledWith(
        OPPA_LIGHT_THEME,
        expect.objectContaining({
          base: "vs",
        }),
      );
    });

    it("handles undefined/null monaco gracefully without throwing", () => {
      expect(() => defineOppaMonacoThemes(null)).not.toThrow();
      expect(() => defineOppaMonacoThemes({})).not.toThrow();
    });
  });
});
