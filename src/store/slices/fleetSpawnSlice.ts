// Fleet Spawn Sheet lifecycle UI state. Prefill lets entry points (sidebar,
// later split-chooser) seed repo/base/count before the sheet opens.

import type { TerminalState } from "../terminalStore";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export interface FleetSheetPrefill {
  repoPath?: string;
  baseRef?: string;
  count?: number;
}

export interface FleetSpawnSlice {
  isFleetSheetOpen: boolean;
  fleetSheetPrefill: FleetSheetPrefill | null;
  openFleetSheet: (prefill?: FleetSheetPrefill) => void;
  closeFleetSheet: () => void;
}

export function createFleetSpawnSlice(set: Set): FleetSpawnSlice {
  return {
    isFleetSheetOpen: false,
    fleetSheetPrefill: null,

    openFleetSheet: (prefill) =>
      set({ isFleetSheetOpen: true, fleetSheetPrefill: prefill ?? null }),
    closeFleetSheet: () => set({ isFleetSheetOpen: false }),
  };
}
