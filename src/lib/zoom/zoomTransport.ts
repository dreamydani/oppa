import { getCurrentWebview } from "@tauri-apps/api/webview";

// Browser-dev fallback (no Tauri webview under `pnpm dev`): transform-scale
// #root with inverse layout compensation so the app still fills the window
// instead of leaving gutters (80%) or clipping (110%+).
function applyBrowserFallback(factor: number): void {
  if (typeof document === "undefined") return;
  const root = document.getElementById("root");
  if (!root) return;
  if (factor === 1) {
    root.style.transform = "";
    root.style.transformOrigin = "";
    root.style.width = "";
    root.style.height = "";
    return;
  }
  const percent = 100 / factor;
  root.style.transform = `scale(${factor})`;
  root.style.transformOrigin = "top left";
  root.style.width = `${percent}%`;
  root.style.height = `${percent}%`;
  // Nudge observers (xterm fit) that don't track CSS transforms.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("resize"));
  }
}

function clearBrowserFallback(): void {
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
    clearBrowserFallback();
  } catch {
    applyBrowserFallback(factor);
  }
}
