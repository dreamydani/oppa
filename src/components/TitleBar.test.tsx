import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { TitleBar } from "./TitleBar";

const mockMinimize = vi.fn();
const mockToggleMaximize = vi.fn();
const mockClose = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: mockMinimize,
    toggleMaximize: mockToggleMaximize,
    close: mockClose,
  }),
}));

describe("TitleBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      leftSidebarOpen: true,
      rightSidebarOpen: false,
      activeAppMode: "terminal",
    });
  });

  it("renders oppa brand title and sidebar toggle buttons", () => {
    render(<TitleBar />);
    expect(screen.getByText("oppa")).toBeTruthy();
    expect(screen.getByTitle("Toggle Left Sidebar")).toBeTruthy();
    expect(screen.getByLabelText("Toggle Right Sidebar")).toBeTruthy();
  });

  it("renders 3-mode switcher tabs (browser, terminal, editor)", () => {
    const { container } = render(<TitleBar />);
    const browserTab = screen.getByText("browser");
    const terminalTab = screen.getByText(/terminal/);
    const editorTab = screen.getByText("editor");

    expect(browserTab).toBeTruthy();
    expect(terminalTab).toBeTruthy();
    expect(editorTab).toBeTruthy();

    const pill = container.querySelector(".mode-switcher-pill");
    expect(pill).toBeTruthy();
    expect(pill?.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("renders terminal mode tab as active by default", () => {
    render(<TitleBar />);
    const terminalTab = screen.getByRole("button", { name: /terminal/i });
    expect(terminalTab).toBeTruthy();
    expect(terminalTab.classList.contains("active")).toBe(true);
    expect(terminalTab.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches to browser mode when browser tab is clicked", () => {
    render(<TitleBar />);
    const browserTab = screen.getByRole("button", { name: /browser/i });
    const terminalTab = screen.getByRole("button", { name: /terminal/i });

    expect(browserTab.classList.contains("active")).toBe(false);
    expect(useTerminalStore.getState().activeAppMode).toBe("terminal");

    fireEvent.click(browserTab);

    expect(useTerminalStore.getState().activeAppMode).toBe("browser");
    expect(browserTab.classList.contains("active")).toBe(true);
    expect(browserTab.getAttribute("aria-pressed")).toBe("true");
    expect(terminalTab.classList.contains("active")).toBe(false);
    expect(terminalTab.getAttribute("aria-pressed")).toBe("false");
  });

  it("switches back to terminal mode when terminal tab is clicked", () => {
    useTerminalStore.setState({ activeAppMode: "browser" });
    render(<TitleBar />);
    const browserTab = screen.getByRole("button", { name: /browser/i });
    const terminalTab = screen.getByRole("button", { name: /terminal/i });

    expect(browserTab.classList.contains("active")).toBe(true);
    expect(terminalTab.classList.contains("active")).toBe(false);

    fireEvent.click(terminalTab);

    expect(useTerminalStore.getState().activeAppMode).toBe("terminal");
    expect(terminalTab.classList.contains("active")).toBe(true);
    expect(terminalTab.getAttribute("aria-pressed")).toBe("true");
    expect(browserTab.classList.contains("active")).toBe(false);
    expect(browserTab.getAttribute("aria-pressed")).toBe("false");
  });

  it("switches to editor mode when editor tab is clicked", () => {
    render(<TitleBar />);
    const editorTab = screen.getByRole("button", { name: /editor/i });
    const terminalTab = screen.getByRole("button", { name: /terminal/i });

    expect(editorTab.classList.contains("active")).toBe(false);
    expect(editorTab.getAttribute("aria-pressed")).toBe("false");
    expect(useTerminalStore.getState().activeAppMode).toBe("terminal");

    fireEvent.click(editorTab);

    expect(useTerminalStore.getState().activeAppMode).toBe("editor");
    expect(editorTab.classList.contains("active")).toBe(true);
    expect(editorTab.getAttribute("aria-pressed")).toBe("true");
    expect(terminalTab.classList.contains("active")).toBe(false);
    expect(terminalTab.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders editor tab as active when activeAppMode is editor", () => {
    useTerminalStore.setState({ activeAppMode: "editor" });
    render(<TitleBar />);
    const editorTab = screen.getByRole("button", { name: /editor/i });

    expect(editorTab.classList.contains("active")).toBe(true);
    expect(editorTab.getAttribute("aria-pressed")).toBe("true");
    expect(editorTab.classList.contains("disabled")).toBe(false);
  });

  it("renders window control buttons (minimize, maximize, close)", () => {
    render(<TitleBar />);
    expect(screen.getByTitle("Minimize")).toBeTruthy();
    expect(screen.getByLabelText("Maximize Window")).toBeTruthy();
    expect(screen.getByTitle("Close")).toBeTruthy();
  });

  it("has data-tauri-drag-region on header and center draggable area", () => {
    const { container } = render(<TitleBar />);
    const header = container.querySelector("header.title-bar");
    expect(header).toBeTruthy();
    expect(header?.hasAttribute("data-tauri-drag-region")).toBe(true);

    const centerArea = container.querySelector(".title-bar-center");
    expect(centerArea).toBeTruthy();
    expect(centerArea?.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("toggles left sidebar when left sidebar button is clicked", () => {
    render(<TitleBar />);
    const leftToggleBtn = screen.getByTitle("Toggle Left Sidebar");
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);

    fireEvent.click(leftToggleBtn);
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(false);

    fireEvent.click(leftToggleBtn);
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);
  });

  it("toggles right sidebar when right sidebar button is clicked", () => {
    render(<TitleBar />);
    const rightToggleBtn = screen.getByTitle("Toggle Right Sidebar");
    expect(useTerminalStore.getState().rightSidebarOpen).toBe(false);

    fireEvent.click(rightToggleBtn);
    expect(useTerminalStore.getState().rightSidebarOpen).toBe(true);

    fireEvent.click(rightToggleBtn);
    expect(useTerminalStore.getState().rightSidebarOpen).toBe(false);
  });

  it("applies active class to toggle buttons when open", () => {
    useTerminalStore.setState({
      leftSidebarOpen: true,
      rightSidebarOpen: false,
    });
    render(<TitleBar />);
    const leftBtn = screen.getByTitle("Toggle Left Sidebar");
    const rightBtn = screen.getByTitle("Toggle Right Sidebar");

    expect(leftBtn.classList.contains("active")).toBe(true);
    expect(rightBtn.classList.contains("active")).toBe(false);
  });

  it("calls getCurrentWindow().minimize() when minimize button is clicked", () => {
    render(<TitleBar />);
    const minimizeBtn = screen.getByTitle("Minimize");
    fireEvent.click(minimizeBtn);
    expect(mockMinimize).toHaveBeenCalledTimes(1);
  });

  it("calls getCurrentWindow().toggleMaximize() when maximize button is clicked", () => {
    render(<TitleBar />);
    const maximizeBtn = screen.getByTitle("Maximize");
    fireEvent.click(maximizeBtn);
    expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("calls getCurrentWindow().close() when close button is clicked", () => {
    render(<TitleBar />);
    const closeBtn = screen.getByTitle("Close");
    fireEvent.click(closeBtn);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("catches and ignores errors if window controls fail", () => {
    mockMinimize.mockImplementationOnce(() => {
      throw new Error("Tauri API not available");
    });
    render(<TitleBar />);
    const minimizeBtn = screen.getByTitle("Minimize");
    expect(() => fireEvent.click(minimizeBtn)).not.toThrow();
  });
});
