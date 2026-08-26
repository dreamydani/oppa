import React, { useEffect } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { useGlobalFailureSurface } from "../lib/errors/globalFailureSurface";

function Bomb({ message }: { message: string }): React.JSX.Element {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  // React logs render-phase throws; silence for clean assertions.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div data-testid="content">hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("shows the fallback with the error message when a child throws", () => {
    render(
      <ErrorBoundary>
        <Bomb message="pane exploded" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/pane exploded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("isolates a crashed subtree so siblings keep rendering", () => {
    render(
      <div>
        <ErrorBoundary label="left pane">
          <Bomb message="left died" />
        </ErrorBoundary>
        <ErrorBoundary label="right pane">
          <div data-testid="sibling">still here</div>
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText(/left died/)).toBeInTheDocument();
    expect(screen.getByTestId("sibling")).toBeInTheDocument();
  });

  it("onReset clears the failure and re-renders children", () => {
    let shouldThrow = true;
    function Flipper() {
      if (shouldThrow) throw new Error("first mount fails");
      return <div data-testid="recovered">recovered</div>;
    }
    let requestReset: (() => void) | null = null;
    render(
      <ErrorBoundary onReset={(fn) => (requestReset = fn)}>
        <Flipper />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/first mount fails/)).toBeInTheDocument();

    shouldThrow = false;
    act(() => {
      requestReset!();
    });
    expect(screen.getByTestId("recovered")).toBeInTheDocument();
  });
});

describe("useGlobalFailureSurface", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures window error events into state", () => {
    function Probe() {
      const failure = useGlobalFailureSurface();
      return <div data-testid="surface">{failure ?? "clean"}</div>;
    }
    render(<Probe />);
    expect(screen.getByTestId("surface")).toHaveTextContent("clean");
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: "boom-sync" }));
    });
    expect(screen.getByTestId("surface")).toHaveTextContent("boom-sync");
  });

  it("captures unhandled promise rejections (fire-and-forget IPC)", () => {
    function Probe() {
      const failure = useGlobalFailureSurface();
      return <div data-testid="surface-rejection">{failure ?? "clean"}</div>;
    }
    render(<Probe />);
    // happy-dom does not ship PromiseRejectionEvent; shape a plain event.
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "promise", { value: Promise.resolve() });
    Object.defineProperty(rejection, "reason", {
      value: new Error("ipc failed"),
    });
    act(() => {
      window.dispatchEvent(rejection);
    });
    expect(screen.getByTestId("surface-rejection")).toHaveTextContent(
      "ipc failed",
    );
  });

  it("stops listening after unmount", () => {
    let lateHits = 0;
    function Probe() {
      const failure = useGlobalFailureSurface();
      useEffect(() => undefined);
      return <div data-testid="surface-unmount">{failure ?? "clean"}</div>;
    }
    const { unmount } = render(<Probe />);
    window.addEventListener("error", () => lateHits++);
    unmount();
    window.dispatchEvent(new ErrorEvent("error", { message: "late boom" }));
    // The probe's own listener is gone; only our counting listener remains.
    expect(lateHits).toBe(1);
    expect(screen.queryByTestId("surface-unmount")).toBeNull();
  });
});
