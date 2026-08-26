import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  // Scoped context in the fallback, e.g. "terminal pane".
  label?: string;
  /**
   * Called once after a failure is caught with a reset callback that clears
   * the error and re-renders the subtree. Lets hosts offer retry flows
   * (e.g. fix state first, then remount).
   */
  onReset?: (reset: () => void) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// Catches render/lifecycle throws so one broken subtree cannot white-screen
// the app. Async failures are NOT caught here — see globalFailureSurface.
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      `[oppa] ${this.props.label ?? "subtree"} crashed:`,
      toError(error).message,
      info.componentStack,
    );
    this.props.onReset?.(() => this.setState({ error: null }));
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          alignItems: "flex-start",
          justifyContent: "center",
          height: "100%",
          width: "100%",
          padding: 16,
          boxSizing: "border-box",
          background: "var(--bg-secondary, #1e1e1e)",
          color: "var(--text-primary, #ddd)",
          fontFamily: "var(--font-sans, sans-serif)",
          fontSize: 13,
        }}
      >
        <strong>
          Something went wrong{this.props.label ? ` in ${this.props.label}` : ""}
        </strong>
        <code style={{ opacity: 0.75, wordBreak: "break-word" }}>
          {error.message}
        </code>
        <button type="button" onClick={this.handleReload}>
          Reload
        </button>
      </div>
    );
  }
}
