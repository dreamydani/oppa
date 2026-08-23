import { useEffect, type ReactElement } from "react";
import { X } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";

export function ViewOnlyDiffBar(): ReactElement | null {
  const viewOnlyDiff = useTerminalStore((s) => s.viewOnlyDiff);
  const clearViewOnlyDiff = useTerminalStore((s) => s.clearViewOnlyDiff);

  useEffect(() => {
    if (!viewOnlyDiff) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearViewOnlyDiff();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewOnlyDiff, clearViewOnlyDiff]);

  if (!viewOnlyDiff) return null;

  return (
    <div className="view-only-diff-bar" data-testid="view-only-diff-bar">
      <span className="view-only-diff-label">Viewing diff — Esc to close</span>
      <span className="view-only-diff-path" title={viewOnlyDiff.path}>
        {viewOnlyDiff.path}
      </span>
      <button
        type="button"
        className="view-only-diff-close"
        aria-label="Close diff view"
        onClick={clearViewOnlyDiff}
      >
        <X size={13} />
      </button>
    </div>
  );
}
