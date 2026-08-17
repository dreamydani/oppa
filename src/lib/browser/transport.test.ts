import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  browserOpen,
  browserNavigate,
  browserSetBounds,
  browserHide,
  browserShow,
  browserGoBack,
  browserGoForward,
  browserReload,
  browserOpenDevTools,
} from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("browser transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("browserOpen invokes browser_open with url and bounds", async () => {
    invokeMock.mockResolvedValue(undefined);
    await browserOpen("http://localhost:5173", { x: 100, y: 50, width: 800, height: 600 });
    expect(invokeMock).toHaveBeenCalledWith("browser_open", {
      url: "http://localhost:5173",
      x: 100,
      y: 50,
      width: 800,
      height: 600,
    });
  });

  it("browserNavigate invokes browser_navigate with url", async () => {
    invokeMock.mockResolvedValue(undefined);
    await browserNavigate("https://github.com");
    expect(invokeMock).toHaveBeenCalledWith("browser_navigate", { url: "https://github.com" });
  });

  it("browserSetBounds invokes browser_set_bounds with bounds", async () => {
    invokeMock.mockResolvedValue(undefined);
    await browserSetBounds({ x: 0, y: 40, width: 1024, height: 768 });
    expect(invokeMock).toHaveBeenCalledWith("browser_set_bounds", {
      x: 0,
      y: 40,
      width: 1024,
      height: 768,
    });
  });

  it("browserHide invokes browser_hide", async () => {
    invokeMock.mockResolvedValue(undefined);
    await browserHide();
    expect(invokeMock).toHaveBeenCalledWith("browser_hide");
  });

  it("browserShow invokes browser_show", async () => {
    invokeMock.mockResolvedValue(undefined);
    await browserShow();
    expect(invokeMock).toHaveBeenCalledWith("browser_show");
  });

  it("browserGoBack invokes browser_go_back", async () => {
    invokeMock.mockResolvedValue(undefined);
    await browserGoBack();
    expect(invokeMock).toHaveBeenCalledWith("browser_go_back");
  });

  it("browserGoForward invokes browser_go_forward", async () => {
    invokeMock.mockResolvedValue(undefined);
    await browserGoForward();
    expect(invokeMock).toHaveBeenCalledWith("browser_go_forward");
  });

  it("browserReload invokes browser_reload", async () => {
    invokeMock.mockResolvedValue(undefined);
    await browserReload();
    expect(invokeMock).toHaveBeenCalledWith("browser_reload");
  });

  it("browserOpenDevTools invokes browser_open_devtools", async () => {
    invokeMock.mockResolvedValue(undefined);
    await browserOpenDevTools();
    expect(invokeMock).toHaveBeenCalledWith("browser_open_devtools");
  });

  it("safely catches errors when invoke fails in non-Tauri / test environments", async () => {
    invokeMock.mockRejectedValue(new Error("IPC not available"));
    await expect(browserOpen("http://localhost:3000", { x: 0, y: 0, width: 100, height: 100 })).resolves.toBeUndefined();
    await expect(browserNavigate("http://localhost:3000")).resolves.toBeUndefined();
    await expect(browserSetBounds({ x: 0, y: 0, width: 100, height: 100 })).resolves.toBeUndefined();
    await expect(browserHide()).resolves.toBeUndefined();
    await expect(browserShow()).resolves.toBeUndefined();
    await expect(browserGoBack()).resolves.toBeUndefined();
    await expect(browserGoForward()).resolves.toBeUndefined();
    await expect(browserReload()).resolves.toBeUndefined();
    await expect(browserOpenDevTools()).resolves.toBeUndefined();
  });
});
