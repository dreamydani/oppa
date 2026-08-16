import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { PaneSplit } from "./PaneSplit";
import * as transport from "../lib/pty/transport";

// The recursive structure is the unit under test; TerminalPane's xterm
// wiring is covered by its own suite. Mocking it here keeps the layout
// tests focused on panes/divider/focus.
vi.mock("./TerminalPane", () => ({
  TerminalPane: ({ id }: { id: string }) => (
    <div className="terminal-pane" data-session-id={id} />
  ),
}));

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);

describe("PaneSplit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptySpawnMock.mockResolvedValue("s1");
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

    // Divider is 100px wide: dragging 25px to the right moves a's share to
    // (50 + 25) / 100 = 0.75.
    fireEvent.mouseDown(divider, { clientX: 50, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 75 });
    fireEvent.mouseUp(window);

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
    fireEvent.mouseDown(divider, { clientX: 50, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 75 });
    fireEvent.mouseUp(window);

    const after = useTerminalStore.getState().layout;
    if (after.type !== "split") throw new Error("expected split root");
    fireEvent.mouseMove(window, { clientX: 0 });
    const final = useTerminalStore.getState().layout;
    if (final.type !== "split") throw new Error("expected split root");
    expect(final.ratio).toBe(after.ratio);
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
});
