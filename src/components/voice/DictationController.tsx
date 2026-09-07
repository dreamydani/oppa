import { useEffect, useRef, useCallback } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { createAudioCapture } from "../../lib/voice/audioCapture";
import {
  onVoiceError,
  onVoiceFinal,
  onVoicePartial,
  onVoiceStopped,
  startVoiceDictation,
  stopVoiceDictation,
} from "../../lib/voice/transport";
import {
  captureInsertionTarget,
  insertText,
  type DictationInsertionTarget,
} from "../../lib/voice/dictationInsertion";
import { formatFinalTranscriptSegment } from "../../lib/voice/dictationSegments";
import {
  recordStoppedSession,
  waitForStoppedSession,
} from "../../lib/voice/dictationSessions";
import {
  DICTATION_CONTROL_EVENT,
  type DictationControlAction,
} from "../../lib/voice/dictationControl";
import { isDictationChord, useHoldDictationGesture } from "../../lib/voice/useHoldDictationGesture";
import { DictationIndicator } from "./DictationIndicator";
import { VoiceNotice } from "./VoiceNotice";
import "./Dictation.css";

const NOTICE_EXPIRE_MS = 5000;

function startErrorNotice(message: string): { text: string; action?: "open-voice-settings" } {
  if (
    message.includes("Permission") ||
    message.includes("NotAllowed") ||
    message.includes("permission_denied")
  ) {
    return {
      text: "Microphone access denied. Grant access in system settings, then restart Oppa.",
    };
  }
  if (message.includes("not ready") || message.includes("not_ready")) {
    return { text: "Speech model not ready. Download it in Settings > Voice." };
  }
  if (message.includes("Unknown model") || message.includes("unknown_model")) {
    return {
      text: "Selected model is no longer available. Please choose another in Settings > Voice.",
      action: "open-voice-settings",
    };
  }
  return { text: `Dictation failed: ${message}` };
}

export function DictationController(): React.ReactElement {
  const dictationState = useTerminalStore((s) => s.dictationState);
  const setDictationState = useTerminalStore((s) => s.setDictationState);
  const setPartialTranscript = useTerminalStore((s) => s.setPartialTranscript);
  const showVoiceNotice = useTerminalStore((s) => s.showVoiceNotice);
  const settings = useTerminalStore((s) => s.settings);
  const captureRef = useRef(createAudioCapture());
  const {
    start: startCapture,
    stop: stopCapture,
    flushBufferedAudio,
    discardBufferedAudio,
    getCapturedChunkCount,
  } = captureRef.current;

  const dictationStateRef = useRef(dictationState);
  dictationStateRef.current = dictationState;
  const dictationRunRef = useRef(0);
  const holdGestureActiveRef = useRef(false);
  const insertionTargetRef = useRef<DictationInsertionTarget | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const stoppedSessionIdsRef = useRef(new Set<string>());
  const stoppedResolversRef = useRef(new Map<string, () => void>());
  const stopRequestedDuringStartRef = useRef(false);
  const finalTranscriptReceivedRef = useRef(false);
  const erroredSessionIdsRef = useRef(new Set<string>());
  const intentionalTargetCancellationRef = useRef(false);
  const insertedFinalTranscriptRef = useRef("");
  // Why: push-to-talk restarts capture per utterance; notice once per
  // preference, not once per press, while the selected mic stays gone.
  const micFallbackNotifiedForRef = useRef<string | null>(null);
  const stopDictationRef = useRef<(() => void) | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback(
    (text: string, action?: "open-voice-settings") => {
      showVoiceNotice(text, action);
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }
      noticeTimerRef.current = setTimeout(() => {
        const notice = useTerminalStore.getState().voiceNotice;
        if (notice) {
          useTerminalStore.getState().dismissVoiceNotice(notice.id);
        }
      }, NOTICE_EXPIRE_MS);
    },
    [showVoiceNotice],
  );

  useEffect(
    () => () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }
    },
    [],
  );

  const drainStoppedSession = useCallback((sessionId: string) => {
    void waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef);
  }, []);

  const finishDictationSession = useCallback(
    async (sessionId: string) => {
      dictationStateRef.current = "stopping";
      setDictationState("stopping");
      stopCapture();
      try {
        await stopVoiceDictation(sessionId);
      } catch {
        // Swallow stop errors — the worker may already be torn down.
      }
      // Why: stopDictation() resolves on backend completion, while final
      // transcript delivery is renderer IPC. Wait for this session's stopped
      // event so old finals cannot be mistaken for the next dictation run.
      await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef);
      const sessionErrored = erroredSessionIdsRef.current.delete(sessionId);
      if (!sessionErrored && !finalTranscriptReceivedRef.current && getCapturedChunkCount() > 0) {
        notify("No speech detected.");
      }
      insertionTargetRef.current = null;
      finalTranscriptReceivedRef.current = false;
      insertedFinalTranscriptRef.current = "";
      intentionalTargetCancellationRef.current = false;
      stopRequestedDuringStartRef.current = false;
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null;
      }
      dictationStateRef.current = "idle";
      setDictationState("idle");
      setPartialTranscript("");
    },
    [setDictationState, setPartialTranscript, stopCapture, getCapturedChunkCount, notify],
  );

  const startDictation = useCallback(async () => {
    if (dictationStateRef.current !== "idle") {
      return;
    }

    const voice = useTerminalStore.getState().settings.voice;
    const modelId = voice?.sttModel;
    if (!modelId) {
      notify("No speech model selected. Download one in Settings > Voice.", "open-voice-settings");
      return;
    }

    if (!voice?.enabled) {
      notify("Voice dictation is disabled. Enable it in Settings > Voice.");
      return;
    }

    const runId = dictationRunRef.current + 1;
    const sessionId = String(runId);
    dictationRunRef.current = runId;
    activeSessionIdRef.current = sessionId;
    insertionTargetRef.current = captureInsertionTarget();
    stopRequestedDuringStartRef.current = false;
    finalTranscriptReceivedRef.current = false;
    erroredSessionIdsRef.current.clear();
    insertedFinalTranscriptRef.current = "";
    intentionalTargetCancellationRef.current = false;
    dictationStateRef.current = "starting";
    setDictationState("starting");

    let captureStarted = false;

    try {
      // Why: worker startup can take seconds after idle teardown. Capture
      // first and buffer locally so speech during "Starting..." is kept.
      const preferredMicrophoneDeviceId = voice?.microphoneDeviceId ?? null;
      const captureResult = await startCapture({
        bufferAudio: true,
        sessionId,
        microphoneDeviceId: preferredMicrophoneDeviceId,
        microphoneDeviceLabel: voice?.microphoneDeviceLabel ?? null,
        onCaptureLost: () => {
          if (dictationRunRef.current !== runId) {
            return;
          }
          notify("Microphone disconnected. Dictation stopped.");
          stopDictationRef.current?.();
        },
      });
      captureStarted = true;
      if (captureResult?.fellBackToDefaultMicrophone) {
        // Why: a stop requested during startup tears this capture down below,
        // so the notice would describe a fallback that never records anything.
        if (
          !stopRequestedDuringStartRef.current &&
          micFallbackNotifiedForRef.current !== preferredMicrophoneDeviceId
        ) {
          micFallbackNotifiedForRef.current = preferredMicrophoneDeviceId;
          notify("Selected microphone unavailable. Using system default.");
        }
      } else {
        micFallbackNotifiedForRef.current = null;
      }
      if (stopRequestedDuringStartRef.current) {
        stopCapture({ preserveBufferedAudio: true });
      }
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio();
        stopCapture();
        insertionTargetRef.current = null;
        return;
      }

      await startVoiceDictation(modelId, undefined, sessionId);
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio();
        insertionTargetRef.current = null;
        stopCapture();
        await stopVoiceDictation(sessionId).catch(() => undefined);
        drainStoppedSession(sessionId);
        return;
      }

      await flushBufferedAudio();
      if (dictationRunRef.current !== runId) {
        discardBufferedAudio();
        insertionTargetRef.current = null;
        stopCapture();
        await stopVoiceDictation(sessionId).catch(() => undefined);
        drainStoppedSession(sessionId);
        return;
      }
      if (stopRequestedDuringStartRef.current) {
        await finishDictationSession(sessionId);
        return;
      }

      dictationStateRef.current = "listening";
      setDictationState("listening");
    } catch (err) {
      if (dictationRunRef.current !== runId) {
        return;
      }
      await stopVoiceDictation(sessionId).catch(() => undefined);
      drainStoppedSession(sessionId);
      if (captureStarted) {
        stopCapture();
      }
      discardBufferedAudio();
      const message = err instanceof Error ? err.message : String(err);
      insertionTargetRef.current = null;
      intentionalTargetCancellationRef.current = false;
      stopRequestedDuringStartRef.current = false;
      finalTranscriptReceivedRef.current = false;
      erroredSessionIdsRef.current.clear();
      insertedFinalTranscriptRef.current = "";
      activeSessionIdRef.current = null;
      setPartialTranscript("");
      if (message.includes("dictation_canceled")) {
        dictationStateRef.current = "idle";
        setDictationState("idle");
        return;
      }
      dictationStateRef.current = "error";
      setDictationState("error");
      const notice = startErrorNotice(message);
      notify(notice.text, notice.action);
      dictationStateRef.current = "idle";
      setDictationState("idle");
    }
  }, [
    setDictationState,
    startCapture,
    flushBufferedAudio,
    discardBufferedAudio,
    stopCapture,
    finishDictationSession,
    drainStoppedSession,
    setPartialTranscript,
    notify,
  ]);

  const stopDictation = useCallback(async () => {
    if (dictationStateRef.current === "starting") {
      stopRequestedDuringStartRef.current = true;
      dictationStateRef.current = "stopping";
      setDictationState("stopping");
      stopCapture({ preserveBufferedAudio: true });
      return;
    }

    if (dictationStateRef.current !== "listening") {
      return;
    }

    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }
    await finishDictationSession(sessionId);
  }, [finishDictationSession, setDictationState, stopCapture]);

  // Why: capture-loss fires from a stream opened before stopDictation exists;
  // route through a ref so the two callbacks do not depend on each other.
  stopDictationRef.current = () => void stopDictation();

  // Toggle mode: renderer-side capture-phase interception keeps the chord out
  // of xterm and App shortcuts (Orca does this in the main process).
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? "toggle";
    if (mode !== "toggle") {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isDictationChord(e)) {
        return;
      }
      if (
        !settings?.voice?.enabled ||
        !settings.voice.sttModel ||
        dictationStateRef.current === "stopping"
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (dictationStateRef.current === "listening" || dictationStateRef.current === "starting") {
        void stopDictation();
      } else {
        void startDictation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    settings?.voice?.dictationMode,
    settings?.voice?.enabled,
    settings?.voice?.sttModel,
    startDictation,
    stopDictation,
  ]);

  useEffect(() => {
    const canDictate = (): boolean => Boolean(settings?.voice?.enabled && settings.voice.sttModel);
    const handleControl = (event: Event): void => {
      if (!canDictate() || dictationStateRef.current === "stopping") {
        return;
      }
      const action = (event as CustomEvent<DictationControlAction>).detail;
      if (action === "start") {
        if (dictationStateRef.current === "idle") {
          void startDictation();
        }
        return;
      }
      if (action === "stop") {
        if (dictationStateRef.current === "listening" || dictationStateRef.current === "starting") {
          void stopDictation();
        }
        return;
      }
      if (dictationStateRef.current === "listening" || dictationStateRef.current === "starting") {
        void stopDictation();
      } else {
        void startDictation();
      }
    };
    document.addEventListener(DICTATION_CONTROL_EVENT, handleControl);
    return () => document.removeEventListener(DICTATION_CONTROL_EVENT, handleControl);
  }, [settings?.voice?.enabled, settings?.voice?.sttModel, startDictation, stopDictation]);

  useHoldDictationGesture({
    dictationStateRef,
    holdGestureActiveRef,
    insertionTargetRef,
    intentionalTargetCancellationRef,
    settings,
    startDictation,
    stopDictation,
  });

  useEffect(() => {
    const cleanupPartial = onVoicePartial((data) => {
      if (data.sessionId !== activeSessionIdRef.current) {
        return;
      }
      setPartialTranscript(data.text);
    }).catch(() => undefined);

    const cleanupFinal = onVoiceFinal((data) => {
      if (data.sessionId !== activeSessionIdRef.current || !data.text) {
        return;
      }
      setPartialTranscript("");
      finalTranscriptReceivedRef.current = true;
      const target = insertionTargetRef.current;
      if (target) {
        const confirmBeforeInsert =
          useTerminalStore.getState().settings.voice?.terminalConfirmBeforeInsert === true;
        const textToInsert = formatFinalTranscriptSegment(
          data.text,
          insertedFinalTranscriptRef.current,
        );
        if (!confirmBeforeInsert || window.confirm(`Insert dictated text?\n\n${textToInsert}`)) {
          insertText(textToInsert, target);
          insertedFinalTranscriptRef.current += textToInsert;
        }
      } else if (!intentionalTargetCancellationRef.current) {
        notify("Dictation finished, but no text field was focused.");
      }
    }).catch(() => undefined);

    const cleanupStopped = onVoiceStopped((data) => {
      recordStoppedSession(data.sessionId, stoppedSessionIdsRef, stoppedResolversRef);
    }).catch(() => undefined);

    const cleanupError = onVoiceError((data) => {
      if (data.sessionId !== activeSessionIdRef.current) {
        return;
      }
      const sessionId = data.sessionId;
      erroredSessionIdsRef.current.add(sessionId);
      dictationRunRef.current += 1;
      activeSessionIdRef.current = null;
      const notice = startErrorNotice(data.error);
      notify(`Speech error: ${notice.text}`, notice.action);
      dictationStateRef.current = "stopping";
      setDictationState("stopping");
      stopCapture();
      discardBufferedAudio();
      void (async () => {
        await stopVoiceDictation(sessionId).catch(() => undefined);
        await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef);
        insertionTargetRef.current = null;
        intentionalTargetCancellationRef.current = false;
        stopRequestedDuringStartRef.current = false;
        finalTranscriptReceivedRef.current = false;
        insertedFinalTranscriptRef.current = "";
        dictationStateRef.current = "idle";
        setDictationState("idle");
        setPartialTranscript("");
      })();
    }).catch(() => undefined);

    return () => {
      void cleanupPartial.then((fn) => fn?.());
      void cleanupFinal.then((fn) => fn?.());
      void cleanupStopped.then((fn) => fn?.());
      void cleanupError.then((fn) => fn?.());
    };
    // Subscriptions install once per mount; session filtering uses refs.
  }, [setPartialTranscript, setDictationState, stopCapture, discardBufferedAudio, notify]);

  return (
    <>
      <DictationIndicator />
      <VoiceNotice />
    </>
  );
}
