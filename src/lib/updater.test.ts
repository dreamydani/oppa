import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resolveChannel } from "./channel";
import { checkForUpdate, type UpdateInfo } from "./updater";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

async function setChannel(channel: "dev" | "stable") {
  invokeMock.mockResolvedValue(channel);
  await resolveChannel();
}

describe("updater seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // The channel cache is module-level; force a failed resolve to clear it
    // so tests don't leak a cached channel into each other (see channel.ts).
    invokeMock.mockRejectedValue(new Error("reset"));
    await resolveChannel();
  });

  it("returns null on dev and never calls check_for_update", async () => {
    await setChannel("dev");
    const result = await checkForUpdate();
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("check_for_update");
  });

  it("returns null when the channel is unresolved", async () => {
    const result = await checkForUpdate();
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("check_for_update");
  });

  it("invokes check_for_update on stable and returns the update info", async () => {
    await setChannel("stable");
    const payload: UpdateInfo = {
      version: "0.2.0",
      download:
        "https://github.com/dreamydani/oppa/releases/download/v0.2.0/oppa_0.2.0_x64-setup.exe",
      available: true,
    };
    invokeMock.mockResolvedValue(payload);
    const result = await checkForUpdate();
    expect(invokeMock).toHaveBeenCalledWith("check_for_update");
    expect(result).toEqual(payload);
  });

  it("returns null when invoke rejects (offline / 404 / bad JSON)", async () => {
    await setChannel("stable");
    invokeMock.mockRejectedValue(new Error("network down"));
    const result = await checkForUpdate();
    expect(result).toBeNull();
  });
});
