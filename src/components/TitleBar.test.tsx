import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
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
    });
  });

  it("renders OPPA brand title and sidebar toggle buttons", () => {
    const { getByText, getByTitle, getByLabelText } = render(<TitleBar />);
    expect(getByText("OPPA")).toBeTruthy();
    expect(getByTitle("Toggle Left Sidebar")).toBeTruthy();
    expect(getByLabelText("Toggle Right Sidebar")).toBeTruthy();
  });

  it("renders window control buttons (minimize, maximize, close)", () => {
    const { getByTitle, getByLabelText } = render(<TitleBar />);
    expect(getByTitle("Minimize")).toBeTruthy();
    expect(getByLabelText("Maximize Window")).toBeTruthy();
    expect(getByTitle("Close")).toBeTruthy();
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
    const { getByTitle } = render(<TitleBar />);
    const leftToggleBtn = getByTitle("Toggle Left Sidebar");
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);

    fireEvent.click(leftToggleBtn);
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(false);

    fireEvent.click(leftToggleBtn);
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);
  });

  it("toggles right sidebar when right sidebar button is clicked", () => {
    const { getByTitle } = render(<TitleBar />);
    const rightToggleBtn = getByTitle("Toggle Right Sidebar");
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
    const { getByTitle } = render(<TitleBar />);
    const leftBtn = getByTitle("Toggle Left Sidebar");
    const rightBtn = getByTitle("Toggle Right Sidebar");

    expect(leftBtn.classList.contains("active")).toBe(true);
    expect(rightBtn.classList.contains("active")).toBe(false);
  });

  it("calls getCurrentWindow().minimize() when minimize button is clicked", () => {
    const { getByTitle } = render(<TitleBar />);
    const minimizeBtn = getByTitle("Minimize");
    fireEvent.click(minimizeBtn);
    expect(mockMinimize).toHaveBeenCalledTimes(1);
  });

  it("calls getCurrentWindow().toggleMaximize() when maximize button is clicked", () => {
    const { getByTitle } = render(<TitleBar />);
    const maximizeBtn = getByTitle("Maximize");
    fireEvent.click(maximizeBtn);
    expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("calls getCurrentWindow().close() when close button is clicked", () => {
    const { getByTitle } = render(<TitleBar />);
    const closeBtn = getByTitle("Close");
    fireEvent.click(closeBtn);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("catches and ignores errors if window controls fail", () => {
    mockMinimize.mockImplementationOnce(() => {
      throw new Error("Tauri API not available");
    });
    const { getByTitle } = render(<TitleBar />);
    const minimizeBtn = getByTitle("Minimize");
    expect(() => fireEvent.click(minimizeBtn)).not.toThrow();
  });
});
