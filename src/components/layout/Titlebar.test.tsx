import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { Titlebar } from "./Titlebar";

describe("Titlebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      leftSidebarOpen: true,
      rightSidebarOpen: true,
      sessions: {},
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
    });
  });

  it("renders the OPPA app title", () => {
    const { getByText } = render(<Titlebar />);
    expect(getByText("OPPA")).toBeTruthy();
  });

  it("renders left and right sidebar toggle buttons", () => {
    const { getByTitle } = render(<Titlebar />);
    expect(getByTitle("Toggle Left Sidebar")).toBeTruthy();
    expect(getByTitle("Toggle Right Sidebar")).toBeTruthy();
  });

  it("toggles left sidebar when left sidebar button is clicked", () => {
    const { getByTitle } = render(<Titlebar />);
    const leftToggleBtn = getByTitle("Toggle Left Sidebar");
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);

    fireEvent.click(leftToggleBtn);
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(false);

    fireEvent.click(leftToggleBtn);
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);
  });

  it("toggles right sidebar when right sidebar button is clicked", () => {
    const { getByTitle } = render(<Titlebar />);
    const rightToggleBtn = getByTitle("Toggle Right Sidebar");
    expect(useTerminalStore.getState().rightSidebarOpen).toBe(true);

    fireEvent.click(rightToggleBtn);
    expect(useTerminalStore.getState().rightSidebarOpen).toBe(false);

    fireEvent.click(rightToggleBtn);
    expect(useTerminalStore.getState().rightSidebarOpen).toBe(true);
  });

  it("displays active CWD breadcrumb trail when session cwd is present", () => {
    useTerminalStore.setState({
      sessions: {
        s1: {
          id: "s1",
          title: "s1",
          status: "running",
          cwd: "/home/user/projects/oppa-project",
          cols: 80,
          rows: 24,
        },
      },
      layout: { type: "leaf", id: "s1" },
    });

    const { getByText } = render(<Titlebar />);
    expect(getByText(/oppa-project/)).toBeTruthy();
  });

  it("displays default breadcrumb when no session cwd is present", () => {
    useTerminalStore.setState({
      sessions: {},
      layout: { type: "leaf", id: "" },
    });

    const { getByTestId } = render(<Titlebar />);
    const breadcrumb = getByTestId("titlebar-breadcrumb");
    expect(breadcrumb).toBeTruthy();
    expect(breadcrumb.textContent).toMatch(/oppa/i);
  });

  it("has window drag region attribute on container and false on interactive buttons", () => {
    const { container, getByTitle } = render(<Titlebar />);
    const header = container.querySelector("header.titlebar");
    expect(header).toBeTruthy();
    expect(header?.hasAttribute("data-tauri-drag-region")).toBe(true);

    const leftBtn = getByTitle("Toggle Left Sidebar");
    const rightBtn = getByTitle("Toggle Right Sidebar");
    expect(leftBtn.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(rightBtn.getAttribute("data-tauri-drag-region")).toBe("false");
  });
});
