import { afterEach, describe, expect, it, vi } from "vitest";
import { detectGpuTier, resetGpuTierForTests, GpuTier } from "./gpuTier";

describe("detectGpuTier", () => {
  afterEach(() => {
    resetGpuTierForTests();
    vi.unstubAllGlobals();
  });

  it("maps an Intel 2019-era integrated GPU to low", () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({ getParameter: () => "ANGLE (Intel, Intel(R) UHD Graphics 620 ...)" }),
      }),
    });
    expect(detectGpuTier()).toBe("low");
  });

  it("maps a modern integrated GPU to medium", () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({ getParameter: () => "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics ...)" }),
      }),
    });
    expect(detectGpuTier()).toBe("medium");
  });

  it("maps a discrete GPU to high", () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({ getParameter: () => "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 ...)" }),
      }),
    });
    expect(detectGpuTier()).toBe("high");
  });

  it("falls back to medium when WebGL2 is unavailable", () => {
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => null }),
    });
    expect(detectGpuTier()).toBe("medium");
  });

  it("falls back to medium when the renderer is unrecognized", () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({ getParameter: () => "ANGLE (Some, Strange Renderer ...)" }),
      }),
    });
    expect(detectGpuTier()).toBe("medium");
  });

  it("caches the tier so repeated calls do not re-probe", () => {
    const getContext = vi.fn(() => ({
      getParameter: () => "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 ...)",
    }));
    vi.stubGlobal("document", { createElement: () => ({ getContext }) });
    expect(detectGpuTier()).toBe("high");
    detectGpuTier();
    detectGpuTier();
    expect(getContext).toHaveBeenCalledTimes(1);
  });
});

describe("GpuTier constants", () => {
  it("exposes the background fps cap per tier", () => {
    expect(GpuTier.low.backgroundFps).toBe(15);
    expect(GpuTier.medium.backgroundFps).toBe(30);
    expect(GpuTier.high.backgroundFps).toBe(30);
    expect(GpuTier.low.chromeEnabled).toBe(false);
    expect(GpuTier.medium.chromeEnabled).toBe(true);
    expect(GpuTier.high.chromeEnabled).toBe(true);
  });
});
