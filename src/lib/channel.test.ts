import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  applyChannelIdentity,
  resolveChannel,
  getChannel,
  windowTitleForChannel,
} from "./channel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("channel identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.title = "";
  });

  it("sets document.title to Developer OPPA when the channel is dev", async () => {
    invokeMock.mockResolvedValue("dev");
    const channel = await applyChannelIdentity();
    expect(invokeMock).toHaveBeenCalledWith("app_channel");
    expect(channel).toBe("dev");
    expect(document.title).toBe("Developer OPPA");
  });

  it("sets document.title to oppa when the channel is stable", async () => {
    invokeMock.mockResolvedValue("stable");
    const channel = await applyChannelIdentity();
    expect(channel).toBe("stable");
    expect(document.title).toBe("oppa");
  });

  it("falls back to oppa title when the channel cannot be resolved", async () => {
    invokeMock.mockRejectedValue(new Error("not in tauri"));
    const channel = await applyChannelIdentity();
    expect(channel).toBeNull();
    expect(document.title).toBe("oppa");
  });

  it("caches the resolved channel for later tasks", async () => {
    invokeMock.mockResolvedValue("dev");
    const channel = await resolveChannel();
    expect(channel).toBe("dev");
    expect(getChannel()).toBe("dev");
  });

  it("windowTitleForChannel maps dev to Developer OPPA and stable to oppa", () => {
    expect(windowTitleForChannel("dev")).toBe("Developer OPPA");
    expect(windowTitleForChannel("stable")).toBe("oppa");
    expect(windowTitleForChannel(null)).toBe("oppa");
  });
});
