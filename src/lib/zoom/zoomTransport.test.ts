import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyUiZoom } from "./zoomTransport";
import { getCurrentWebview } from "@tauri-apps/api/webview";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(),
}));

describe("zoom transport", () => {
  const mockSetZoom = vi.fn();

  let rootEl: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.style.removeProperty("--ui-zoom-factor");
    vi.mocked(getCurrentWebview).mockReturnValue({
      setZoom: mockSetZoom,
    } as unknown as ReturnType<typeof getCurrentWebview>);
    rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);
  });

  afterEach(() => {
    rootEl.remove();
  });

  it("applies WebView zoom factor for 80% without touching root zoom", async () => {
    mockSetZoom.mockResolvedValueOnce(undefined);

    await applyUiZoom(0.8);

    expect(mockSetZoom).toHaveBeenCalledWith(0.8);
    expect(document.documentElement.style.zoom).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--ui-zoom-factor"),
    ).toBe("0.8");
  });

  it("applies WebView zoom factor for 110% and 125%", async () => {
    mockSetZoom.mockResolvedValue(undefined);

    await applyUiZoom(1.1);
    expect(mockSetZoom).toHaveBeenCalledWith(1.1);

    await applyUiZoom(1.25);
    expect(mockSetZoom).toHaveBeenCalledWith(1.25);
  });

  it("still sets CSS var when WebView API is unavailable (browser dev)", async () => {
    vi.mocked(getCurrentWebview).mockImplementationOnce(() => {
      throw new Error("Tauri API not available");
    });

    await expect(applyUiZoom(0.9)).resolves.not.toThrow();
    expect(
      document.documentElement.style.getPropertyValue("--ui-zoom-factor"),
    ).toBe("0.9");
  });

  it("swallows WebView IPC failures without throwing", async () => {
    mockSetZoom.mockRejectedValueOnce(new Error("IPC failure"));

    await expect(applyUiZoom(1.0)).resolves.not.toThrow();
  });

  it("scales #root with compensated size when WebView API is unavailable (browser dev)", async () => {
    vi.mocked(getCurrentWebview).mockImplementationOnce(() => {
      throw new Error("Tauri API not available");
    });

    await applyUiZoom(0.8);

    // transform scale + inverse layout size keeps the app filling the window.
    expect(rootEl.style.transform).toBe("scale(0.8)");
    expect(rootEl.style.width).toBe("125%");
    expect(rootEl.style.height).toBe("125%");
  });

  it("clears the browser fallback when WebView zoom succeeds", async () => {
    rootEl.style.transform = "scale(0.8)";
    rootEl.style.width = "125%";
    rootEl.style.height = "125%";
    mockSetZoom.mockResolvedValueOnce(undefined);

    await applyUiZoom(1.0);

    expect(mockSetZoom).toHaveBeenCalledWith(1.0);
    expect(rootEl.style.transform).toBe("");
    expect(rootEl.style.width).toBe("");
    expect(rootEl.style.height).toBe("");
  });
});
