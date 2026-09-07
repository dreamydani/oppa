// Dictation control bus — 1:1 port of Orca's `dictation-control-events.ts`.
// Lets the indicator pill and external affordances drive the controller
// without prop-drilling (start/stop/toggle).

export const DICTATION_CONTROL_EVENT = "dictation:control";

export type DictationControlAction = "toggle" | "start" | "stop";

export function dispatchDictationControl(action: DictationControlAction): void {
  document.dispatchEvent(
    new CustomEvent<DictationControlAction>(DICTATION_CONTROL_EVENT, { detail: action }),
  );
}
