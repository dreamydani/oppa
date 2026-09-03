import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { resolveChannel } from "./channel";
import { downloadNativeUpdate } from "./updater";
import { useTerminalStore } from "../store/terminalStore";
import {
  startUpdateScheduler,
  requestManualCheck,
  MANUAL_UPDATE_CHECK_EVENT,
  UPDATE_AVAILABILITY_EVENT,
  UPDATE_INITIAL_DELAY_MS,
  UPDATE_DAILY_INTERVAL_MS,
  UPDATE_RECHECK_FLOOR_MS,
  UPDATE_BACKOFF_BASE_MS,
  UPDATE_BACKOFF_CAP_MS,
  type UpdateAvailabilityDetail,
} from "./updateScheduler";

// Scheduler tests drive the REAL updater seams with mocked backends (the
// updater.test.ts module-mock pattern): the plugin `check` + `app_channel`
// and `check_for_update` invokes are stubbed, so every assertion observes the
// full scheduler → seam → event pipeline, including supersede-close.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const checkMock = vi.mocked(check);

const LEGACY_AVAILABLE = {
  version: "0.2.0",
  download: "https://example.com/oppa-0.2.0.exe",
  available: true,
};

// Legacy payload served per test; null means the legacy seam reports empty.
let legacyPayload: Record<string, unknown> | null = null;

function routeInvokes() {
  invokeMock.mockImplementation((cmd) => {
    if (cmd === "app_channel") return Promise.resolve("stable");
    if (cmd === "check_for_update") return Promise.resolve(legacyPayload);
    return Promise.resolve(undefined);
  });
}

function fakeNativeUpdate(version: string, close?: () => unknown) {
  return {
    version,
    currentVersion: "0.2.3",
    date: "2026-09-04",
    body: "notes",
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    ...(close ? { close } : {}),
  } as unknown as Update;
}

function setAutoCheckUpdates(value: boolean) {
  useTerminalStore.setState({
    settings: {
      ...useTerminalStore.getState().settings,
      general: { ...useTerminalStore.getState().settings.general, autoCheckUpdates: value },
    },
  });
}

function setLastCheckAt(value: number | null) {
  useTerminalStore.setState({
    settings: {
      ...useTerminalStore.getState().settings,
      general: { ...useTerminalStore.getState().settings.general, lastCheckAt: value },
    },
  });
}

function availabilityEvents(): UpdateAvailabilityDetail[] {
  return windowAvailability.filter((e) => e.type === UPDATE_AVAILABILITY_EVENT).map(
    (e) => (e as CustomEvent<UpdateAvailabilityDetail>).detail,
  );
}

function lastAvailability(): UpdateAvailabilityDetail {
  const events = availabilityEvents();
  return events[events.length - 1];
}

let windowAvailability: Event[] = [];
let stopFns: Array<() => void> = [];

function onWindowEvent(event: Event) {
  windowAvailability.push(event);
}

function fireFocus() {
  window.dispatchEvent(new Event("focus"));
}

function fireOnline() {
  window.dispatchEvent(new Event("online"));
}

beforeEach(() => {
  vi.useFakeTimers();
  windowAvailability = [];
  stopFns = [];
  legacyPayload = null;
  vi.clearAllMocks();
  routeInvokes();
  setAutoCheckUpdates(true);
  setLastCheckAt(null);
  useTerminalStore.setState({
    settings: {
      ...useTerminalStore.getState().settings,
      general: { ...useTerminalStore.getState().settings.general, dismissedUpdateVersion: null },
    },
  });
  window.addEventListener(UPDATE_AVAILABILITY_EVENT, onWindowEvent);
});

afterEach(async () => {
  for (const stop of stopFns) stop();
  window.removeEventListener(UPDATE_AVAILABILITY_EVENT, onWindowEvent);
  vi.useRealTimers();
  // Clear the module-level channel cache so tests never leak it (same reset
  // pattern as updater.test.ts).
  invokeMock.mockRejectedValue(new Error("reset"));
  await resolveChannel();
});

describe("updateScheduler", () => {
  it("exposes the documented timing constants", () => {
    expect(UPDATE_INITIAL_DELAY_MS).toBe(30_000);
    expect(UPDATE_DAILY_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(UPDATE_RECHECK_FLOOR_MS).toBe(6 * 60 * 60 * 1000);
    expect(UPDATE_BACKOFF_BASE_MS).toBe(60 * 60 * 1000);
    expect(UPDATE_BACKOFF_CAP_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("defers the mount check ~30s past start so cold startup stays fast", async () => {
    checkMock.mockResolvedValue(null);
    stopFns.push(startUpdateScheduler());
    expect(checkMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(29_000);
    expect(checkMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("honors an injected initial delay", async () => {
    checkMock.mockResolvedValue(null);
    stopFns.push(startUpdateScheduler({ initialDelayMs: 5_000 }));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(checkMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("re-checks on the daily tick after a resolved check", async () => {
    checkMock.mockResolvedValue(fakeNativeUpdate("0.3.0"));
    stopFns.push(startUpdateScheduler());

    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(lastAvailability()).toMatchObject({ version: "0.3.0", phase: "available" });

    await vi.advanceTimersByTimeAsync(UPDATE_DAILY_INTERVAL_MS - 1);
    expect(checkMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it("backs off to 1h (not 24h) after a failed check, doubling to a 6h cap", async () => {
    checkMock.mockResolvedValue(null);
    legacyPayload = null;
    stopFns.push(startUpdateScheduler());

    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
    expect(checkMock).toHaveBeenCalledTimes(1);

    // Not daily: the retry comes an hour later, not a day later.
    await vi.advanceTimersByTimeAsync(UPDATE_BACKOFF_BASE_MS - 1);
    expect(checkMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkMock).toHaveBeenCalledTimes(2);

    // Second consecutive failure doubles to 2h.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 - 1);
    expect(checkMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkMock).toHaveBeenCalledTimes(3);

    // Third failure → 4h, fourth → 6h cap (8h would exceed it).
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(checkMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(UPDATE_BACKOFF_CAP_MS - 1);
    expect(checkMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkMock).toHaveBeenCalledTimes(5);
  });

  it("skips focus/online triggers within the 6h floor, fires past it", async () => {
    checkMock.mockResolvedValue(fakeNativeUpdate("0.3.0"));
    stopFns.push(startUpdateScheduler());

    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().settings.general.lastCheckAt).not.toBeNull();

    fireFocus();
    fireOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_FLOOR_MS);
    fireFocus();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it("manual requests bypass the floor", async () => {
    checkMock.mockResolvedValue(fakeNativeUpdate("0.3.0"));
    stopFns.push(startUpdateScheduler());

    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
    expect(checkMock).toHaveBeenCalledTimes(1);

    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(lastAvailability()).toMatchObject({ version: "0.3.0", phase: "available" });
  });

  it("disables all automatic checks when opted out, but never manual ones", async () => {
    setAutoCheckUpdates(false);
    checkMock.mockResolvedValue(fakeNativeUpdate("0.3.0"));
    stopFns.push(startUpdateScheduler());

    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
    fireFocus();
    fireOnline();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(checkMock).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "check_for_update")).toBe(false);

    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(lastAvailability()).toMatchObject({ version: "0.3.0", phase: "available" });
  });

  it("coalesces concurrent triggers into a single in-flight check", async () => {
    let resolveCheck!: (value: Update | null) => void;
    checkMock.mockImplementation(
      () => new Promise<Update | null>((resolve) => { resolveCheck = resolve; }),
    );
    stopFns.push(startUpdateScheduler());

    requestManualCheck();
    requestManualCheck();
    fireFocus();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkMock).toHaveBeenCalledTimes(1);

    resolveCheck(fakeNativeUpdate("0.3.0"));
    await vi.advanceTimersByTimeAsync(0);
    expect(checkMock).toHaveBeenCalledTimes(1);
    // One check ⇒ one announcement, not one per trigger.
    expect(availabilityEvents().filter((d) => d.version === "0.3.0")).toHaveLength(1);
  });

  it("closes the displaced native Update when a new check supersedes it", async () => {
    const closeA = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue(fakeNativeUpdate("0.3.0", closeA));
    stopFns.push(startUpdateScheduler());

    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastAvailability()).toMatchObject({ version: "0.3.0" });
    expect(closeA).not.toHaveBeenCalled();

    const closeB = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue(fakeNativeUpdate("0.3.1", closeB));
    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastAvailability()).toMatchObject({ version: "0.3.1" });
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();
  });

  it("announces the legacy fallback and clears on a resolved negative", async () => {
    checkMock.mockResolvedValue(null);
    legacyPayload = { ...LEGACY_AVAILABLE };
    stopFns.push(startUpdateScheduler());

    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastAvailability()).toMatchObject({
      version: "0.2.0",
      phase: "available",
      engine: "legacy",
      download: "https://example.com/oppa-0.2.0.exe",
    });

    // The release was pulled: a resolving available:false clears the card.
    legacyPayload = { ...LEGACY_AVAILABLE, available: false };
    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastAvailability()).toMatchObject({ version: null, phase: null });
  });

  it("automatic failure preserves a staged download (no clear, pending survives)", async () => {
    const update = fakeNativeUpdate("0.3.0");
    const pluginDownload = vi.mocked(update.download);
    checkMock.mockResolvedValue(update);
    stopFns.push(startUpdateScheduler());

    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastAvailability()).toMatchObject({ version: "0.3.0", phase: "available" });
    expect(await downloadNativeUpdate(() => {})).toEqual({ ok: true });
    expect(pluginDownload).toHaveBeenCalledTimes(1);

    // The background check fails (offline): no clear is announced…
    checkMock.mockResolvedValue(null);
    legacyPayload = null;
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
    expect(checkMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_FLOOR_MS);
    expect(checkMock).toHaveBeenCalledTimes(2);

    // …so the card offer stands and the staged pending is still downloadable.
    expect(availabilityEvents().every((d) => d.version !== null)).toBe(true);
    expect(lastAvailability()).toMatchObject({ version: "0.3.0", phase: "available" });
    expect(await downloadNativeUpdate(() => {})).toEqual({ ok: true });
    expect(pluginDownload).toHaveBeenCalledTimes(1);
  });

  it("manual failure still announces a clear (resolves the checking state)", async () => {
    checkMock.mockResolvedValue(null);
    legacyPayload = null;
    stopFns.push(startUpdateScheduler());

    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastAvailability()).toMatchObject({ version: null, phase: null });
  });

  it("manual failures do not step the backoff ladder", async () => {
    checkMock.mockResolvedValue(null);
    legacyPayload = null;
    stopFns.push(startUpdateScheduler());

    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
    expect(checkMock).toHaveBeenCalledTimes(1);

    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkMock).toHaveBeenCalledTimes(3);

    // Still on the original 1h rung: the next background check fires on time.
    await vi.advanceTimersByTimeAsync(UPDATE_BACKOFF_BASE_MS - 1);
    expect(checkMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkMock).toHaveBeenCalledTimes(4);
  });

  it("stop removes all listeners and timers", async () => {
    checkMock.mockResolvedValue(fakeNativeUpdate("0.3.0"));
    const stop = startUpdateScheduler();
    stop();

    await vi.advanceTimersByTimeAsync(72 * 60 * 60 * 1000);
    fireFocus();
    fireOnline();
    requestManualCheck();
    await vi.advanceTimersByTimeAsync(0);

    expect(checkMock).not.toHaveBeenCalled();
    expect(availabilityEvents()).toHaveLength(0);
  });

  it("keeps the daily chain alive when a bus listener throws", async () => {
    checkMock.mockResolvedValue(fakeNativeUpdate("0.3.0"));
    const throwing = () => {
      throw new Error("listener blew up");
    };
    window.addEventListener(UPDATE_AVAILABILITY_EVENT, throwing);
    try {
      stopFns.push(startUpdateScheduler());
      await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
      expect(checkMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(UPDATE_DAILY_INTERVAL_MS);
      expect(checkMock).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(UPDATE_AVAILABILITY_EVENT, throwing);
    }
  });

  it("requestManualCheck dispatches the shared manual event", () => {
    const seen: string[] = [];
    const listener = (event: Event) => seen.push(event.type);
    window.addEventListener(MANUAL_UPDATE_CHECK_EVENT, listener);
    try {
      requestManualCheck();
      expect(seen).toEqual([MANUAL_UPDATE_CHECK_EVENT]);
    } finally {
      window.removeEventListener(MANUAL_UPDATE_CHECK_EVENT, listener);
    }
  });
});

