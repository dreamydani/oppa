// Adaptive GPU quality tiers. A tiny WebGL2 renderer-string probe picks a
// tier once (cached); the tier drives the background-pane frame cap and
// whether chrome effects (glow, shadows) are on. Low = 2019-era iGPU
// baseline, Medium = modern iGPU, High = discrete. Fallback is Medium so an
// unavailable probe never strands the app at the lowest quality.

export type GpuTierName = "low" | "medium" | "high";

export interface GpuTierConfig {
  name: GpuTierName;
  // Background (non-focused, non-hovered) pane render cap in fps.
  backgroundFps: number;
  // Chrome effects (focused glow, hover glow) on/off.
  chromeEnabled: boolean;
}

export const GpuTier: Record<GpuTierName, GpuTierConfig> = {
  low: { name: "low", backgroundFps: 15, chromeEnabled: false },
  medium: { name: "medium", backgroundFps: 30, chromeEnabled: true },
  high: { name: "high", backgroundFps: 30, chromeEnabled: true },
};

let cached: GpuTierName | null = null;

function probeRenderer(): string | null {
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") as
      | { getParameter: (p: number) => unknown }
      | null;
    if (!gl) return null;
    const renderer = String(gl.getParameter(37445) ?? "");
    return renderer || null;
  } catch {
    return null;
  }
}

function classify(renderer: string): GpuTierName {
  const r = renderer.toLowerCase();
  // 2019-era integrated Intel (UHD 6xx / HD 5xx-6xx) is the low floor.
  const isOldIntelIgpu =
    r.includes("intel") &&
    (r.includes("uhd graphics 6") ||
      r.includes("hd graphics 5") ||
      r.includes("hd graphics 6"));
  const isDiscrete =
    r.includes("nvidia") ||
    r.includes("radeon") ||
    r.includes("rtx") ||
    r.includes("gtx") ||
    r.includes("quadro") ||
    r.includes("amd radeon");
  if (isDiscrete) return "high";
  if (isOldIntelIgpu) return "low";
  // Everything else (modern iGPU, Apple Silicon, unknown) is medium.
  return "medium";
}

export function detectGpuTier(): GpuTierName {
  if (cached) return cached;
  const renderer = probeRenderer();
  cached = renderer ? classify(renderer) : "medium";
  return cached;
}

export function resetGpuTierForTests(): void {
  cached = null;
}
