// Hold-to-dictate gesture — port of Orca's `use-hold-dictation-gesture.ts`.
// Oppa has no keybinding registry (Shortcuts pane is a static reference), so
// the chord is the fixed Mod+E default; remapping is deferred (see Slice 6
// Decisions). Press-and-hold starts dictation, release stops it.

import { useEffect, useRef, type MutableRefObject } from "react";
import type { DictationState } from "./voiceTypes";
import type { AppSettings } from "../settings/types";
import type { DictationInsertionTarget } from "./dictationInsertion";

export function isDictationChord(event: KeyboardEvent): boolean {
  const isMac =
    navigator.platform.toUpperCase().includes("MAC") || navigator.userAgent.includes("Mac");
  const mod = isMac ? event.metaKey : event.ctrlKey;
  // Shift+Mod+E is split-vertical in App.tsx — never steal it.
  return mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "e";
}

type HoldDictationGestureOptions = {
  dictationStateRef: MutableRefObject<DictationState>;
  holdGestureActiveRef: MutableRefObject<boolean>;
  insertionTargetRef: MutableRefObject<DictationInsertionTarget | null>;
  intentionalTargetCancellationRef: MutableRefObject<boolean>;
  settings: AppSettings;
  startDictation: () => Promise<void> | void;
  stopDictation: () => Promise<void> | void;
};

type HoldDictationReleaseMatcher = (event: KeyboardEvent) => boolean;

type HeldModifiers = {
  alt: boolean;
  control: boolean;
  meta: boolean;
  shift: boolean;
};

const MODIFIER_KEYS_BY_NAME: Partial<Record<string, keyof HeldModifiers>> = {
  Alt: "alt",
  AltGraph: "alt",
  Control: "control",
  Ctrl: "control",
  Meta: "meta",
  OS: "meta",
  Shift: "shift",
};

const UNRELIABLE_KEY_VALUES = new Set(["", "Dead", "Unidentified"]);
const UNRELIABLE_CODE_VALUES = new Set(["", "Unidentified"]);

function normalizeReleasedKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function getReleasedModifier(event: KeyboardEvent): keyof HeldModifiers | null {
  const byKey = MODIFIER_KEYS_BY_NAME[event.key];
  if (byKey) {
    return byKey;
  }
  if (event.code.startsWith("Alt")) {
    return "alt";
  }
  if (event.code.startsWith("Control")) {
    return "control";
  }
  if (event.code.startsWith("Meta")) {
    return "meta";
  }
  if (event.code.startsWith("Shift")) {
    return "shift";
  }
  return null;
}

function getReleasedPrimaryKey(event: KeyboardEvent): string | null {
  if (getReleasedModifier(event)) {
    return null;
  }
  const key = normalizeReleasedKey(event.key);
  return UNRELIABLE_KEY_VALUES.has(key) ? null : key;
}

function getReleasedPrimaryCode(event: KeyboardEvent): string | null {
  if (getReleasedModifier(event) || UNRELIABLE_CODE_VALUES.has(event.code)) {
    return null;
  }
  return event.code;
}

function createHoldDictationReleaseMatcher(event: KeyboardEvent): HoldDictationReleaseMatcher {
  const primaryKey = getReleasedPrimaryKey(event);
  const primaryCode = getReleasedPrimaryCode(event);
  const heldModifiers: HeldModifiers = {
    alt: event.altKey,
    control: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };

  return (releaseEvent) => {
    const releasedModifier = getReleasedModifier(releaseEvent);
    if (releasedModifier) {
      return heldModifiers[releasedModifier];
    }
    // Why: modifier state can already be false on the keyup that ends a chord,
    // so release matching tracks the accepted keydown's key identity instead.
    const releasePrimaryCode = getReleasedPrimaryCode(releaseEvent);
    if (primaryCode !== null && releasePrimaryCode !== null) {
      return releasePrimaryCode === primaryCode;
    }
    return primaryKey !== null && getReleasedPrimaryKey(releaseEvent) === primaryKey;
  };
}

export function useHoldDictationGesture({
  dictationStateRef,
  holdGestureActiveRef,
  insertionTargetRef,
  intentionalTargetCancellationRef,
  settings,
  startDictation,
  stopDictation,
}: HoldDictationGestureOptions): void {
  const releaseMatcherRef = useRef<HoldDictationReleaseMatcher | null>(null);

  // Why: hold mode owns both press and release via renderer DOM events, and
  // capture-phase interception keeps the chord out of xterm and App shortcuts.
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? "toggle";
    if (mode !== "hold") {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isDictationChord(e)) {
        return;
      }
      if (!settings?.voice?.enabled || !settings.voice.sttModel) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      holdGestureActiveRef.current = true;
      releaseMatcherRef.current = createHoldDictationReleaseMatcher(e);
      if (dictationStateRef.current === "idle") {
        void startDictation();
      }
    };

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (!holdGestureActiveRef.current) {
        return;
      }
      if (!isDictationChord(e) && releaseMatcherRef.current?.(e) !== true) {
        return;
      }
      releaseMatcherRef.current = null;
      if (dictationStateRef.current === "idle" || dictationStateRef.current === "stopping") {
        holdGestureActiveRef.current = false;
        return;
      }
      holdGestureActiveRef.current = false;
      void stopDictation();
    };

    const handleBlur = (): void => {
      if (!holdGestureActiveRef.current) {
        return;
      }
      holdGestureActiveRef.current = false;
      releaseMatcherRef.current = null;
      if (dictationStateRef.current !== "idle" && dictationStateRef.current !== "stopping") {
        insertionTargetRef.current = null;
        intentionalTargetCancellationRef.current = true;
        void stopDictation();
      }
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        handleBlur();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      handleBlur();
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    settings?.voice?.dictationMode,
    settings?.voice?.enabled,
    settings?.voice?.sttModel,
    startDictation,
    stopDictation,
    dictationStateRef,
    holdGestureActiveRef,
    insertionTargetRef,
    intentionalTargetCancellationRef,
  ]);
}
