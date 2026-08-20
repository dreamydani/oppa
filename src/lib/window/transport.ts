import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

// Queries current window size, position, and maximized status safely across environments
export async function getSavedWindowState(): Promise<WindowState | null> {
  try {
    const win = getCurrentWebviewWindow();
    const isMaximized = await win.isMaximized();
    const size = await win.innerSize();
    const pos = await win.outerPosition();
    return {
      width: size.width,
      height: size.height,
      x: pos.x,
      y: pos.y,
      isMaximized,
    };
  } catch {
    return null;
  }
}

// Restores window dimensions and position without throwing outside desktop runtime
export async function applyWindowState(state: WindowState): Promise<void> {
  try {
    const win = getCurrentWebviewWindow();
    if (state.isMaximized) {
      await win.maximize();
      return;
    }
    if (state.width > 0 && state.height > 0) {
      await win.setSize(new PhysicalSize(state.width, state.height));
    }
    if (typeof state.x === "number" && typeof state.y === "number") {
      // Prevent offscreen coordinates if secondary monitor was disconnected
      if (state.x >= 0 && state.y >= 0) {
        await win.setPosition(new PhysicalPosition(state.x, state.y));
      }
    }
  } catch {
    // Non-Tauri / headless test environments
  }
}
