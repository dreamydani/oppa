import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { TerminalScrollbar } from "./TerminalScrollbar";

function makeViewport(opts: Partial<{ scrollHeight: number; clientHeight: number; scrollTop: number }> = {}) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: opts.scrollHeight ?? 1000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: opts.clientHeight ?? 400, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: opts.scrollTop ?? 0, writable: true, configurable: true });
  return el;
}

describe("TerminalScrollbar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("renders nothing when content does not overflow", () => {
    const viewport = makeViewport({ scrollHeight: 400, clientHeight: 400 });
    const { queryByTestId } = render(<TerminalScrollbar viewport={viewport} />);
    expect(queryByTestId("terminal-scrollbar")).toBeNull();
  });

  it("renders and sizes the thumb from the scroll ratio", () => {
    const viewport = makeViewport({ scrollHeight: 1000, clientHeight: 400 });
    const { getByTestId } = render(<TerminalScrollbar viewport={viewport} />);
    const track = getByTestId("terminal-scrollbar");
    expect(track).toBeTruthy();
    const thumb = getByTestId("terminal-scrollbar-thumb") as HTMLElement;
    // ratio 0.4 -> clamped to min 8%? no: 40% > min, so height 40%
    expect(thumb.style.height).toBe("40%");
    expect(track.className).not.toContain("shown");
  });

  it("becomes visible on scroll and hides after idle timeout", async () => {
    const viewport = makeViewport({});
    const { getByTestId } = render(<TerminalScrollbar viewport={viewport} />);
    const track = getByTestId("terminal-scrollbar");
    act(() => {
      (viewport as HTMLElement).dispatchEvent(new Event("scroll"));
    });
    expect(track.className).toContain("shown");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(track.className).not.toContain("shown");
  });

  it("stays hidden when forced (alternate buffer)", () => {
    const viewport = makeViewport({});
    render(<TerminalScrollbar viewport={viewport} forceHidden />);
    expect(document.querySelector('[data-testid="terminal-scrollbar"]')).toBeNull();
  });

  it("dragging maps pointer travel to scrollTop", () => {
    const viewport = makeViewport({});
    const { getByTestId } = render(<TerminalScrollbar viewport={viewport} />);
    const track = getByTestId("terminal-scrollbar") as HTMLElement;
    // place track at a known rect
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      top: 0, left: 0, right: 10, bottom: 400, width: 10, height: 400,
      x: 0, y: 0, toJSON: () => {},
    } as DOMRect);
    fireEvent.pointerDown(track, { clientY: 200, button: 0, preventDefault() {}, stopPropagation() {} });
    // thumb is 40% of 400 = 160px tall; maxTravel=240; centerY drag to 200 => y=120 => frac .5
    expect(viewport.scrollTop).toBeCloseTo(300); // 50% of maxScroll 600
    window.dispatchEvent(new Event("pointerup"));
  });
});
