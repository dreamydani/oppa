import React from "react";
import "./AgentWorkingDots.css";

// Serpentine path through the 4x2 grid: the highlight runs down one column
// and back up the other, which reads as a continuous spin in a tall gutter.
const GRID_PATH: ReadonlyArray<{ row: number; col: number }> = [
  { row: 1, col: 1 },
  { row: 1, col: 2 },
  { row: 2, col: 2 },
  { row: 2, col: 1 },
  { row: 3, col: 1 },
  { row: 3, col: 2 },
  { row: 4, col: 2 },
  { row: 4, col: 1 },
];

/** Cline-style working indicator: an 8-dot grid chasing in sequence. */
export function AgentWorkingDots(): React.ReactElement {
  return (
    <span
      className="agent-working-dots"
      role="status"
      aria-label="Working"
      title="Working"
    >
      {GRID_PATH.map((cell, index) => (
        <span
          key={`${cell.row}-${cell.col}`}
          className="agent-working-dot"
          style={
            {
              "--dot-row": cell.row,
              "--dot-col": cell.col,
              "--dot-index": index,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}