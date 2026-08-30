import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { useTerminalStore, DEFAULT_APP_SETTINGS } from "../store/terminalStore";
import { getTerminalTheme } from "../lib/theme/terminalThemes";
import {
  beginLayoutAnimation,
  endLayoutAnimation,
  resetLayoutAnimationGateForTests,
} from "../lib/layout/layoutAnimationGate";
import { resetFitCoordinatorForTests, setFitSchedulerForTests } from "../lib/terminal/fitCoordinator";
import {
  setFrameSchedulerForTests,
  resetFrameSchedulerForTests,
} from "../lib/layout/frameScheduler";
import { TerminalPane } from "./TerminalPane";
import * as transport from "../lib/pty/transport";
import * as layoutTransport from "../lib/layout/transport";
import * as opener from "@tauri-apps/plugin-opener";

// xterm's Terminal and Addons are mocked so the test asserts the wiring contract
// (store session -> write -> ack -> resize -> kill, plus addons and search).
const xtermState = vi.hoisted(() => ({
  instances: [] as {
    cols: number;
    rows: number;
    unicode: { activeVersion: string };
    modes: { mouseTrackingMode: string; applicationCursorKeysMode: boolean };
    buffer: { active: { type: string } };
    options: Record<string, any>;
    write: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onWriteParsed: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    attachCustomWheelEventHandler: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    customKeyHandler?: (event: KeyboardEvent) => boolean;
    customWheelHandler?: (event: WheelEvent) => boolean;
  }[],
}));

const addonState = vi.hoisted(() => ({
  fitInstances: [] as { fit: ReturnType<typeof vi.fn> }[],
  unicode11Instances: [] as unknown[],
  searchInstances: [] as unknown[],
  serializeInstances: [] as { serialize: ReturnType<typeof vi.fn> }[],
  webLinksInstances: [] as { handler?: (event: MouseEvent, uri: string) => void }[],
  webglInstances: [] as { onContextLoss: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; contextLossCallback?: () => void }[],
  canvasInstances: [] as unknown[],
  // When true the WebglAddon constructor throws (simulates no-GL context),
  // forcing the Canvas fallback so focus-upgrade paths can be exercised.
  webglShouldThrow: false,
}));

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "6" };
    modes = { mouseTrackingMode: "none", applicationCursorKeysMode: false };
    buffer = {
      active: { type: "normal" },
      onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
    };
    options: Record<string, any> = {};
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn();
    writeln = vi.fn();
    clear = vi.fn();
    reset = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn((fn: (event: KeyboardEvent) => boolean) => {
      this.customKeyHandler = fn;
    });
    attachCustomWheelEventHandler = vi.fn((fn: (event: WheelEvent) => boolean) => {
      this.customWheelHandler = fn;
    });
    getSelection = vi.fn().mockReturnValue("");
    focus = vi.fn();
    dispose = vi.fn();
    customKeyHandler?: (event: KeyboardEvent) => boolean;
    customWheelHandler?: (event: WheelEvent) => boolean;
    constructor(options?: Record<string, any>) {
      if (options) {
        this.options = { ...options };
      }
      xtermState.instances.push(this as any);
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    constructor() {
      addonState.fitInstances.push(this);
    }
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
      if (addonState.webglShouldThrow) {
        throw new Error("webgl context unavailable");
      }
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
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onPtyCwd: vi.fn(),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
  ptyList: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/worktree/transport", () => ({
  worktreeList: vi.fn().mockResolvedValue([]),
  worktreePs: vi.fn().mockResolvedValue([]),
  worktreeCreate: vi.fn(),
  worktreeSet: vi.fn().mockResolvedValue(null),
  worktreeRemove: vi.fn().mockResolvedValue(undefined),
  worktreePurge: vi.fn().mockResolvedValue(undefined),
  repoAdd: vi.fn().mockResolvedValue([]),
  repoList: vi.fn().mockResolvedValue([]),
  agentProfiles: vi.fn().mockResolvedValue([]),
  worktreeCreateAgent: vi.fn(),
  worktreeCreateFleet: vi.fn(),
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../lib/git/transport", () => ({
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
  requestReviewEligibility: vi.fn().mockResolvedValue({ eligible: true, blocked_reason: null, base_ref: 'main', owner_repo: 'owner/repo', existing_pr_url: null }),
  requestCreateReview: vi.fn().mockResolvedValue({ pr_url: 'https://example.com/pr/1', pr_number: 1, base_ref: 'main', owner_repo: 'owner/repo' }),
  requestReviewStatus: vi.fn().mockResolvedValue({ number: 1, title: 't', url: 'https://example.com/pr/1', state: 'open', draft: false, mergeable: 'unknown', base_ref_name: 'main', head_ref_name: 'feat', checks: [], fetched_at_ms: 0 }),
}));

vi.mock("../lib/layout/transport", () => ({
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);
const ptyWriteMock = vi.mocked(transport.ptyWrite);
const ptyResizeMock = vi.mocked(transport.ptyResize);
const ptyAckMock = vi.mocked(transport.ptyAck);
const ptyKillMock = vi.mocked(transport.ptyKill);
const saveScrollbackMock = vi.mocked(layoutTransport.saveScrollback);
const onPtyDataMock = vi.mocked(transport.onPtyData);
const onPtyExitMock = vi.mocked(transport.onPtyExit);
const openUrlMock = vi.mocked(opener.openUrl);

// happy-dom's ResizeObserver never fires; capture the callback so tests can
// trigger a resize the way a browser layout change would.
const roState = vi.hoisted(() => ({ callback: null as null | (() => void) }));

// The fit coordinator schedules its passes on rAF; capture callbacks so tests
// can pump a deterministic frame.
const rafState = vi.hoisted(() => ({ queue: [] as Array<() => void> }));

function fireResize() {
  roState.callback?.();
  // Drain the coordinator's scheduled pass synchronously.
  const queue = rafState.queue;
  rafState.queue = [];
  for (const cb of queue) cb();
}

function pumpRaf() {
  const queue = rafState.queue;
  rafState.queue = [];
  for (const cb of queue) cb();
}

describe("TerminalPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLayoutAnimationGateForTests();
    resetFitCoordinatorForTests();
    xtermState.instances.length = 0;
    addonState.fitInstances.length = 0;
    addonState.unicode11Instances.length = 0;
    addonState.searchInstances.length = 0;
    addonState.serializeInstances.length = 0;
    addonState.webLinksInstances.length = 0;
    addonState.webglInstances.length = 0;
    addonState.canvasInstances.length = 0;
    addonState.webglShouldThrow = false;
    roState.callback = null;
    rafState.queue = [];
    // Deterministic frame pump for the fit coordinator (no global stubbing,
    // so vi.useFakeTimers inside individual tests stays untouched).
    setFitSchedulerForTests((cb) => {
      rafState.queue.push(cb);
      return rafState.queue.length;
    });
    // Ack coalescer shares the same deterministic frame pump.
    setFrameSchedulerForTests((cb) => {
      rafState.queue.push(cb);
    });
    // Fresh store: the pane under test renders the "abc" session.
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
      layout: { type: "leaf", id: "abc" },
      focusedPath: [],
      serializers: {},
      cachedScrollbacks: {},
      restoredScrollbacks: {},
      settings: DEFAULT_APP_SETTINGS,
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
    resetLayoutAnimationGateForTests();
    resetFitCoordinatorForTests();
    resetFrameSchedulerForTests();
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

    // Simulate xterm finishing parsing: the ACK flushes on the next frame
    // with the chunk length.
    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();
    pumpRaf();
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
    vi.useFakeTimers();
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    term().cols = 120;
    term().rows = 40;
    fireResize();
    // PTY resize is debounced (100ms) to avoid ConPTY prompt-redraw storms
    expect(ptyResizeMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(ptyResizeMock).toHaveBeenCalledWith("abc", 120, 40);
  });

  it("defers container-resize fits while a layout animation is active and commits once after it ends", async () => {
    vi.useFakeTimers();
    render(<TerminalPane id="abc" />);
    await waitForSpawned();
    // Let the mount/settle/font fit passes land before arming the gate.
    vi.advanceTimersByTime(500);
    ptyResizeMock.mockClear();

    beginLayoutAnimation("sidebar-left", 380);
    term().cols = 120;
    term().rows = 40;

    fireResize();
    fireResize();
    // Stay inside the gate's safety-expiry window (duration + margin).
    vi.advanceTimersByTime(400);
    // Gate active: no fit, no PTY notify despite resizes.
    expect(ptyResizeMock).not.toHaveBeenCalled();

    endLayoutAnimation("sidebar-left");
    pumpRaf(); // run the coordinator pass released by the gate
    vi.advanceTimersByTime(100);
    expect(ptyResizeMock).toHaveBeenCalledTimes(1);
    expect(ptyResizeMock).toHaveBeenCalledWith("abc", 120, 40);
  });

  it("does not recreate the terminal when a ResizeObserver callback fires (no resize feedback loop)", async () => {
    vi.useFakeTimers();
    render(<TerminalPane id="abc" />);
    await waitForSpawned();
    expect(xtermState.instances.length).toBe(1);

    fireResize();
    // Unchanged grid: duplicate suppression skips the redundant notify.
    expect(ptyResizeMock).not.toHaveBeenCalled();

    term().cols = 120;
    term().rows = 40;
    fireResize();
    fireResize();
    // Coalescing collapses the rapid resizes into one PTY resize call
    vi.advanceTimersByTime(1000);
    expect(ptyResizeMock).toHaveBeenCalledTimes(1);
    expect(ptyResizeMock).toHaveBeenCalledWith("abc", 120, 40);
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
    pumpRaf(); // ack coalescer flushes on the next frame
    expect(ptyAckMock).toHaveBeenCalledTimes(1);
    expect(ptyAckMock).toHaveBeenCalledWith("abc", 8);
  });

  it("acks exact byte length for multi-byte characters when bytes is provided or via TextEncoder fallback", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const dataHandler = onPtyDataMock.mock.calls[0][0] as (p: {
      id: string;
      data: string;
      bytes?: number;
      seq: number;
    }) => void;
    // 🚀 is 2 UTF-16 code units (data.length = 2), but 4 UTF-8 bytes (bytes = 4)
    dataHandler({ id: "abc", data: "🚀", bytes: 4, seq: 1 });
    // "日本語" is 3 UTF-16 code units (data.length = 3), but 9 UTF-8 bytes (no bytes field, fallback)
    dataHandler({ id: "abc", data: "日本語", seq: 2 });

    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();
    pumpRaf(); // ack coalescer flushes on the next frame
    expect(ptyAckMock).toHaveBeenCalledTimes(1);
    // 4 + 9 = 13 bytes (instead of 2 + 3 = 5 UTF-16 length)
    expect(ptyAckMock).toHaveBeenCalledWith("abc", 13);
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
    // "def" is a background pane (no focusedPath): its write is deferred by
    // the render-budget queue and lands on the next frame.
    pumpRaf();
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

  it("does not periodically serialize or save scrollback on write parsed events", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    vi.useFakeTimers();
    expect(saveScrollbackMock).not.toHaveBeenCalled();

    const parsedHandler = term().onWriteParsed.mock.calls[0][0] as () => void;
    parsedHandler();

    vi.advanceTimersByTime(2000);
    expect(saveScrollbackMock).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().cachedScrollbacks["abc"]).toBeUndefined();
  });

  it("flushes scrollback to cache and disk on unmount", async () => {
    const { unmount } = render(<TerminalPane id="abc" />);
    await waitForSpawned();

    expect(saveScrollbackMock).not.toHaveBeenCalled();

    unmount();
    expect(saveScrollbackMock).toHaveBeenCalledTimes(1);
    expect(saveScrollbackMock).toHaveBeenCalledWith("abc", "mocked-serialized-buffer");
    expect(useTerminalStore.getState().cachedScrollbacks["abc"]).toBe("mocked-serialized-buffer");
  });

  it("replays restored scrollback with clean reset, omits in-buffer restore divider, and clears restored state on mount", async () => {
    useTerminalStore.setState({
      restoredScrollbacks: { abc: "saved lines\r\n" },
    });

    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    expect(term().reset).toHaveBeenCalled();
    expect(term().write).toHaveBeenCalledWith("saved lines\r\n");
    expect(term().writeln).not.toHaveBeenCalledWith(
      expect.stringContaining("Session Restored"),
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

  it("refits after a focus-driven Canvas→WebGL renderer swap (stale-stretch gap fix)", async () => {
    vi.useFakeTimers();
    // Mount without GL: pane falls back to Canvas, stretch plan is computed
    // against Canvas cell metrics.
    addonState.webglShouldThrow = true;
    render(<TerminalPane id="abc" path={[1]} />);
    await waitForSpawned();
    expect(addonState.canvasInstances.length).toBe(1);
    expect(addonState.webglInstances.length).toBe(0);

    // Flush every startup fit pass (settle timer etc.) to get a baseline.
    vi.advanceTimersByTime(1000);
    const fitCalls = () => addonState.fitInstances[0]!.fit.mock.calls.length;
    const baseline = fitCalls();

    // GL becomes available; focusing the pane upgrades the renderer.
    addonState.webglShouldThrow = false;
    act(() => {
      useTerminalStore.setState({ focusedPath: [1] });
    });

    expect(addonState.webglInstances.length).toBe(1); // mount attempt threw; swap created exactly one
    pumpRaf(); // the post-swap refit is scheduled on the next frame
    expect(fitCalls()).toBeGreaterThan(baseline);
  });

  it("revalidates grid + PTY size when a pane gains focus (self-heal)", async () => {
    vi.useFakeTimers();
    render(<TerminalPane id="abc" path={[1]} />);
    await waitForSpawned();
    vi.advanceTimersByTime(1000);
    ptyResizeMock.mockClear();

    // Stale geometry: the grid the PTY knows (80x24) no longer matches.
    term().cols = 100;
    term().rows = 30;

    act(() => {
      useTerminalStore.setState({ focusedPath: [1] });
    });
    pumpRaf();
    vi.advanceTimersByTime(100);
    expect(ptyResizeMock).toHaveBeenCalledWith("abc", 100, 30);
  });

  it("revalidates rendering at extended startup checkpoints (150/450/900ms)", async () => {
    vi.useFakeTimers();
    render(<TerminalPane id="abc" path={[1]} />);
    await waitForSpawned();
    const fitCalls = () => addonState.fitInstances[0]!.fit.mock.calls.length;
    const initial = fitCalls();

    // Startup transients (root zoom, drawer settle, late replay) land after
    // the first fit; each checkpoint revalidates so the stretch plan
    // converges without user intervention.
    vi.advanceTimersByTime(200);
    const after150 = fitCalls();
    expect(after150).toBeGreaterThan(initial);

    vi.advanceTimersByTime(300); // t=500ms: second checkpoint fired
    const after450 = fitCalls();
    expect(after450).toBeGreaterThan(after150);

    vi.advanceTimersByTime(500); // t=1000ms: third checkpoint fired
    const after900 = fitCalls();
    expect(after900).toBeGreaterThan(after450);
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

  it("hydrates workingBySessionId from the attach result, defaulting to idle when absent", async () => {
    ptySpawnMock.mockResolvedValueOnce({ id: "hyd-idle", is_new: true });
    await useTerminalStore.getState().spawnSession("C:/tmp");

    ptySpawnMock.mockResolvedValueOnce({ id: "hyd-busy", is_new: true, working: true });
    await useTerminalStore.getState().spawnSession("C:/tmp");

    const workingBySessionId = useTerminalStore.getState().workingBySessionId;
    expect(workingBySessionId["hyd-idle"]).toBe(false);
    expect(workingBySessionId["hyd-busy"]).toBe(true);
  });

  it("hydrates statusBySessionId from the attach result when an agent status rides along", async () => {
    ptySpawnMock.mockResolvedValueOnce({
      id: "hyd-agent",
      is_new: true,
      agent_status: {
        state: "blocked",
        interactive_prompt: "Allow write access to /tmp?",
        state_started_at_ms: 1,
        updated_at_ms: 2,
        origin: "hook",
      },
    });
    await useTerminalStore.getState().spawnSession("C:/tmp");

    const entry = useTerminalStore.getState().statusBySessionId["hyd-agent"];
    expect(entry?.state).toBe("blocked");
    expect(entry?.interactive_prompt).toBe("Allow write access to /tmp?");
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

  it("translates mouse wheel up and down to arrow keys when in alternate buffer mode", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
    });
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const t = term();
    t.buffer.active.type = "alternate";
    t.modes.mouseTrackingMode = "none";
    t.modes.applicationCursorKeysMode = false;

    const wheelUpEvent = { deltaY: -16, deltaMode: 0 } as WheelEvent;
    const handledUp = t.customWheelHandler?.(wheelUpEvent);
    expect(handledUp).toBe(false);
    expect(ptyWriteMock).toHaveBeenCalledWith("abc", "\x1b[A");

    ptyWriteMock.mockClear();
    const wheelDownEvent = { deltaY: 16, deltaMode: 0 } as WheelEvent;
    const handledDown = t.customWheelHandler?.(wheelDownEvent);
    expect(handledDown).toBe(false);
    expect(ptyWriteMock).toHaveBeenCalledWith("abc", "\x1b[B");

    // When application cursor keys mode is active
    t.modes.applicationCursorKeysMode = true;
    ptyWriteMock.mockClear();
    t.customWheelHandler?.(wheelUpEvent);
    expect(ptyWriteMock).toHaveBeenCalledWith("abc", "\x1bOA");
  });

  it("batches a multi-line wheel burst into a single pty write", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
    });
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const t = term();
    t.buffer.active.type = "alternate";
    t.modes.mouseTrackingMode = "none";
    t.modes.applicationCursorKeysMode = false;

    // Pixel-mode delta spanning 5 cell heights.
    const burst = { deltaY: -80, deltaMode: 0 } as WheelEvent;
    const handled = t.customWheelHandler?.(burst);
    expect(handled).toBe(false);
    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock).toHaveBeenCalledWith("abc", "\x1b[A".repeat(5));
  });

  it("allows default xterm wheel handling when mouse tracking is active or in normal buffer", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
    });
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const t = term();
    // Normal buffer
    t.buffer.active.type = "normal";
    t.modes.mouseTrackingMode = "none";
    expect(t.customWheelHandler?.({ deltaY: -16, deltaMode: 0 } as WheelEvent)).toBe(true);

    // Mouse tracking active
    t.buffer.active.type = "alternate";
    t.modes.mouseTrackingMode = "vt200";
    expect(t.customWheelHandler?.({ deltaY: -16, deltaMode: 0 } as WheelEvent)).toBe(true);
  });

  it("renders loading skeleton when session status is loading or restoring", () => {
    useTerminalStore.setState({
      sessions: {
        loadingSession: {
          id: "loadingSession",
          title: "Loading Workspace",
          status: "loading",
          cols: 80,
          rows: 24,
        },
      },
    });

    const { container, rerender } = render(<TerminalPane id="loadingSession" />);
    expect(container.querySelector(".terminal-loading-skeleton")).not.toBeNull();
    expect(screen.getByText("Session loading...")).toBeTruthy();
    expect(xtermState.instances.length).toBe(0);

    useTerminalStore.setState({
      sessions: {
        loadingSession: {
          id: "loadingSession",
          title: "Restoring Workspace",
          status: "restoring",
          cols: 80,
          rows: 24,
        },
      },
    });
    rerender(<TerminalPane id="loadingSession" />);
    expect(container.querySelector(".terminal-loading-skeleton")).not.toBeNull();
    expect(screen.getByText("Session loading...")).toBeTruthy();
  });

  it("auto-dismisses restored banner when user types (onData)", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: {
          id: "abc",
          title: "abc",
          status: "running",
          cols: 80,
          rows: 24,
          isRestored: true,
        },
      },
    });

    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    expect(useTerminalStore.getState().sessions["abc"].isRestored).toBe(true);

    const onDataHandler = term().onData.mock.calls[0][0] as (data: string) => void;
    onDataHandler("a");

    expect(useTerminalStore.getState().sessions["abc"].isRestored).toBe(false);
    expect(ptyWriteMock).toHaveBeenCalledWith("abc", "a");
  });

  it("initializes terminal options with appearance settings from store", async () => {
    useTerminalStore.setState({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        appearance: {
          ...DEFAULT_APP_SETTINGS.appearance,
          themeName: "dracula",
          fontFamily: "'Fira Code', monospace",
          fontSize: 16,
          lineHeight: 1.4,
          cursorStyle: "underline",
          cursorBlink: false,
          dimInactivePanes: true,
        },
      },
    });

    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    const t = term();
    expect(t.options.fontSize).toBe(16);
    expect(t.options.fontFamily).toBe("'Fira Code', monospace");
    expect(t.options.lineHeight).toBe(1.4);
    expect(t.options.cursorStyle).toBe("underline");
    expect(t.options.cursorBlink).toBe(false);
    expect(t.options.theme).toEqual(getTerminalTheme("dracula"));
  });

  it("reactively updates terminal options when store appearance changes without recreating terminal", async () => {
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    expect(xtermState.instances.length).toBe(1);
    const fitMock = addonState.fitInstances[0]?.fit;

    act(() => {
      useTerminalStore.getState().updateAppearanceSettings({
        themeName: "nord",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 18,
        lineHeight: 1.5,
        cursorStyle: "bar",
        cursorBlink: false,
      });
    });

    // Terminal instance was NOT recreated
    expect(xtermState.instances.length).toBe(1);
    expect(term().dispose).not.toHaveBeenCalled();

    const t = term();
    expect(t.options.fontSize).toBe(18);
    expect(t.options.fontFamily).toBe("'JetBrains Mono', monospace");
    expect(t.options.lineHeight).toBe(1.5);
    expect(t.options.cursorStyle).toBe("bar");
    expect(t.options.cursorBlink).toBe(false);
    expect(t.options.theme).toEqual(getTerminalTheme("nord"));
    expect(fitMock).toHaveBeenCalled();
  });

  it("applies dimmed class to container when dimInactivePanes is true and pane is unfocused", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
        def: { id: "def", title: "def", status: "running", cols: 80, rows: 24 },
      },
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "abc" },
        b: { type: "leaf", id: "def" },
      },
      focusedPath: [1], // "def" is focused, "abc" is unfocused
      settings: {
        ...DEFAULT_APP_SETTINGS,
        appearance: {
          ...DEFAULT_APP_SETTINGS.appearance,
          dimInactivePanes: true,
        },
      },
    });

    const { container } = render(<TerminalPane id="abc" path={[0]} />);
    await waitForSpawned();

    const pane = container.querySelector(".terminal-pane");
    expect(pane?.classList.contains("dimmed")).toBe(true);
  });

  it("removes dimmed class when dimInactivePanes is disabled or pane becomes focused", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
        def: { id: "def", title: "def", status: "running", cols: 80, rows: 24 },
      },
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "abc" },
        b: { type: "leaf", id: "def" },
      },
      focusedPath: [1], // "abc" at [0] is unfocused
      settings: {
        ...DEFAULT_APP_SETTINGS,
        appearance: {
          ...DEFAULT_APP_SETTINGS.appearance,
          dimInactivePanes: true,
        },
      },
    });

    const { container, rerender } = render(<TerminalPane id="abc" path={[0]} />);
    await waitForSpawned();

    const pane = container.querySelector(".terminal-pane");
    expect(pane?.classList.contains("dimmed")).toBe(true);

    // Focus "abc"
    act(() => {
      useTerminalStore.setState({ focusedPath: [0] });
    });
    rerender(<TerminalPane id="abc" path={[0]} />);
    expect(pane?.classList.contains("dimmed")).toBe(false);

    // Unfocus "abc" again but disable dimInactivePanes
    act(() => {
      useTerminalStore.setState({ focusedPath: [1] });
      useTerminalStore.getState().updateAppearanceSettings({ dimInactivePanes: false });
    });
    rerender(<TerminalPane id="abc" path={[0]} />);
    expect(pane?.classList.contains("dimmed")).toBe(false);
  });

  it("applies the full-bleed stretch and resizes the pty when the container resizes", async () => {
    vi.useFakeTimers();
    const { container } = render(<TerminalPane id="abc" />);
    await waitForSpawned();

    // 813x600 CSS px pane minus the 4px ruler band = the planner budget;
    // with an 8x16 device cell the plan lands on spacing 0 / pitch 20.5/16.
    const paneEl = container.querySelector(".terminal-pane")!;
    Object.defineProperty(paneEl, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 813, height: 600, top: 0, left: 0, right: 813, bottom: 600, x: 0, y: 0 }),
    });
    const t = term() as any;
    // A real element pair so readFitBudget's getComputedStyle calls work.
    const xtermEl = document.createElement("div");
    paneEl.appendChild(xtermEl);
    t.element = xtermEl;
    t._core = {
      _renderService: {
        dimensions: {
          css: { char: { width: 8, height: 16 }, cell: { width: 8, height: 19 } },
        },
      },
    };
    vi.stubGlobal("devicePixelRatio", 1);

    // Grid counts as they would land after fitting with stretched metrics.
    t.cols = 115;
    t.rows = 30;

    fireResize();
    expect(t.options.letterSpacing).toBe(0);
    expect(t.options.lineHeight).toBeCloseTo(20.5 / 16, 10);
    // Well past the debounce AND the mount settle timer so fake-clock skew
    // from vi.waitFor polling cannot strand the pending resize.
    vi.advanceTimersByTime(1000);
    expect(ptyResizeMock).toHaveBeenCalledWith("abc", 115, 30);
  });

  it("routes appearance-driven refits through the same pty-resize pipeline", async () => {
    vi.useFakeTimers();
    render(<TerminalPane id="abc" />);
    await waitForSpawned();

    act(() => {
      useTerminalStore.getState().updateAppearanceSettings({ fontSize: 18 });
      // Simulate the grid the refit produces with the larger font.
      term().cols = 90;
      term().rows = 30;
    });

    // The old behavior refit without notifying the daemon; now every fit path
    // must reach resizeSession (after the shared 100ms debounce).
    vi.advanceTimersByTime(1000);
    expect(ptyResizeMock).toHaveBeenCalledTimes(1);
    expect(ptyResizeMock).toHaveBeenCalledWith("abc", 90, 30);
  });
});
