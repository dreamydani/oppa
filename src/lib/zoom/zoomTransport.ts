import { getCurrentWebview } from "@tauri-apps/api/webview";

// Clear stale #root scale leftovers from the short-lived transform fallback.
function clearRootScaleFallback(): void {
  if (typeof document === "undefined") return;
  const root = document.getElementById("root");
  if (!root) return;
  root.style.transform = "";
  root.style.transformOrigin = "";
  root.style.width = "";
  root.style.height = "";
}

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
    // Native zoom owns scaling: root CSS zoom must stay off or they stack.
    if (typeof document !== "undefined") {
      document.documentElement.style.zoom = "";
    }
    clearRootScaleFallback();
  } catch {
    // No Tauri webview under `pnpm dev`: real browsers treat root zoom like
    // page zoom, so viewport-unit layouts keep filling the window. (A scaled
    // inner element would gutter because 100vw/100vh ignore its transform.)
    if (typeof document !== "undefined") {
      document.documentElement.style.zoom = String(factor);
    }
    clearRootScaleFallback();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("resize"));
    }
  }
}
