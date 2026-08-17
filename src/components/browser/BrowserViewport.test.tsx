import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { BrowserViewport } from "./BrowserViewport";
import * as browserTransport from "../../lib/browser/transport";

vi.mock("../../lib/browser/transport", () => ({
  browserOpen: vi.fn().mockResolvedValue(undefined),
  browserNavigate: vi.fn().mockResolvedValue(undefined),
  browserSetBounds: vi.fn().mockResolvedValue(undefined),
  browserHide: vi.fn().mockResolvedValue(undefined),
  browserShow: vi.fn().mockResolvedValue(undefined),
  browserGoBack: vi.fn().mockResolvedValue(undefined),
  browserGoForward: vi.fn().mockResolvedValue(undefined),
  browserReload: vi.fn().mockResolvedValue(undefined),
  browserOpenDevTools: vi.fn().mockResolvedValue(undefined),
}));

describe("BrowserViewport component", () => {
  let activeMockObserver: MockResizeObserver | null = null;

  class MockResizeObserver {
    callback: ResizeObserverCallback;
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();

    constructor(cb: ResizeObserverCallback) {
      this.callback = cb;
      activeMockObserver = this;
    }

    triggerResize(entries: Partial<ResizeObserverEntry>[]) {
      this.callback(entries as ResizeObserverEntry[], this as unknown as ResizeObserver);
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      browserUrl: "",
      browserHistory: [],
      historyIndex: -1,
      devicePreset: "responsive",
      detectedPorts: [],
    });

    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    activeMockObserver = null;
  });

  it("renders BrowserOmnibox and DeviceToolbar", () => {
    render(<BrowserViewport />);
    expect(
      screen.getAllByPlaceholderText("Search or enter URL (e.g. 5173 or localhost:3000)")[0]
    ).toBeInTheDocument();
    expect(screen.getByText("Responsive")).toBeInTheDocument();
    expect(screen.getByText("iPhone 15 Pro")).toBeInTheDocument();
    expect(screen.getByText("iPad Air")).toBeInTheDocument();
    expect(screen.getByText("Desktop")).toBeInTheDocument();
  });

  it("renders BrowserHub when browserUrl is empty", () => {
    render(<BrowserViewport />);
    expect(screen.getByText("Developer Hub")).toBeInTheDocument();
    expect(screen.queryByTitle("Browser Preview")).not.toBeInTheDocument();
  });

  it("renders iframe when browserUrl is set", () => {
    useTerminalStore.setState({ browserUrl: "http://localhost:5173" });
    render(<BrowserViewport />);
    const iframe = screen.getByTitle("Browser Preview") as HTMLIFrameElement;
    expect(iframe).toBeInTheDocument();
    expect(iframe.src).toBe("http://localhost:5173/");
  });

  it("switches device presets when buttons are clicked in DeviceToolbar", () => {
    useTerminalStore.setState({ browserUrl: "http://localhost:5173" });
    render(<BrowserViewport />);

    const iphoneBtn = screen.getByText("iPhone 15 Pro");
    fireEvent.click(iphoneBtn);
    expect(useTerminalStore.getState().devicePreset).toBe("iphone");
    expect(screen.getByText("393 × 852px")).toBeInTheDocument();

    const ipadBtn = screen.getByText("iPad Air");
    fireEvent.click(ipadBtn);
    expect(useTerminalStore.getState().devicePreset).toBe("ipad");
    expect(screen.getByText("820 × 1180px")).toBeInTheDocument();

    const desktopBtn = screen.getByText("Desktop");
    fireEvent.click(desktopBtn);
    expect(useTerminalStore.getState().devicePreset).toBe("desktop");
    expect(screen.getByText("1280 × 800px")).toBeInTheDocument();

    const responsiveBtn = screen.getByText("Responsive");
    fireEvent.click(responsiveBtn);
    expect(useTerminalStore.getState().devicePreset).toBe("responsive");
  });

  it("registers ResizeObserver and notifies browserSetBounds on element resize", () => {
    useTerminalStore.setState({ browserUrl: "http://localhost:5173" });
    const { container } = render(<BrowserViewport />);

    expect(activeMockObserver).not.toBeNull();
    expect(activeMockObserver?.observe).toHaveBeenCalled();

    const target = container.querySelector(".browser-responsive-wrapper") || container;
    activeMockObserver?.triggerResize([
      {
        target: target as Element,
        contentRect: {
          x: 10,
          y: 60,
          width: 800,
          height: 600,
          top: 60,
          right: 810,
          bottom: 660,
          left: 10,
          toJSON: () => {},
        },
      },
    ]);

    expect(browserTransport.browserSetBounds).toHaveBeenCalled();
  });
});
