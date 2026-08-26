// Surfaces failures React boundaries cannot see: async throws and
// unhandled promise rejections (the app's fire-and-forget IPC pattern).
// Install once per App root via useGlobalFailureSurface; the latest
// failure is returned as state for banner rendering.

import { useEffect, useState } from "react";

function describeFailure(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

export function useGlobalFailureSurface(): string | null {
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const onError = (event: ErrorEvent): void => {
      console.error("[oppa] global error:", event.message);
      setFailure(describeFailure(event.error ?? event.message));
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      const message = describeFailure(event.reason);
      // Prevent the webview's own unhandled-rejection noise; we own it now.
      event.preventDefault?.();
      console.error("[oppa] unhandled rejection:", message);
      setFailure(message);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return failure;
}
