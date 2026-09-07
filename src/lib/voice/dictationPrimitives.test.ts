import { describe, it, expect, vi } from "vitest";
import { formatFinalTranscriptSegment } from "./dictationSegments";
import {
  recordStoppedSession,
  waitForStoppedSession,
  type RefLike,
} from "./dictationSessions";
import {
  DICTATION_CONTROL_EVENT,
  dispatchDictationControl,
  type DictationControlAction,
} from "./dictationControl";

describe("formatFinalTranscriptSegment", () => {
  it("joins word chunks with a space", () => {
    expect(formatFinalTranscriptSegment("world", "hello")).toBe(" world");
  });

  it("respects existing boundary whitespace", () => {
    expect(formatFinalTranscriptSegment("world", "hello ")).toBe("world");
    expect(formatFinalTranscriptSegment(" world", "hello")).toBe(" world");
  });

  it("skips the space before punctuation", () => {
    expect(formatFinalTranscriptSegment(",", "hello")).toBe(",");
    expect(formatFinalTranscriptSegment(".", "hello")).toBe(".");
  });

  it("adds a space after sentence punctuation before a word", () => {
    expect(formatFinalTranscriptSegment("World", "hello.")).toBe(" World");
  });

  it("skips spaces around CJK characters", () => {
    expect(formatFinalTranscriptSegment("世界", "hello")).toBe("世界");
    expect(formatFinalTranscriptSegment("world", "你好")).toBe("world");
    expect(formatFinalTranscriptSegment("世界", "你好")).toBe("世界");
  });

  it("skips the space after opening brackets", () => {
    expect(formatFinalTranscriptSegment("hello", "(")).toBe("hello");
  });

  it("returns the first segment untouched", () => {
    expect(formatFinalTranscriptSegment("hello", "")).toBe("hello");
  });
});

describe("stopped sessions", () => {
  function refs() {
    const stoppedSessionIdsRef: RefLike<Set<string>> = { current: new Set() };
    const stoppedResolversRef: RefLike<Map<string, () => void>> = { current: new Map() };
    return { stoppedSessionIdsRef, stoppedResolversRef };
  }

  it("resolves immediately when the stopped event arrived early", async () => {
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs();
    recordStoppedSession("7", stoppedSessionIdsRef, stoppedResolversRef);
    await expect(
      waitForStoppedSession("7", stoppedSessionIdsRef, stoppedResolversRef),
    ).resolves.toBeUndefined();
  });

  it("resolves when a later stopped event arrives", async () => {
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs();
    const waited = waitForStoppedSession("8", stoppedSessionIdsRef, stoppedResolversRef);
    recordStoppedSession("8", stoppedSessionIdsRef, stoppedResolversRef);
    await expect(waited).resolves.toBeUndefined();
  });

  it("times out instead of hanging a session forever", async () => {
    vi.useFakeTimers();
    try {
      const { stoppedSessionIdsRef, stoppedResolversRef } = refs();
      const waited = waitForStoppedSession("9", stoppedSessionIdsRef, stoppedResolversRef);
      const settled = vi.fn();
      void waited.then(settled);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the early-event cache", () => {
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs();
    for (let i = 0; i < 20; i++) {
      recordStoppedSession(String(i), stoppedSessionIdsRef, stoppedResolversRef);
    }
    expect(stoppedSessionIdsRef.current.size).toBeLessThanOrEqual(16);
    expect(stoppedSessionIdsRef.current.has("19")).toBe(true);
  });
});

describe("dictation control bus", () => {
  it("dispatches toggle/start/stop actions on the document", () => {
    const seen: DictationControlAction[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<DictationControlAction>).detail);
    };
    document.addEventListener(DICTATION_CONTROL_EVENT, listener);
    try {
      dispatchDictationControl("toggle");
      dispatchDictationControl("start");
      dispatchDictationControl("stop");
      expect(seen).toEqual(["toggle", "start", "stop"]);
    } finally {
      document.removeEventListener(DICTATION_CONTROL_EVENT, listener);
    }
  });
});
