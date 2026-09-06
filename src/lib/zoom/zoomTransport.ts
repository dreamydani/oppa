import { getCurrentWebview } from "@tauri-apps/api/webview";

// WebView-level UI zoom (Orca parity): scales the whole viewport like
// browser zoom, so 100vw/100vh layouts still fill the window at 80%..125%.
export async function applyUiZoom(factor: number): Promise<void> {
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty(
      "--ui-zoom-factor",
      String(factor),
    );
  }
  try {
    await getCurrentWebview().setZoom(factor);
  } catch {
    // Browser dev / tests without a Tauri webview: CSS var above is enough.
  }
}
