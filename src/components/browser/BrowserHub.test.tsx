import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { BrowserHub } from "./BrowserHub";
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

describe("BrowserHub component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      browserUrl: "",
      detectedPorts: [],
    });
  });

  it("renders heading and tagline", () => {
    render(<BrowserHub />);
    expect(screen.getByText("Developer Hub")).toBeInTheDocument();
    expect(
      screen.getByText("Quick-launch dev servers and documentation")
    ).toBeInTheDocument();
  });

  it("renders quick search bar and navigates on enter", () => {
    render(<BrowserHub />);
    const input = screen.getByPlaceholderText(
      "Search or enter URL (e.g. 5173 or localhost:3000)"
    );
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "3000" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:3000");
    expect(browserTransport.browserNavigate).toHaveBeenCalledWith("http://localhost:3000");
  });

  it("shows empty state tip when no active servers are detected", () => {
    render(<BrowserHub />);
    expect(
      screen.getByText(
        "Run your dev server in the terminal (e.g. pnpm dev) to see it here automatically."
      )
    ).toBeInTheDocument();
  });

  it("renders active local server cards when detectedPorts has items", () => {
    useTerminalStore.setState({
      detectedPorts: [
        {
          port: 5173,
          url: "http://localhost:5173",
          title: "Vite App",
          timestamp: Date.now() - 60000,
        },
        {
          port: 8080,
          url: "http://localhost:8080",
          title: "API Server",
          timestamp: Date.now(),
        },
      ],
    });

    render(<BrowserHub />);
    expect(screen.getByText("Vite App")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:5173")).toBeInTheDocument();
    expect(screen.getByText("API Server")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:8080")).toBeInTheDocument();
  });

  it("navigates to detected server URL when clicking on a server card", () => {
    useTerminalStore.setState({
      detectedPorts: [
        {
          port: 5173,
          url: "http://localhost:5173",
          title: "Vite App",
          timestamp: Date.now(),
        },
      ],
    });

    render(<BrowserHub />);
    const serverCard = screen.getByText("Vite App").closest("button");
    expect(serverCard).toBeInTheDocument();

    fireEvent.click(serverCard!);
    expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");
    expect(browserTransport.browserNavigate).toHaveBeenCalledWith("http://localhost:5173");
  });

  it("renders quick developer bookmarks and navigates on click", () => {
    render(<BrowserHub />);
    const bookmarks = ["GitHub", "Vercel", "Tailwind CSS", "MDN Web Docs", "DevDocs"];

    for (const name of bookmarks) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }

    const githubBtn = screen.getByText("GitHub").closest("button");
    fireEvent.click(githubBtn!);
    expect(useTerminalStore.getState().browserUrl).toBe("https://github.com");
    expect(browserTransport.browserNavigate).toHaveBeenCalledWith("https://github.com");
  });
});
