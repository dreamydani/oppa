import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { BrowserOmnibox, normalizeUrl } from "./BrowserOmnibox";
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

describe("normalizeUrl helper", () => {
  it("normalizes pure digit port numbers to localhost", () => {
    expect(normalizeUrl("5173")).toBe("http://localhost:5173");
    expect(normalizeUrl("3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("8080")).toBe("http://localhost:8080");
  });

  it("normalizes localhost and 127.0.0.1 addresses", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("localhost:8080/dashboard")).toBe("http://localhost:8080/dashboard");
    expect(normalizeUrl("127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(normalizeUrl("localhost")).toBe("http://localhost");
  });

  it("preserves explicit http and https protocols", () => {
    expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("https://github.com")).toBe("https://github.com");
    expect(normalizeUrl("http://example.com/api")).toBe("http://example.com/api");
  });

  it("normalizes domain names to https", () => {
    expect(normalizeUrl("github.com")).toBe("https://github.com");
    expect(normalizeUrl("vitejs.dev/guide")).toBe("https://vitejs.dev/guide");
    expect(normalizeUrl("docs.rs/tokio")).toBe("https://docs.rs/tokio");
  });

  it("converts general queries into search URLs based on engine", () => {
    expect(normalizeUrl("react useeffect hook", "duckduckgo")).toBe(
      "https://duckduckgo.com/?q=react%20useeffect%20hook"
    );
    expect(normalizeUrl("react useeffect hook", "google")).toBe(
      "https://www.google.com/search?q=react%20useeffect%20hook"
    );
    expect(normalizeUrl("react useeffect hook", "bing")).toBe(
      "https://www.bing.com/search?q=react%20useeffect%20hook"
    );
  });

  it("returns empty string for empty input", () => {
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl("   ")).toBe("");
  });
});

describe("BrowserOmnibox component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      browserUrl: "",
      browserHistory: [],
      historyIndex: -1,
    });
  });

  it("renders navigation buttons: Back, Forward, Reload, Home", () => {
    render(<BrowserOmnibox />);
    expect(screen.getByTitle("Back")).toBeInTheDocument();
    expect(screen.getByTitle("Forward")).toBeInTheDocument();
    expect(screen.getByTitle("Reload")).toBeInTheDocument();
    expect(screen.getByTitle("Home")).toBeInTheDocument();
  });

  it("disables Back and Forward buttons when history is empty", () => {
    render(<BrowserOmnibox />);
    expect(screen.getByTitle("Back")).toBeDisabled();
    expect(screen.getByTitle("Forward")).toBeDisabled();
  });

  it("enables Back button when historyIndex > 0 and navigates back on click", () => {
    useTerminalStore.setState({
      browserUrl: "https://example.com/page2",
      browserHistory: ["https://example.com/page1", "https://example.com/page2"],
      historyIndex: 1,
    });

    render(<BrowserOmnibox />);
    const backBtn = screen.getByTitle("Back");
    expect(backBtn).not.toBeDisabled();

    fireEvent.click(backBtn);
    expect(browserTransport.browserGoBack).toHaveBeenCalled();
    expect(useTerminalStore.getState().browserUrl).toBe("https://example.com/page1");
    expect(useTerminalStore.getState().historyIndex).toBe(0);
  });

  it("enables Forward button when historyIndex < history.length - 1 and navigates forward on click", () => {
    useTerminalStore.setState({
      browserUrl: "https://example.com/page1",
      browserHistory: ["https://example.com/page1", "https://example.com/page2"],
      historyIndex: 0,
    });

    render(<BrowserOmnibox />);
    const fwdBtn = screen.getByTitle("Forward");
    expect(fwdBtn).not.toBeDisabled();

    fireEvent.click(fwdBtn);
    expect(browserTransport.browserGoForward).toHaveBeenCalled();
    expect(useTerminalStore.getState().browserUrl).toBe("https://example.com/page2");
    expect(useTerminalStore.getState().historyIndex).toBe(1);
  });

  it("reloads current page on Reload button click", () => {
    useTerminalStore.setState({
      browserUrl: "http://localhost:5173",
      browserHistory: ["http://localhost:5173"],
      historyIndex: 0,
    });

    render(<BrowserOmnibox />);
    const reloadBtn = screen.getByTitle("Reload");
    fireEvent.click(reloadBtn);
    expect(browserTransport.browserReload).toHaveBeenCalled();
  });

  it("navigates to Hub (empty URL) on Home button click", () => {
    useTerminalStore.setState({
      browserUrl: "http://localhost:5173",
      browserHistory: ["http://localhost:5173"],
      historyIndex: 0,
    });

    render(<BrowserOmnibox />);
    const homeBtn = screen.getByTitle("Home");
    fireEvent.click(homeBtn);
    expect(useTerminalStore.getState().browserUrl).toBe("");
    expect(browserTransport.browserNavigate).toHaveBeenCalledWith("");
  });

  it("displays placeholder and handles URL input and submission", () => {
    render(<BrowserOmnibox />);
    const input = screen.getByPlaceholderText(
      "Search or enter URL (e.g. 5173 or localhost:3000)"
    ) as HTMLInputElement;
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "5173" } });
    expect(input.value).toBe("5173");

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");
    expect(browserTransport.browserNavigate).toHaveBeenCalledWith("http://localhost:5173");
  });

  it("submits search query using configured search engine in settings", () => {
    useTerminalStore.setState({
      settings: {
        general: {
          ...useTerminalStore.getState().settings.general,
          browserSearchEngine: "google",
        },
      },
    });

    render(<BrowserOmnibox />);
    const input = screen.getByPlaceholderText(
      "Search or enter URL (e.g. 5173 or localhost:3000)"
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "tauri rust app" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(useTerminalStore.getState().browserUrl).toBe("https://www.google.com/search?q=tauri%20rust%20app");
    expect(browserTransport.browserNavigate).toHaveBeenCalledWith("https://www.google.com/search?q=tauri%20rust%20app");
  });

  it("shows lock indicator for secure/localhost URLs and globe indicator for http URLs", () => {
    const { rerender } = render(<BrowserOmnibox />);

    // Secure HTTPS
    useTerminalStore.setState({ browserUrl: "https://github.com" });
    rerender(<BrowserOmnibox />);
    expect(screen.getByTestId("protocol-indicator-secure")).toBeInTheDocument();

    // Localhost
    useTerminalStore.setState({ browserUrl: "http://localhost:3000" });
    rerender(<BrowserOmnibox />);
    expect(screen.getByTestId("protocol-indicator-secure")).toBeInTheDocument();

    // Insecure HTTP non-localhost
    useTerminalStore.setState({ browserUrl: "http://example.com" });
    rerender(<BrowserOmnibox />);
    expect(screen.getByTestId("protocol-indicator-insecure")).toBeInTheDocument();
  });

  it("clears input when clear button is clicked", () => {
    render(<BrowserOmnibox />);
    const input = screen.getByPlaceholderText(
      "Search or enter URL (e.g. 5173 or localhost:3000)"
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "temp query" } });
    const clearBtn = screen.getByTitle("Clear");
    expect(clearBtn).toBeInTheDocument();

    fireEvent.click(clearBtn);
    expect(input.value).toBe("");
  });

  it("opens dev tools when DevTools button is clicked", () => {
    render(<BrowserOmnibox />);
    const devToolsBtn = screen.getByTitle("Toggle Developer Tools");
    fireEvent.click(devToolsBtn);
    expect(browserTransport.browserOpenDevTools).toHaveBeenCalled();
  });

  it("opens external browser when Open in Default Browser button is clicked", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    useTerminalStore.setState({ browserUrl: "https://github.com" });

    render(<BrowserOmnibox />);
    const openExternalBtn = screen.getByTitle("Open in default browser");
    fireEvent.click(openExternalBtn);
    expect(openSpy).toHaveBeenCalledWith("https://github.com", "_blank");
    openSpy.mockRestore();
  });
});
