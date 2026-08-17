import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { TerminalPane } from "./TerminalPane";
import * as transport from "../lib/pty/transport";
import * as opener from "@tauri-apps/plugin-opener";

// xterm's Terminal and Addons are mocked so the test asserts the wiring contract
// (store session -> write -> ack -> resize -> kill, plus addons and search).
const xtermState = vi.hoisted(() => ({
  instances: [] as {
    cols: number;
    rows: number;
    unicode: { activeVersion: string };
    write: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onWriteParsed: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    customKeyHandler?: (event: KeyboardEvent) => boolean;
  }[],
}));

const addonState = vi.hoisted(() => ({
  unicode11Instances: [] as unknown[],
  searchInstances: [] as unknown[],
  serializeInstances: [] as { serialize: ReturnType<typeof vi.fn> }[],
  webLinksInstances: [] as { handler?: (event: MouseEvent, uri: string) => void }[],
  webglInstances: [] as { onContextLoss: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; contextLossCallback?: () => void }[],
  canvasInstances: [] as unknown[],
}));

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "6" };
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn();
    writeln = vi.fn();
    clear = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn((fn: (event: KeyboardEvent) => boolean) => {
      this.customKeyHandler = fn;
    });
    getSelection = vi.fn().mockReturnValue("");
    focus = vi.fn();
    dispose = vi.fn();
    customKeyHandler?: (event: KeyboardEvent) => boolean;
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

vi.mock("@xterm/addon-unicode11", () => {
  class MockUnicode11Addon {
    constructor() {
      addonState.unicode11Instances.push(this);
    }
  }
  return { Unicode11Addon: MockUnicode11Addon };
});

vi.mock("@xterm/addon-search", () => {
  class MockSearchAddon {
    findNext = vi.fn();
    findPrevious = vi.fn();
    clearDecorations = vi.fn();
    constructor() {
      addonState.searchInstances.push(this);
    }
  }
  return { SearchAddon: MockSearchAddon };
});

vi.mock("@xterm/addon-serialize", () => {
  class MockSerializeAddon {
    serialize = vi.fn().mockReturnValue("mocked-serialized-buffer");
    constructor() {
      addonState.serializeInstances.push(this);
    }
  }
  return { SerializeAddon: MockSerializeAddon };
});

vi.mock("@xterm/addon-web-links", () => {
  class MockWebLinksAddon {
    handler?: (event: MouseEvent, uri: string) => void;
    constructor(handler?: (event: MouseEvent, uri: string) => void) {
      this.handler = handler;
      addonState.webLinksInstances.push(this);
    }
  }
  return { WebLinksAddon: MockWebLinksAddon };
});

vi.mock("@xterm/addon-webgl", () => {
  class MockWebglAddon {
    onContextLoss = vi.fn((cb: () => void) => {
      this.contextLossCallback = cb;
    });
    dispose = vi.fn();
    contextLossCallback?: () => void;
    constructor() {
      addonState.webglInstances.push(this);
    }
  }
  return { WebglAddon: MockWebglAddon };
});

vi.mock("@xterm/addon-canvas", () => {
  class MockCanvasAddon {
    constructor() {
      addonState.canvasInstances.push(this);
    }
  }
  return { CanvasAddon: MockCanvasAddon };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);
const ptyWriteMock = vi.mocked(transport.ptyWrite);
const ptyResizeMock = vi.mocked(transport.ptyResize);
const ptyAckMock = vi.mocked(transport.ptyAck);
const ptyKillMock = vi.mocked(transport.ptyKill);
const saveScrollbackMock = vi.mocked(transport.saveScrollback);
const onPtyDataMock = vi.mocked(transport.onPtyData);
const onPtyExitMock = vi.mocked(transport.onPtyExit);
const openUrlMock = vi.mocked(opener.openUrl);

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
    addonState.unicode11Instances.length = 0;
    addonState.searchInstances.length = 0;
    addonState.serializeInstances.length = 0;
    addonState.webLinksInstances.length = 0;
    addonState.webglInstances.length = 0;
    addonState.canvasInstances.length = 0;
    roState.callback = null;
    // Fresh store: the pane under test renders the "abc" session.
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
      layout: { type: "leaf", id: "abc" },
      serializers: {},
      cachedScrollbacks: {},
      restoredScrollbacks: {},
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
    vi.useRealTimers();
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

  it("does not recreate the terminal when a ResizeObserver callback fires (no resize feedback loop)", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();
    expect(xtermState.instances.length).toBe(1);

    fireResize();
    fireResize();
    await vi.waitFor(() => expect(ptyResizeMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(xtermState.instances.length).toBe(1);
    expect(xtermState.instances[0]!.dispose).not.toHaveBeenCalled();
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
    expect(xtermState.instances.length).toBe(0);
    expect(onPtyDataMock).not.toHaveBeenCalled();
  });

  it("renders the real error message when the session carries one", () => {
    useTerminalStore.setState({
      sessions: {
        err: {
          id: "err",
          title: "err",
          status: "error",
          error: "failed to spawn pty session: shell not found",
          cols: 80,
          rows: 24,
        },
      },
    });
    const { container } = render(<TerminalPane id="err" />);
    const pane = container.querySelector(".terminal-pane")!;
    expect(pane.textContent).toContain("failed to spawn pty session: shell not found");
    expect(pane.textContent).not.toContain("session failed to start");
    expect(xtermState.instances.length).toBe(0);
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
    dataHandler({ id: "abc", data: "hello", seq: 1 });
    dataHandler({ id: "abc", data: "!\r\n", seq: 2 });
    expect(term().write).toHaveBeenNthCalledWith(1, "hello");
    expect(term().write).toHaveBeenNthCalledWith(2, "!\r\n");

    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();
    expect(ptyAckMock).toHaveBeenCalledTimes(1);
    expect(ptyAckMock).toHaveBeenCalledWith("abc", 8);
  });

  it("keeps rendering the session after the id prop changes", async () => {
    const { rerender } = render(<TerminalPane id="abc" />);
    await waitForSpawned();
    expect(term().write).not.toHaveBeenCalled();

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

  it("loads Unicode11Addon, SearchAddon, WebLinksAddon, SerializeAddon, and WebglAddon and activates unicode 11", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    expect(addonState.unicode11Instances.length).toBe(1);
    expect(term().unicode.activeVersion).toBe("11");
    expect(addonState.searchInstances.length).toBe(1);
    expect(addonState.webLinksInstances.length).toBe(1);
    expect(addonState.serializeInstances.length).toBe(1);
    expect(addonState.webglInstances.length).toBe(1);
    expect(term().loadAddon).toHaveBeenCalledTimes(6); // fit, unicode11, search, webLinks, serialize, webgl
  });

  it("registers serializer in store on mount and unregisters on unmount", async () => {
    const { unmount } = render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const serializer = useTerminalStore.getState().serializers["abc"];
    expect(serializer).toBeDefined();
    expect(serializer?.()).toBe("mocked-serialized-buffer");

    unmount();
    expect(useTerminalStore.getState().serializers["abc"]).toBeUndefined();
  });

  it("caches serialized buffer into store on unmount for background tabs", async () => {
    const { unmount } = render(<TerminalPane id="abc" />);
    await waitForSpawned();

    unmount();
    expect(useTerminalStore.getState().cachedScrollbacks["abc"]).toBe("mocked-serialized-buffer");
    expect(saveScrollbackMock).toHaveBeenCalledWith("abc", "mocked-serialized-buffer");
  });

  it("debounces saving scrollback to disk and caching in store after terminal write parsed events", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    vi.useFakeTimers();
    expect(saveScrollbackMock).not.toHaveBeenCalled();

    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();

    // Before 500ms debounce
    vi.advanceTimersByTime(400);
    expect(saveScrollbackMock).not.toHaveBeenCalled();

    // Another parsed event resets debounce timer
    parsedHandler();
    vi.advanceTimersByTime(400);
    expect(saveScrollbackMock).not.toHaveBeenCalled();

    // After remaining time
    vi.advanceTimersByTime(100);
    expect(saveScrollbackMock).toHaveBeenCalledWith("abc", "mocked-serialized-buffer");
    expect(useTerminalStore.getState().cachedScrollbacks["abc"]).toBe("mocked-serialized-buffer");
  });

  it("flushes scrollback immediately to disk and cancels pending debounce timer on unmount", async () => {
    const { unmount } = render(<TerminalPane id="abc" />);
    await waitForSpawned();

    vi.useFakeTimers();
    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();

    expect(saveScrollbackMock).not.toHaveBeenCalled();

    unmount();
    expect(saveScrollbackMock).toHaveBeenCalledTimes(1);
    expect(saveScrollbackMock).toHaveBeenCalledWith("abc", "mocked-serialized-buffer");
    expect(useTerminalStore.getState().cachedScrollbacks["abc"]).toBe("mocked-serialized-buffer");

    // Advancing timers should not cause another saveScrollback call
    vi.advanceTimersByTime(1000);
    expect(saveScrollbackMock).toHaveBeenCalledTimes(1);
  });

  it("replays restored scrollback, prints Session Restored banner, and clears restored state on mount", async () => {
    useTerminalStore.setState({
      restoredScrollbacks: { abc: "saved lines\r\n" },
    });

    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    expect(term().write).toHaveBeenCalledWith("saved lines\r\n");
    expect(term().writeln).toHaveBeenCalledWith(
      "\r\n\x1b[2m── [Session Restored] ──────────────────────────────────────\x1b[0m\r\n",
    );
    expect(useTerminalStore.getState().restoredScrollbacks["abc"]).toBeUndefined();
  });

  it("opens search overlay with selected text when Ctrl+F or Cmd+F is pressed in terminal", async () => {
    const { container } = render(<TerminalPane id="abc" />);
    await waitForSpawned();

    expect(container.querySelector(".terminal-search-overlay")).toBeNull();

    term().getSelection.mockReturnValue("selected_query");

    const preventDefault = vi.fn();
    const handled = term().customKeyHandler?.({
      ctrlKey: true,
      metaKey: false,
      key: "f",
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(container.querySelector(".terminal-search-overlay")).not.toBeNull();
    });

    const searchInput = screen.getByRole("textbox", { name: /find in terminal/i }) as HTMLInputElement;
    expect(searchInput.value).toBe("selected_query");
  });

  it("closes search overlay on Escape and refocuses the terminal", async () => {
    const { container } = render(<TerminalPane id="abc" />);
    await waitForSpawned();

    // Open search
    act(() => {
      term().customKeyHandler?.({
        ctrlKey: true,
        metaKey: false,
        key: "f",
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent);
    });

    expect(container.querySelector(".terminal-search-overlay")).not.toBeNull();

    // Press Escape via terminal custom key handler
    const preventDefault = vi.fn();
    act(() => {
      term().customKeyHandler?.({
        ctrlKey: false,
        metaKey: false,
        key: "Escape",
        preventDefault,
      } as unknown as KeyboardEvent);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(container.querySelector(".terminal-search-overlay")).toBeNull();
    expect(term().focus).toHaveBeenCalled();
  });

  it("handles WebGL context loss by falling back to CanvasAddon", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const webglInstance = addonState.webglInstances[0]!;
    expect(webglInstance.onContextLoss).toHaveBeenCalled();

    // Trigger context loss
    act(() => {
      webglInstance.contextLossCallback?.();
    });

    expect(webglInstance.dispose).toHaveBeenCalled();
    expect(addonState.canvasInstances.length).toBe(1);
  });

  it("opens URL via Tauri opener on link click with window.open fallback", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const webLinksInstance = addonState.webLinksInstances[0]!;
    expect(webLinksInstance.handler).toBeDefined();

    webLinksInstance.handler?.({} as MouseEvent, "https://example.com");
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
  });

  it("renders TerminalPaneHeader at the top of the terminal pane wrapper", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "my-custom-title", status: "running", cols: 80, rows: 24 },
      },
    });
    const { container } = render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const header = container.querySelector(".terminal-pane-header");
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain("my-custom-title");
  });

  it("clears terminal buffer and cached scrollback when Clear Scrollback is invoked from header menu", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
      cachedScrollbacks: {
        abc: "existing buffer",
      },
    });
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    // Open More Options dropdown menu
    const moreBtn = screen.getByRole("button", { name: /more options/i });
    fireEvent.click(moreBtn);

    // Click "Clear Scrollback"
    const clearBtn = screen.getByText("Clear Scrollback");
    fireEvent.click(clearBtn);

    expect(term().clear).toHaveBeenCalled();
    expect(useTerminalStore.getState().cachedScrollbacks["abc"]).toBe("");
    expect(saveScrollbackMock).toHaveBeenCalledWith("abc", "");
  });
});
