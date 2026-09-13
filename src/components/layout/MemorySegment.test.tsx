import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { MemorySegment } from "./MemorySegment";
import * as systemTransport from "../../lib/system/transport";
import * as ptyTransport from "../../lib/pty/transport";

vi.mock("../../lib/system/transport", () => ({
  getSystemMemorySnapshot: vi.fn(),
}));

vi.mock("../../lib/pty/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/pty/transport")>();
  return { ...actual, ptyKill: vi.fn() };
});

const mockSnapshot = vi.mocked(systemTransport.getSystemMemorySnapshot);
const mockKill = vi.mocked(ptyTransport.ptyKill);

function snapshot() {
  return {
    app: { cpu: 2.5, memory: 200 * 1024 * 1024 },
    daemon: { cpu: 0.5, memory: 79 * 1024 * 1024 },
    sessions: [
      { session_id: "s1", pid: 111, cpu: 1.5, memory: 300 * 1024 * 1024 },
      { session_id: "s2", pid: 222, cpu: null, memory: null },
    ],
    host: {
      total: 16 * 1024 * 1024 * 1024,
      available: 8 * 1024 * 1024 * 1024,
      used: 8 * 1024 * 1024 * 1024,
      percent: 50,
    },
    total_memory: 500 * 1024 * 1024,
    total_cpu: 4.0,
    collected_at_ms: 1,
  };
}

function seedSessions() {
  useTerminalStore.setState({
    sessions: {
      s1: { id: "s1", title: "shell", status: "running", cwd: "/ws/a", cols: 80, rows: 24 },
      s2: { id: "s2", title: "agent", status: "running", cwd: "/ws/b", cols: 80, rows: 24 },
    },
    tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
    activeTabId: "tab-1",
  } as unknown as Record<string, unknown>);
}

describe("MemorySegment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedSessions();
    mockSnapshot.mockResolvedValue(snapshot());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds one snapshot on mount for the closed chip", async () => {
    render(<MemorySegment />);
    const chip = await screen.findByTestId("memory-segment");
    expect(chip.textContent).toContain("MB");
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
  });

  it("shows a dash when the snapshot is unavailable", async () => {
    mockSnapshot.mockResolvedValue(null);
    render(<MemorySegment />);
    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("opens an Orca-like breakdown grouped by session on click", async () => {
    render(<MemorySegment />);
    fireEvent.click(await screen.findByTestId("memory-segment"));
    expect(await screen.findByTestId("memory-popover")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    // Null per-session sample renders a dash, never crashes sorting.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("polls every 2s only while the popover is open", async () => {
    vi.useFakeTimers();
    render(<MemorySegment />);
    // Flush the mount seed.
    await act(async () => {});
    expect(mockSnapshot).toHaveBeenCalledTimes(1);

    // Closed: advancing time must not poll (Orca open-gating perf rule).
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mockSnapshot).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("memory-segment"));
    // WHY getBy not findBy: fake timers freeze findBy's waitFor polling.
    expect(screen.getByTestId("memory-popover")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(mockSnapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("kill button removes the session via ptyKill", async () => {
    mockKill.mockResolvedValue(undefined);
    render(<MemorySegment />);
    fireEvent.click(await screen.findByTestId("memory-segment"));
    const kill = await screen.findByTestId("memory-kill-s1");
    fireEvent.click(kill);
    expect(mockKill).toHaveBeenCalledWith("s1");
  });

  it("shows the detached daemon row when the backend reports one", async () => {
    render(<MemorySegment />);
    fireEvent.click(await screen.findByTestId("memory-segment"));
    expect(await screen.findByText("Oppa daemon")).toBeInTheDocument();
    // 79MB formatted at Orca's 1-decimal MB precision.
    expect(screen.getByText("79.0 MB")).toBeInTheDocument();
    // Daemon row is display-only: no kill affordance for it.
    expect(screen.queryByTestId("memory-kill-daemon")).toBeNull();
  });

  it("omits the daemon row on old backends that never report one", async () => {
    // Destructure the field away to simulate a pre-daemon backend payload.
    const { daemon: _legacy, ...legacySnap } = snapshot();
    mockSnapshot.mockResolvedValue(legacySnap);
    render(<MemorySegment />);
    fireEvent.click(await screen.findByTestId("memory-segment"));
    expect(await screen.findByTestId("memory-popover")).toBeInTheDocument();
    expect(screen.queryByText("Oppa daemon")).toBeNull();
  });
});
