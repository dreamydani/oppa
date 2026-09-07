import { describe, it, expect, vi } from "vitest";
import {
  SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE,
  buildAudioCaptureConstraints,
  buildVoiceMicrophoneSelectOptions,
  isMicrophoneDeviceConstraintError,
  listVoiceMicrophoneDevices,
  microphoneDeviceIdFromSelectValue,
  microphoneSelectValueFromDeviceId,
  normalizeMicrophoneDeviceId,
  openMicrophoneCaptureStream,
  resolveMicrophoneDevice,
  type VoiceMicrophoneDevice,
} from "./microphoneDevices";

const DEVICES: VoiceMicrophoneDevice[] = [
  { deviceId: "mic-1", label: "USB Mic" },
  { deviceId: "mic-2", label: "Headset" },
];

function fakeStream(): MediaStream {
  return { getTracks: () => [] } as unknown as MediaStream;
}

describe("microphoneDevices", () => {
  describe("normalizeMicrophoneDeviceId", () => {
    it("maps sentinels, blanks, and non-strings to null", () => {
      expect(normalizeMicrophoneDeviceId(null)).toBeNull();
      expect(normalizeMicrophoneDeviceId(undefined)).toBeNull();
      expect(normalizeMicrophoneDeviceId("")).toBeNull();
      expect(normalizeMicrophoneDeviceId("   ")).toBeNull();
      expect(normalizeMicrophoneDeviceId("default")).toBeNull();
      expect(normalizeMicrophoneDeviceId("communications")).toBeNull();
      expect(normalizeMicrophoneDeviceId("mic-1")).toBe("mic-1");
      expect(normalizeMicrophoneDeviceId("  mic-1  ")).toBe("mic-1");
    });
  });

  describe("buildAudioCaptureConstraints", () => {
    it("requests enhanced mono audio with exact device when preferred", () => {
      const c = buildAudioCaptureConstraints("mic-1");
      expect(c.audio).toMatchObject({
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: "mic-1" },
      });
    });

    it("omits deviceId for system default", () => {
      const c = buildAudioCaptureConstraints(null);
      expect(c.audio).toMatchObject({ echoCancellation: true });
      expect(c.audio).not.toHaveProperty("deviceId");
    });
  });

  describe("isMicrophoneDeviceConstraintError", () => {
    it("matches Overconstrained/NotFound only", () => {
      expect(isMicrophoneDeviceConstraintError({ name: "OverconstrainedError" })).toBe(true);
      expect(isMicrophoneDeviceConstraintError({ name: "NotFoundError" })).toBe(true);
      expect(isMicrophoneDeviceConstraintError({ name: "NotAllowedError" })).toBe(false);
      expect(isMicrophoneDeviceConstraintError(null)).toBe(false);
      expect(isMicrophoneDeviceConstraintError("nope")).toBe(false);
    });
  });

  describe("listVoiceMicrophoneDevices", () => {
    it("keeps audioinputs, drops sentinels, and falls back to indexed labels", () => {
      const list = listVoiceMicrophoneDevices([
        { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
        { deviceId: "default", kind: "audioinput", label: "Default" },
        { deviceId: "cam-1", kind: "videoinput", label: "Cam" },
        { deviceId: "mic-9", kind: "audioinput", label: "" },
      ]);
      expect(list).toEqual([
        { deviceId: "mic-1", label: "USB Mic" },
        { deviceId: "mic-9", label: "Microphone 2" },
      ]);
    });
  });

  describe("resolveMicrophoneDevice", () => {
    it("resolves system-default, exact, relabeled, missing, unknown", () => {
      expect(resolveMicrophoneDevice({ devices: DEVICES, preferredDeviceId: null, preferredDeviceLabel: null }))
        .toEqual({ deviceId: null, kind: "system-default" });
      expect(resolveMicrophoneDevice({ devices: DEVICES, preferredDeviceId: "mic-1", preferredDeviceLabel: null }))
        .toEqual({ deviceId: "mic-1", kind: "exact" });
      // Re-salted id heals via the surviving unique label.
      expect(resolveMicrophoneDevice({ devices: DEVICES, preferredDeviceId: "mic-9", preferredDeviceLabel: "Headset" }))
        .toEqual({ deviceId: "mic-2", kind: "relabeled" });
      // Ambiguous labels never heal.
      const dupes = [...DEVICES, { deviceId: "mic-3", label: "Headset" }];
      expect(resolveMicrophoneDevice({ devices: dupes, preferredDeviceId: "mic-9", preferredDeviceLabel: "Headset" }).kind)
        .toBe("missing");
      expect(resolveMicrophoneDevice({ devices: [], preferredDeviceId: "mic-9", preferredDeviceLabel: null }).kind)
        .toBe("unknown");
      expect(resolveMicrophoneDevice({ devices: null, preferredDeviceId: "mic-9", preferredDeviceLabel: null }).kind)
        .toBe("unknown");
    });
  });

  describe("openMicrophoneCaptureStream", () => {
    it("opens the default stream without fallback when no preference", async () => {
      const getUserMedia = vi.fn().mockResolvedValue(fakeStream());
      const result = await openMicrophoneCaptureStream({ preferredDeviceId: null, getUserMedia });
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(getUserMedia.mock.calls[0][0].audio).not.toHaveProperty("deviceId");
      expect(result.fellBackToDefaultMicrophone).toBe(false);
      expect(result.usedDeviceId).toBeNull();
    });

    it("opens the preferred device exactly when present", async () => {
      const getUserMedia = vi.fn().mockResolvedValue(fakeStream());
      const enumerateDevices = vi.fn().mockResolvedValue([
        { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
      ]);
      const result = await openMicrophoneCaptureStream({
        preferredDeviceId: "mic-1",
        getUserMedia,
        enumerateDevices,
      });
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ fellBackToDefaultMicrophone: false, usedDeviceId: "mic-1" });
    });

    it("skips the failed round trip for a known-missing device", async () => {
      const getUserMedia = vi.fn().mockResolvedValue(fakeStream());
      const enumerateDevices = vi.fn().mockResolvedValue([
        { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
      ]);
      const result = await openMicrophoneCaptureStream({
        preferredDeviceId: "mic-gone",
        getUserMedia,
        enumerateDevices,
      });
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(getUserMedia.mock.calls[0][0].audio).not.toHaveProperty("deviceId");
      expect(result.fellBackToDefaultMicrophone).toBe(true);
    });

    it("falls back when the device vanishes between enumerate and capture", async () => {
      const overconstrained = Object.assign(new Error("gone"), { name: "OverconstrainedError" });
      const getUserMedia = vi
        .fn()
        .mockRejectedValueOnce(overconstrained)
        .mockResolvedValue(fakeStream());
      const enumerateDevices = vi.fn().mockResolvedValue([
        { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
      ]);
      const result = await openMicrophoneCaptureStream({
        preferredDeviceId: "mic-1",
        getUserMedia,
        enumerateDevices,
      });
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(result.fellBackToDefaultMicrophone).toBe(true);
    });

    it("rethrows non-constraint errors like permission denial", async () => {
      const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
      const getUserMedia = vi.fn().mockRejectedValue(denied);
      await expect(
        openMicrophoneCaptureStream({ preferredDeviceId: "mic-1", getUserMedia }),
      ).rejects.toBe(denied);
    });
  });

  describe("select value helpers", () => {
    it("round-trips null through the system-default sentinel", () => {
      expect(microphoneSelectValueFromDeviceId(null)).toBe(SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE);
      expect(microphoneDeviceIdFromSelectValue(SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE)).toBeNull();
      expect(microphoneDeviceIdFromSelectValue("mic-1")).toBe("mic-1");
      expect(microphoneDeviceIdFromSelectValue("default")).toBeNull();
    });
  });

  describe("buildVoiceMicrophoneSelectOptions", () => {
    const base = {
      devices: DEVICES,
      preferredDeviceLabel: null as string | null,
      systemDefaultLabel: "System default",
      unavailableSuffix: "unplugged",
    };

    it("selects system default when nothing is preferred", () => {
      const { options, selectedValue } = buildVoiceMicrophoneSelectOptions({
        ...base,
        devicesKnown: true,
        preferredDeviceId: null,
      });
      expect(selectedValue).toBe(SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE);
      expect(options).toHaveLength(3);
    });

    it("marks the preferred device unavailable only once the list is known", () => {
      // "Old Mic" matches no live label, so no label-heal applies — truly missing.
      const missing = buildVoiceMicrophoneSelectOptions({
        ...base,
        devicesKnown: true,
        preferredDeviceId: "mic-9",
        preferredDeviceLabel: "Old Mic",
      });
      expect(missing.selectedValue).toBe("mic-9");
      expect(missing.options[missing.options.length - 1]).toEqual({
        value: "mic-9",
        label: "Old Mic (unplugged)",
        unavailable: true,
      });

      const unknown = buildVoiceMicrophoneSelectOptions({
        ...base,
        devicesKnown: false,
        preferredDeviceId: "mic-9",
        preferredDeviceLabel: "Old Mic",
      });
      expect(unknown.selectedValue).toBe("mic-9");
      expect(unknown.options[unknown.options.length - 1]).toEqual({
        value: "mic-9",
        label: "Old Mic",
      });
    });

    it("heals a re-salted device id through its surviving label", () => {
      const healed = buildVoiceMicrophoneSelectOptions({
        ...base,
        devicesKnown: true,
        preferredDeviceId: "mic-9",
        preferredDeviceLabel: "Headset",
      });
      expect(healed.selectedValue).toBe("mic-2");
      expect(healed.options).toHaveLength(3);
    });
  });
});
