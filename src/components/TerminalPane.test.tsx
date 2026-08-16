import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { TerminalPane } from "./TerminalPane";
import * as transport from "../lib/pty/transport";

// xterm's Terminal is mocked so the test asserts the wiring contract
// (store session -> write -> ack -> resize -> kill) without a real buffer.
const xtermState = vi.hoisted(() => ({
  instances: [] as {
    cols: number;
    rows: number;
    write: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onWriteParsed: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn();
    writeln = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    dispose = vi.fn();
    constructor() {
      xtermState.instances.push(this);
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
  }
  return { FitAddon: MockFitAddon };
});

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);
const ptyWriteMock = vi.mocked(transport.ptyWrite);
const ptyResizeMock = vi.mocked(transport.ptyResize);
const ptyAckMock = vi.mocked(transport.ptyAck);
const ptyKillMock = vi.mocked(transport.ptyKill);
const onPtyDataMock = vi.mocked(transport.onPtyData);
const onPtyExitMock = vi.mocked(transport.onPtyExit);

// happy-dom's ResizeObserver never fires; capture the callback so tests can
// trigger a resize the way a browser layout change would.
const roState = vi.hoisted(() => ({ callback: null as null | (() => void) }));

function fireResize() {
  roState.callback?.();
}

describe("TerminalPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xtermState.instances.length = 0;
    roState.callback = null;
    // Fresh store: the pane under test renders the "abc" session.
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
      layout: { type: "leaf", id: "abc" },
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
          roState.callback = callback;
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    onPtyDataMock.mockResolvedValue(vi.fn());
    onPtyExitMock.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function term() {
    return xtermState.instances[0]!;
  }

  // Wait until the listeners have been registered (id wired to the pane).
  async function waitForSpawned() {
    await vi.waitFor(() => expect(onPtyDataMock).toHaveBeenCalled());
  }

  it("renders a terminal container for the store session and does NOT spawn a pty itself", () => {
    const { container } = render(<TerminalPane id="abc" />);
    expect(container.querySelector(".terminal-pane")).not.toBeNull();
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("renders pty output through term.write and acks via the store", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const dataHandler = onPtyDataMock.mock.calls[0][0] as (p: {
      id: string;
      data: string;
      seq: number;
    }) => void;
    dataHandler({ id: "abc", data: "hello\r\n", seq: 1 });
    expect(term().write).toHaveBeenCalledWith("hello\r\n");

    // Simulate xterm finishing parsing: the ACK must fire with the chunk length.
    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();
    expect(ptyAckMock).toHaveBeenCalledWith("abc", "hello\r\n".length);
  });

  it("writes typed data back to the pty", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const dataHandler = term().onData.mock.calls[0][0] as (data: string) => void;
    dataHandler("ls\r");
    expect(ptyWriteMock).toHaveBeenCalledWith("abc", "ls\r");
  });

  it("resizes the pty via FitAddon when the container resizes", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    term().cols = 120;
    term().rows = 40;
    fireResize();
    expect(ptyResizeMock).toHaveBeenCalledWith("abc", 120, 40);
  });

  it("renders the one-line error state when the store session is an error", () => {
    useTerminalStore.setState({
      sessions: {
        err: {
          id: "err",
          title: "err",
          status: "error",
          cols: 80,
          rows: 24,
        },
      },
    });
    const { container } = render(<TerminalPane id="err" />);
    const pane = container.querySelector(".terminal-pane")!;
    expect(pane.textContent).toContain("session failed to start");
    // Error panes are static: no pty listeners, no terminal instance.
    expect(xtermState.instances.length).toBe(0);
    expect(onPtyDataMock).not.toHaveBeenCalled();
  });

  it("renders an empty container when the session id is not yet in the store", () => {
    const { container } = render(<TerminalPane id="ghost" />);
    const pane = container.querySelector(".terminal-pane");
    expect(pane).not.toBeNull();
    expect(pane!.textContent).toBe("");
    expect(xtermState.instances.length).toBe(0);
  });

  it("prints an exit message when the session dies", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const exitHandler = onPtyExitMock.mock.calls[0][0] as (p: {
      id: string;
      code: number | null;
    }) => void;
    exitHandler({ id: "abc", code: 0 });
    expect(term().writeln).toHaveBeenCalledWith("\r\n[process exited: 0]");
  });

  it("ignores pty events addressed to a different session id", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const dataHandler = onPtyDataMock.mock.calls[0][0] as (p: {
      id: string;
      data: string;
      seq: number;
    }) => void;
    dataHandler({ id: "other", data: "nope", seq: 1 });
    expect(term().write).not.toHaveBeenCalled();

    const exitHandler = onPtyExitMock.mock.calls[0][0] as (p: {
      id: string;
      code: number | null;
    }) => void;
    exitHandler({ id: "other", code: 0 });
    expect(term().writeln).not.toHaveBeenCalled();
  });

  it("disposes the terminal on unmount without killing the shared session", async () => {
    const { unmount } = render(<TerminalPane id="abc" />);
    await waitForSpawned();

    unmount();
    expect(term().dispose).toHaveBeenCalled();
    // The session is owned by the store/layout, not the pane: closing one view
    // of it must not kill the session underneath.
    expect(ptyKillMock).not.toHaveBeenCalled();
  });

  it("does not ack when onWriteParsed fires with nothing written", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();
    expect(ptyAckMock).not.toHaveBeenCalled();
  });

  it("acks the cumulative parsed chars when chunks arrive before one parse", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const dataHandler = onPtyDataMock.mock.calls[0][0] as (p: {
      id: string;
      data: string;
      seq: number;
    }) => void;
    // Second chunk lands before xterm's onWriteParsed fires for the first.
    dataHandler({ id: "abc", data: "hello", seq: 1 });
    dataHandler({ id: "abc", data: "!\r\n", seq: 2 });
    expect(term().write).toHaveBeenNthCalledWith(1, "hello");
    expect(term().write).toHaveBeenNthCalledWith(2, "!\r\n");

    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();
    // 5 + 3 = 8 chars parsed since the last ACK — no ACK may be lost.
    expect(ptyAckMock).toHaveBeenCalledTimes(1);
    expect(ptyAckMock).toHaveBeenCalledWith("abc", 8);
  });

  it("keeps rendering the session after the id prop changes", async () => {
    const { rerender } = render(<TerminalPane id="abc" />);
    await waitForSpawned();
    expect(term().write).not.toHaveBeenCalled();

    // New id: a fresh terminal + listeners for the new session. The old
    // terminal is disposed; the shared sessions stay alive.
    useTerminalStore.setState({
      sessions: {
        ...useTerminalStore.getState().sessions,
        def: { id: "def", title: "def", status: "running", cols: 80, rows: 24 },
      },
    });
    rerender(<TerminalPane id="def" />);
    await vi.waitFor(() => expect(xtermState.instances.length).toBe(2));
    expect(xtermState.instances[0]!.dispose).toHaveBeenCalled();

    const dataHandler = onPtyDataMock.mock.calls[1][0] as (p: {
      id: string;
      data: string;
      seq: number;
    }) => void;
    dataHandler({ id: "def", data: "hi", seq: 1 });
    expect(xtermState.instances[1]!.write).toHaveBeenCalledWith("hi");
  });

  it("skips wiring when the id prop changes to a session not in the store", async () => {
    const { rerender } = render(<TerminalPane id="abc" />);
    await waitForSpawned();
    expect(onPtyDataMock).toHaveBeenCalledTimes(1);

    rerender(<TerminalPane id="ghost" />);
    expect(xtermState.instances[0]!.dispose).toHaveBeenCalled();
    // No new listener registered for the missing session.
    expect(onPtyDataMock).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes a listener whose registration resolves after unmount", async () => {
    let resolveDataListen!: (unlisten: () => void) => void;
    onPtyDataMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveDataListen = resolve;
      }),
    );

    const unlistenData = vi.fn();
    const { unmount } = render(<TerminalPane id="abc" />);
    await waitForSpawned();
    unmount();

    resolveDataListen(unlistenData);
    await vi.waitFor(() => expect(unlistenData).toHaveBeenCalled());
    expect(unlistenData).toHaveBeenCalledTimes(1);
  });
});
