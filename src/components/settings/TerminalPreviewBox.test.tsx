import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TerminalPreviewBox } from "./TerminalPreviewBox";
import { getTerminalTheme } from "../../lib/theme/terminalThemes";

describe("TerminalPreviewBox", () => {
  it("renders sample prompt and color swatches with applied theme styles", () => {
    const theme = getTerminalTheme("dracula");
    render(
      <TerminalPreviewBox
        theme={theme}
        themeName="Dracula"
        fontFamily="Consolas"
        fontSize={14}
        lineHeight={1.2}
        cursorStyle="block"
        cursorBlink={true}
      />
    );

    const box = screen.getByTestId("terminal-preview-box");
    expect(box).toBeInTheDocument();
    expect(screen.getByText("terminal — Dracula")).toBeInTheDocument();
    expect(screen.getAllByText(/oppa/i).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText((_content, element) =>
        Boolean(element && element.tagName.toLowerCase() === "span" && /git:\(main\)/i.test(element.textContent ?? ""))
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/npm run build/i)).toBeInTheDocument();
    expect(screen.getByText(/1885 modules transformed/i)).toBeInTheDocument();

    // Check swatches
    const swatches = screen.getByTestId("preview-color-swatches");
    expect(swatches.children.length).toBe(8);
  });

  it("applies font family, font size, line height, background, and foreground styles", () => {
    const theme = getTerminalTheme("tokyo_night");
    render(
      <TerminalPreviewBox
        theme={theme}
        themeName="Tokyo Night"
        fontFamily="'JetBrains Mono', monospace"
        fontSize={16}
        lineHeight={1.4}
        cursorStyle="block"
        cursorBlink={false}
      />
    );

    const body = screen.getByTestId("terminal-preview-body");
    expect(body).toHaveStyle({
      backgroundColor: theme.background,
      color: theme.foreground,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: "16px",
      lineHeight: "1.4",
    });
  });

  it("renders different cursor styles: block, bar, underline", () => {
    const theme = getTerminalTheme("oppa_dark");
    const { rerender } = render(
      <TerminalPreviewBox
        theme={theme}
        themeName="OPPA Dark"
        fontFamily="monospace"
        fontSize={14}
        lineHeight={1.2}
        cursorStyle="block"
        cursorBlink={true}
      />
    );

    let cursor = screen.getByTestId("terminal-preview-cursor");
    expect(cursor).toHaveClass("cursor-block");
    expect(cursor).toHaveClass("cursor-blink");

    rerender(
      <TerminalPreviewBox
        theme={theme}
        themeName="OPPA Dark"
        fontFamily="monospace"
        fontSize={14}
        lineHeight={1.2}
        cursorStyle="bar"
        cursorBlink={false}
      />
    );
    cursor = screen.getByTestId("terminal-preview-cursor");
    expect(cursor).toHaveClass("cursor-bar");
    expect(cursor).not.toHaveClass("cursor-blink");

    rerender(
      <TerminalPreviewBox
        theme={theme}
        themeName="OPPA Dark"
        fontFamily="monospace"
        fontSize={14}
        lineHeight={1.2}
        cursorStyle="underline"
        cursorBlink={true}
      />
    );
    cursor = screen.getByTestId("terminal-preview-cursor");
    expect(cursor).toHaveClass("cursor-underline");
    expect(cursor).toHaveClass("cursor-blink");
  });

  it("renders 8 ANSI color swatches with theme colors", () => {
    const theme = getTerminalTheme("nord");
    render(
      <TerminalPreviewBox
        theme={theme}
        themeName="Nord"
        fontFamily="monospace"
        fontSize={14}
        lineHeight={1.2}
        cursorStyle="block"
        cursorBlink={true}
      />
    );

    const swatchItems = screen.getAllByTestId(/^preview-swatch-/);
    expect(swatchItems.length).toBe(8);
    expect(swatchItems[0]).toHaveStyle({ backgroundColor: theme.black });
    expect(swatchItems[1]).toHaveStyle({ backgroundColor: theme.red });
    expect(swatchItems[2]).toHaveStyle({ backgroundColor: theme.green });
    expect(swatchItems[3]).toHaveStyle({ backgroundColor: theme.yellow });
    expect(swatchItems[4]).toHaveStyle({ backgroundColor: theme.blue });
    expect(swatchItems[5]).toHaveStyle({ backgroundColor: theme.magenta });
    expect(swatchItems[6]).toHaveStyle({ backgroundColor: theme.cyan });
    expect(swatchItems[7]).toHaveStyle({ backgroundColor: theme.white });
  });
});
