// Module-level registry so the diff bar (outside the editor) can read the
// live Monaco selection; only one editor registers at a time.
export interface DiffSelectionSnapshot {
  selectedText: string;
  // 1-based modified-editor line under the cursor (or selection end).
  lineNumber: number;
  // Set only when a real selection spans more than one line.
  rangeStartLine: number | null;
}

type DiffSelectionGetter = () => DiffSelectionSnapshot;

let activeGetter: DiffSelectionGetter | null = null;

export function registerDiffSelectionGetter(getter: DiffSelectionGetter | null): void {
  activeGetter = getter;
}

export function readDiffSelection(): DiffSelectionSnapshot | null {
  if (!activeGetter) return null;
  try {
    return activeGetter();
  } catch {
    return null;
  }
}
