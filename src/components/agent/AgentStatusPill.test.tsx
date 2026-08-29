import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AgentStatusPill } from "./AgentStatusPill";
import type { AgentStatusEntry } from "../../lib/pty/transport";

function entry(state: AgentStatusEntry["state"], overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state,
    state_started_at_ms: 1,
    updated_at_ms: 2,
    origin: "hook",
    ...overrides,
  };
}

describe("AgentStatusPill", () => {
  it("renders nothing without a hook row so hookless shells keep their legacy dot", () => {
    const { container } = render(<AgentStatusPill />);
    expect(container.querySelector(".agent-status-pill")).toBeNull();
    expect(container.childElementCount).toBe(0);
  });

  it("working: pulsing pill with spinner and tool-name tooltip", () => {
    const { container } = render(
      <AgentStatusPill entry={entry("working", { tool_name: "Edit" })} />,
    );
    const pill = container.querySelector<HTMLElement>(".agent-status-pill")!;
    expect(pill.dataset.state).toBe("working");
    expect(pill.classList.contains("agent-status-working")).toBe(true);
    expect(container.querySelector(".agent-status-spinner")).not.toBeNull();
    expect(pill.getAttribute("title")).toBe("Working — Edit");
  });

  it("blocked: amber pill surfacing the literal interactive prompt", () => {
    const prompt = "Allow write access to /tmp?";
    const { container } = render(
      <AgentStatusPill entry={entry("blocked", { interactive_prompt: prompt })} />,
    );
    const pill = container.querySelector<HTMLElement>(".agent-status-pill")!;
    expect(pill.dataset.state).toBe("blocked");
    expect(pill.classList.contains("agent-status-blocked")).toBe(true);
    expect(pill.getAttribute("title")).toBe(`Blocked: ${prompt}`);
  });

  it("waiting: hollow pill surfacing the question it is stuck on", () => {
    const prompt = "Run tests before commit?";
    const { container } = render(
      <AgentStatusPill entry={entry("waiting", { interactive_prompt: prompt })} />,
    );
    const pill = container.querySelector<HTMLElement>(".agent-status-pill")!;
    expect(pill.dataset.state).toBe("waiting");
    expect(pill.getAttribute("title")).toBe(`Waiting: ${prompt}`);
  });

  it("done: emerald pill; interrupted variant flags the cancel", () => {
    const { container } = render(<AgentStatusPill entry={entry("done")} />);
    const pill = container.querySelector<HTMLElement>(".agent-status-pill")!;
    expect(pill.dataset.state).toBe("done");
    expect(pill.getAttribute("title")).toBe("Done");

    const { container: interrupted } = render(
      <AgentStatusPill entry={entry("done", { interrupted: true })} />,
    );
    const ipill = interrupted.querySelector<HTMLElement>(".agent-status-pill")!;
    expect(ipill.classList.contains("agent-status-interrupted")).toBe(true);
    expect(ipill.getAttribute("title")).toBe("Interrupted");
  });

  it("unread flag draws the attention dot only when asked", () => {
    const { container } = render(
      <AgentStatusPill entry={entry("waiting")} unread />,
    );
    expect(container.querySelector(".agent-status-unread-dot")).not.toBeNull();

    const { container: read } = render(
      <AgentStatusPill entry={entry("waiting")} />,
    );
    expect(read.querySelector(".agent-status-unread-dot")).toBeNull();
  });

  it("renders compact elapsed time since the state began", () => {
    const now = Date.now();
    const cases: Array<[number, string]> = [
      [now - 25_000, "now"],
      [now - 90_000, "1m"],
      [now - 12 * 60_000, "12m"],
      [now - 3 * 3_600_000, "3h"],
      [now - 2 * 86_400_000, "2d"],
    ];
    for (const [startedAt, expected] of cases) {
      const { container } = render(
        <AgentStatusPill entry={entry("working", { state_started_at_ms: startedAt })} />,
      );
      const elapsed = container.querySelector<HTMLElement>(".agent-status-elapsed")!;
      expect(elapsed.textContent).toBe(expected);
    }
  });

  it("appends the elapsed span after the state content without breaking tooltips", () => {
    const started = Date.now() - 5 * 60_000;
    const { container } = render(
      <AgentStatusPill entry={entry("working", { tool_name: "Edit", state_started_at_ms: started })} />,
    );
    const pill = container.querySelector<HTMLElement>(".agent-status-pill")!;
    expect(pill.querySelector(".agent-status-elapsed")!.textContent).toBe("5m");
    // Tooltip keeps the state description; the elapsed span is display-only.
    expect(pill.getAttribute("title")).toBe("Working — Edit");
  });
});