import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { TerminalPane } from "./TerminalPane";
import * as transport from "../lib/pty/transport";

// xterm's Terminal is mocked so the test asserts the wiring contract
// (spawn -> write -> ack -> resize -> kill) without a real terminal buffer.
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
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  ptyAck: vi.fn(),
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
    ptySpawnMock.mockResolvedValue("abc");
    onPtyDataMock.mockResolvedValue(vi.fn());
    onPtyExitMock.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function term() {
    return xtermState.instances[0]!;
  }

  // Wait until the spawn promise's .then has run (idRef set, listeners wired).
  async function waitForSpawned() {
    await vi.waitFor(() => expect(onPtyDataMock).toHaveBeenCalled());
  }

  it("mounts a terminal container and spawns a pty session", async () => {
    const { container } = render(<TerminalPane />);
    expect(container.querySelector(".terminal-pane")).not.toBeNull();
    await vi.waitFor(() => expect(ptySpawnMock).toHaveBeenCalled());
    expect(term().open).toHaveBeenCalled();
    expect(term().loadAddon).toHaveBeenCalled();
  });

  it("renders pty output through term.write and acks the parsed char count", async () => {
    render(<TerminalPane />);
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
    render(<TerminalPane />);
    await waitForSpawned();

    const dataHandler = term().onData.mock.calls[0][0] as (data: string) => void;
    dataHandler("ls\r");
    expect(ptyWriteMock).toHaveBeenCalledWith("abc", "ls\r");
  });

  it("resizes the pty via FitAddon when the container resizes", async () => {
    render(<TerminalPane />);
    await waitForSpawned();

    term().cols = 120;
    term().rows = 40;
    fireResize();
    expect(ptyResizeMock).toHaveBeenCalledWith("abc", 120, 40);
  });

  it("shows a one-line error state when spawn fails", async () => {
    ptySpawnMock.mockRejectedValue(new Error("shell not found"));
    render(<TerminalPane />);
    await vi.waitFor(() =>
      expect(term().writeln).toHaveBeenCalledWith(
        "\r\n[spawn failed: shell not found]",
      ),
    );
  });

  it("prints an exit message when the session dies", async () => {
    render(<TerminalPane />);
    await waitForSpawned();

    const exitHandler = onPtyExitMock.mock.calls[0][0] as (p: {
      id: string;
      code: number | null;
    }) => void;
    exitHandler({ id: "abc", code: 0 });
    expect(term().writeln).toHaveBeenCalledWith("\r\n[process exited: 0]");
  });

  it("kills the pty and disposes the terminal on unmount", async () => {
    const { unmount } = render(<TerminalPane />);
    await waitForSpawned();

    unmount();
    expect(ptyKillMock).toHaveBeenCalledWith("abc");
    expect(term().dispose).toHaveBeenCalled();
  });

  it("does not ack when onWriteParsed fires with nothing written", async () => {
    render(<TerminalPane />);
    await waitForSpawned();

    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();
    expect(ptyAckMock).not.toHaveBeenCalled();
  });

  it("acks the cumulative parsed chars when chunks arrive before one parse", async () => {
    render(<TerminalPane />);
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

  it("kills the session and skips wiring when spawn resolves after unmount", async () => {
    let resolveSpawn!: (id: string) => void;
    ptySpawnMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const { unmount } = render(<TerminalPane />);
    unmount();

    resolveSpawn("late-id");
    await vi.waitFor(() =>
      expect(ptyKillMock).toHaveBeenCalledWith("late-id"),
    );

    expect(onPtyDataMock).not.toHaveBeenCalled();
    expect(onPtyExitMock).not.toHaveBeenCalled();
    expect(term().onData).not.toHaveBeenCalled();
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it("unsubscribes a listener whose registration resolves after unmount", async () => {
    let resolveDataListen!: (unlisten: () => void) => void;
    onPtyDataMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveDataListen = resolve;
      }),
    );

    const unlistenData = vi.fn();
    const { unmount } = render(<TerminalPane />);
    await waitForSpawned();
    unmount();

    resolveDataListen(unlistenData);
    await vi.waitFor(() => expect(unlistenData).toHaveBeenCalled());
    expect(unlistenData).toHaveBeenCalledTimes(1);
  });
});
