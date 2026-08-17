import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  PanelLeftIcon,
  PanelRightIcon,
  TerminalIcon,
  FolderIcon,
  FileIcon,
  SettingsIcon,
  PlusIcon,
  SearchIcon,
  CloseIcon,
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
} from "./MinimalIcons";

describe("MinimalIcons", () => {
  const iconComponents = [
    { name: "PanelLeftIcon", Component: PanelLeftIcon },
    { name: "PanelRightIcon", Component: PanelRightIcon },
    { name: "TerminalIcon", Component: TerminalIcon },
    { name: "FolderIcon", Component: FolderIcon },
    { name: "FileIcon", Component: FileIcon },
    { name: "SettingsIcon", Component: SettingsIcon },
    { name: "PlusIcon", Component: PlusIcon },
    { name: "SearchIcon", Component: SearchIcon },
    { name: "CloseIcon", Component: CloseIcon },
    { name: "MinimizeIcon", Component: MinimizeIcon },
    { name: "MaximizeIcon", Component: MaximizeIcon },
    { name: "RestoreIcon", Component: RestoreIcon },
  ];

  it.each(iconComponents)("renders $name as an SVG element with custom props", ({ Component }) => {
    const { container } = render(
      <Component size={20} className="custom-icon" data-testid="icon" />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("width")).toBe("20");
    expect(svg?.getAttribute("height")).toBe("20");
    expect(svg?.getAttribute("class")).toContain("custom-icon");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("fill")).toBe("none");
  });

  it("renders with default 16px size and stroke currentColor", () => {
    const { container } = render(<TerminalIcon />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("height")).toBe("16");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
  });
});
