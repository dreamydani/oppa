import type { FC } from "react";
import type { ITheme } from "@xterm/xterm";
import type { TerminalCursorStyle } from "../../lib/settings/types";
import "./TerminalPreviewBox.css";

export interface TerminalPreviewBoxProps {
  theme: ITheme;
  themeName: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline" | TerminalCursorStyle;
  cursorBlink: boolean;
}

interface SwatchDef {
  name: string;
  color?: string;
}

export const TerminalPreviewBox: FC<TerminalPreviewBoxProps> = ({
  theme,
  themeName,
  fontFamily,
  fontSize,
  lineHeight,
  cursorStyle,
  cursorBlink,
}) => {
  const swatches: SwatchDef[] = [
    { name: "black", color: theme.black },
    { name: "red", color: theme.red },
    { name: "green", color: theme.green },
    { name: "yellow", color: theme.yellow },
    { name: "blue", color: theme.blue },
    { name: "magenta", color: theme.magenta },
    { name: "cyan", color: theme.cyan },
    { name: "white", color: theme.white },
  ];

  const cursorColor = theme.cursor ?? theme.foreground ?? "#ffffff";

  return (
    <div className="terminal-preview-box" data-testid="terminal-preview-box">
      <div className="terminal-preview-header">
        <div className="terminal-preview-dots">
          <span className="preview-dot dot-red" />
          <span className="preview-dot dot-yellow" />
          <span className="preview-dot dot-green" />
        </div>
        <div className="terminal-preview-title">{`terminal — ${themeName}`}</div>
      </div>

      <div
        className="terminal-preview-body"
        data-testid="terminal-preview-body"
        style={{
          backgroundColor: theme.background,
          color: theme.foreground,
          fontFamily,
          fontSize: `${fontSize}px`,
          lineHeight,
        }}
      >
        <div className="preview-line">
          <span style={{ color: theme.green }}>oppa</span>
          <span> </span>
          <span style={{ color: theme.blue }}>~/workspace</span>
          <span> </span>
          <span style={{ color: theme.magenta }}>git:(<span style={{ color: theme.cyan }}>main</span>)</span>
          <span> </span>
          <span className="preview-symbol">$</span>
          <span> npm run build</span>
        </div>

        <div className="preview-line">
          <span style={{ color: theme.cyan }}>[build]</span>
          <span> vite v7.3.6 compiling...</span>
        </div>

        <div className="preview-line">
          <span style={{ color: theme.green }}>✓</span>
          <span> 1885 modules transformed in 420ms</span>
        </div>

        <div className="preview-line preview-dim">
          <span>dist/index.js 960 kB │ gzip: 260 kB</span>
        </div>

        <div className="preview-line">
          <span style={{ color: theme.green }}>oppa</span>
          <span> </span>
          <span style={{ color: theme.blue }}>~/workspace</span>
          <span> </span>
          <span className="preview-symbol">$</span>
          <span> </span>
          <span
            className={`terminal-preview-cursor cursor-${cursorStyle}${cursorBlink ? " cursor-blink" : ""}`}
            data-testid="terminal-preview-cursor"
            style={{
              backgroundColor: cursorStyle !== "underline" ? cursorColor : undefined,
              borderBottomColor: cursorStyle === "underline" ? cursorColor : undefined,
            }}
          />
        </div>
      </div>

      <div className="terminal-preview-swatches" data-testid="preview-color-swatches">
        {swatches.map(({ name, color }) => (
          <div
            key={name}
            className="preview-swatch"
            data-testid={`preview-swatch-${name}`}
            title={name}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
    </div>
  );
};
