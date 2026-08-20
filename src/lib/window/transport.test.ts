import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSavedWindowState, applyWindowState } from "./transport";
import type { WindowState } from "./transport";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(),
}));

describe("window transport", () => {
  const mockIsMaximized = vi.fn();
  const mockInnerSize = vi.fn();
  const mockOuterPosition = vi.fn();
  const mockMaximize = vi.fn();
  const mockSetSize = vi.fn();
  const mockSetPosition = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentWebviewWindow).mockReturnValue({
      isMaximized: mockIsMaximized,
      innerSize: mockInnerSize,
      outerPosition: mockOuterPosition,
      maximize: mockMaximize,
      setSize: mockSetSize,
      setPosition: mockSetPosition,
    } as unknown as ReturnType<typeof getCurrentWebviewWindow>);
  });

  describe("getSavedWindowState", () => {
    it("extracts window state safely when APIs succeed", async () => {
      mockIsMaximized.mockResolvedValueOnce(false);
      mockInnerSize.mockResolvedValueOnce({ width: 1280, height: 800 });
      mockOuterPosition.mockResolvedValueOnce({ x: 150, y: 120 });

      const state = await getSavedWindowState();
      expect(state).toEqual({
        width: 1280,
        height: 800,
        x: 150,
        y: 120,
        isMaximized: false,
      });
    });

    it("extracts maximized window state", async () => {
      mockIsMaximized.mockResolvedValueOnce(true);
      mockInnerSize.mockResolvedValueOnce({ width: 1920, height: 1080 });
      mockOuterPosition.mockResolvedValueOnce({ x: 0, y: 0 });

      const state = await getSavedWindowState();
      expect(state).toEqual({
        width: 1920,
        height: 1080,
        x: 0,
        y: 0,
        isMaximized: true,
      });
    });

    it("returns null if getCurrentWebviewWindow throws", async () => {
      vi.mocked(getCurrentWebviewWindow).mockImplementationOnce(() => {
        throw new Error("Tauri API not available in web context");
      });

      const state = await getSavedWindowState();
      expect(state).toBeNull();
    });

    it("returns null if window async calls reject", async () => {
      mockIsMaximized.mockRejectedValueOnce(new Error("IPC failure"));

      const state = await getSavedWindowState();
      expect(state).toBeNull();
    });
  });

  describe("applyWindowState", () => {
    it("maximizes window when isMaximized is true", async () => {
      mockMaximize.mockResolvedValueOnce(undefined);

      const state: WindowState = {
        width: 1200,
        height: 800,
        x: 100,
        y: 100,
        isMaximized: true,
      };

      await applyWindowState(state);

      expect(mockMaximize).toHaveBeenCalledTimes(1);
      expect(mockSetSize).not.toHaveBeenCalled();
      expect(mockSetPosition).not.toHaveBeenCalled();
    });

    it("sets size and position when isMaximized is false and coordinates are valid", async () => {
      mockSetSize.mockResolvedValueOnce(undefined);
      mockSetPosition.mockResolvedValueOnce(undefined);

      const state: WindowState = {
        width: 1024,
        height: 768,
        x: 50,
        y: 80,
        isMaximized: false,
      };

      await applyWindowState(state);

      expect(mockMaximize).not.toHaveBeenCalled();
      expect(mockSetSize).toHaveBeenCalledWith(new PhysicalSize(1024, 768));
      expect(mockSetPosition).toHaveBeenCalledWith(new PhysicalPosition(50, 80));
    });

    it("does not set position if x or y is negative (offscreen guard)", async () => {
      mockSetSize.mockResolvedValueOnce(undefined);

      const state: WindowState = {
        width: 1024,
        height: 768,
        x: -500,
        y: -200,
        isMaximized: false,
      };

      await applyWindowState(state);

      expect(mockSetSize).toHaveBeenCalledWith(new PhysicalSize(1024, 768));
      expect(mockSetPosition).not.toHaveBeenCalled();
    });

    it("does not set position if x or y is undefined", async () => {
      mockSetSize.mockResolvedValueOnce(undefined);

      const state: WindowState = {
        width: 1024,
        height: 768,
        isMaximized: false,
      };

      await applyWindowState(state);

      expect(mockSetSize).toHaveBeenCalledWith(new PhysicalSize(1024, 768));
      expect(mockSetPosition).not.toHaveBeenCalled();
    });

    it("does not set size if width or height is <= 0", async () => {
      mockSetPosition.mockResolvedValueOnce(undefined);

      const state: WindowState = {
        width: 0,
        height: 0,
        x: 100,
        y: 100,
        isMaximized: false,
      };

      await applyWindowState(state);

      expect(mockSetSize).not.toHaveBeenCalled();
      expect(mockSetPosition).toHaveBeenCalledWith(new PhysicalPosition(100, 100));
    });

    it("swallows errors gracefully if window API fails", async () => {
      mockMaximize.mockRejectedValueOnce(new Error("IPC failed"));

      const state: WindowState = {
        width: 1200,
        height: 800,
        isMaximized: true,
      };

      await expect(applyWindowState(state)).resolves.not.toThrow();
    });

    it("swallows error if getCurrentWebviewWindow throws", async () => {
      vi.mocked(getCurrentWebviewWindow).mockImplementationOnce(() => {
        throw new Error("Tauri API not available");
      });

      const state: WindowState = {
        width: 1200,
        height: 800,
        isMaximized: false,
      };

      await expect(applyWindowState(state)).resolves.not.toThrow();
    });
  });
});
