import { beforeEach, describe, expect, it } from "vitest";
import {
  setFocusedPane,
  setHoveredPane,
  getPanePriority,
  resetPanePriorityForTests,
} from "./panePriority";

describe("panePriority", () => {
  beforeEach(() => {
    resetPanePriorityForTests();
  });

  it("defaults every pane to background", () => {
    expect(getPanePriority("p1")).toBe("background");
  });

  it("focused pane is prioritized", () => {
    setFocusedPane("p1");
    expect(getPanePriority("p1")).toBe("focused");
  });

  it("hovered pane is medium priority, below focused", () => {
    setFocusedPane("p1");
    setHoveredPane("p2");
    expect(getPanePriority("p1")).toBe("focused");
    expect(getPanePriority("p2")).toBe("hovered");
    expect(getPanePriority("p3")).toBe("background");
  });

  it("focusing the hovered pane upgrades it to focused", () => {
    setHoveredPane("p1");
    setFocusedPane("p1");
    expect(getPanePriority("p1")).toBe("focused");
  });

  it("clearing hover returns the pane to background", () => {
    setHoveredPane("p1");
    expect(getPanePriority("p1")).toBe("hovered");
    setHoveredPane(null);
    expect(getPanePriority("p1")).toBe("background");
  });

  it("clearing focus returns all panes to hovered/background", () => {
    setFocusedPane("p1");
    setHoveredPane("p2");
    setFocusedPane(null);
    expect(getPanePriority("p1")).toBe("background");
    expect(getPanePriority("p2")).toBe("hovered");
  });
});
