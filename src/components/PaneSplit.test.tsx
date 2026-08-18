import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { PaneSplit } from "./PaneSplit";
import * as transport from "../lib/pty/transport";

// The recursive structure is the unit under test; TerminalPane's xterm
// wiring is covered by its own suite. Mocking it here keeps the layout
// tests focused on panes/divider/focus.
vi.mock("./TerminalPane", () => ({
  TerminalPane: ({ id, path }: { id: string; path?: number[] }) => (
    <div className="terminal-pane" data-session-id={id} data-path={path?.join(".")} />
  ),
}));

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);

describe("PaneSplit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptySpawnMock.mockResolvedValue({ id: "s1", is_new: true, pid: 100 });
  });

  function setSessions(ids: string[]) {
    useTerminalStore.setState({
      sessions: Object.fromEntries(
        ids.map((id) => [
          id,
          { id, title: id, status: "running" as const, cols: 80, rows: 24 },
        ]),
      ),
    });
  }

  it("renders every leaf of a horizontal split with a divider", () => {
    setSessions(["a", "b"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
    });

    const { container } = render(<PaneSplit />);
    const panes = container.querySelectorAll(".terminal-pane");
    expect(panes).toHaveLength(2);
    // h = side-by-side panes; the divider sits between them.
    expect(container.querySelector(".pane-divider")).not.toBeNull();
    expect(container.querySelector(".pane-split")!.className).toContain("dir-h");
  });

  it("renders a vertical split as a column", () => {
    setSessions(["a", "b"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
    });

    const { container } = render(<PaneSplit />);
    expect(container.querySelectorAll(".terminal-pane")).toHaveLength(2);
    expect(container.querySelector(".pane-split")!.className).toContain("dir-v");
  });

  it("renders a single leaf without a divider", () => {
    setSessions(["a"]);
    useTerminalStore.setState({ layout: { type: "leaf", id: "a" } });

    const { container } = render(<PaneSplit />);
    expect(container.querySelectorAll(".terminal-pane")).toHaveLength(1);
    expect(container.querySelector(".pane-divider")).toBeNull();
  });

  it("renders nested splits recursively", () => {
    setSessions(["a", "b", "c"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: {
          type: "split",
          dir: "v",
          ratio: 0.5,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
        b: { type: "leaf", id: "c" },
      },
    });

    const { container } = render(<PaneSplit />);
    expect(container.querySelectorAll(".terminal-pane")).toHaveLength(3);
    expect(container.querySelectorAll(".pane-divider")).toHaveLength(2);
  });

  it("drag updates the split ratio in the store", () => {
    setSessions(["a", "b"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
    });

    const { container } = render(<PaneSplit />);
    const divider = container.querySelector(".pane-divider")!;

    // The divider measures the split container (100px) to convert the cursor
    // delta into a ratio.
    vi.spyOn(
      divider.parentElement!.parentElement!,
      "getBoundingClientRect",
    ).mockReturnValue({
      width: 100,
      height: 100,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const capture = vi.spyOn(divider, "setPointerCapture");
    const release = vi.spyOn(divider, "releasePointerCapture");

    // Divider is 100px wide: dragging 25px to the right moves a's share to
    // (50 + 25) / 100 = 0.75.
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 50, buttons: 1 });
    expect(capture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 75 });
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 75 });
    expect(release).toHaveBeenCalledWith(1);

    const ratio = useTerminalStore.getState().layout;
    if (ratio.type !== "split") throw new Error("expected split root");
    expect(ratio.ratio).toBeGreaterThan(0.7);
    expect(ratio.ratio).toBeLessThan(0.8);
  });

  it("does not update the ratio after the drag ends", () => {
    setSessions(["a", "b"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
    });

    const { container } = render(<PaneSplit />);
    const divider = container.querySelector(".pane-divider")!;
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 50, buttons: 1 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 75 });
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 75 });

    const after = useTerminalStore.getState().layout;
    if (after.type !== "split") throw new Error("expected split root");
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 0 });
    const final = useTerminalStore.getState().layout;
    if (final.type !== "split") throw new Error("expected split root");
    expect(final.ratio).toBe(after.ratio);
  });

  it("cleans up drag listeners when the window blurs mid-drag (no leak)", () => {
    setSessions(["a", "b"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
    });

    const { container } = render(<PaneSplit />);
    const divider = container.querySelector(".pane-divider")!;
    const release = vi.spyOn(divider, "releasePointerCapture");

    // Start a drag, then the window loses focus before any mouseup (e.g. the
    // user alt-tabs). Releasing outside the window must not leak listeners:
    // a later pointermove must not keep mutating the ratio.
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 50, buttons: 1 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 75 });
    fireEvent.blur(window);
    expect(release).toHaveBeenCalledWith(1);

    const afterBlur = useTerminalStore.getState().layout;
    if (afterBlur.type !== "split") throw new Error("expected split root");
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 0 });
    const afterMove = useTerminalStore.getState().layout;
    if (afterMove.type !== "split") throw new Error("expected split root");
    expect(afterMove.ratio).toBe(afterBlur.ratio);
  });

  it("clicking a leaf focuses its path", () => {
    setSessions(["a", "b"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
      focusedPath: [0],
    });

    const { container } = render(<PaneSplit />);
    const panes = container.querySelectorAll(".terminal-pane");
    fireEvent.mouseDown(panes[1]!);
    expect(useTerminalStore.getState().focusedPath).toEqual([1]);
  });

  it("passes path to session leaves in split hierarchy", () => {
    setSessions(["a", "b"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
    });

    const { container } = render(<PaneSplit />);
    const panes = container.querySelectorAll(".terminal-pane");
    expect(panes[0]?.getAttribute("data-path")).toBe("0");
    expect(panes[1]?.getAttribute("data-path")).toBe("1");
  });

  it("renders only the maximized leaf when maximizedSessionId is active in layout", () => {
    setSessions(["a", "b"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
      maximizedSessionId: "b",
    });

    const { container } = render(<PaneSplit />);
    const panes = container.querySelectorAll(".terminal-pane");
    expect(panes).toHaveLength(1);
    expect(panes[0]?.getAttribute("data-session-id")).toBe("b");
    expect(container.querySelector(".pane-divider")).toBeNull();
    const leaf = container.querySelector(".pane-leaf");
    expect(leaf?.className).toContain("maximized");
    expect(leaf?.className).toContain("focused");
  });

  it("falls back to normal split layout when maximizedSessionId does not exist in layout", () => {
    setSessions(["a", "b"]);
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
      maximizedSessionId: "nonexistent",
    });

    const { container } = render(<PaneSplit />);
    const panes = container.querySelectorAll(".terminal-pane");
    expect(panes).toHaveLength(2);
    expect(container.querySelector(".pane-divider")).not.toBeNull();
  });
});
