import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { useExtensionStore } from "../../store/extensionStore";
import { syncExtensionThemes } from "../../lib/theme/terminalThemes";
import type { ExtensionListItem } from "../../lib/extensions/extensionTransport";

vi.mock("../../lib/extensions/extensionTransport", () => ({
  listExtensions: vi.fn(),
  setExtensionEnabled: vi.fn(),
  getContributions: vi.fn(),
}));

import { listExtensions, getContributions } from "../../lib/extensions/extensionTransport";

const listMock = vi.mocked(listExtensions);
const contributionsMock = vi.mocked(getContributions);

function themePack(overrides: Partial<ExtensionListItem> = {}): ExtensionListItem {
  return {
    id: "oppa.theme-pack",
    name: "Oppa Theme Pack",
    version: "1.0.0",
    description: "Extra terminal themes.",
    is_builtin: true,
    enabled: true,
    error: null,
    theme_count: 3,
    snippet_count: 0,
    command_count: 0,
    ...overrides,
  };
}

describe("ExtensionsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncExtensionThemes([]);
    useExtensionStore.setState({ status: "idle", extensions: [], loadError: null });
  });

  it("loads on mount and lists installed extensions with badges", async () => {
    listMock.mockResolvedValue([themePack()]);
    contributionsMock.mockResolvedValue({ themes: [] });

    render(<ExtensionsPanel />);

    await waitFor(() => {
      expect(screen.getByText("Oppa Theme Pack")).toBeDefined();
    });
    expect(screen.getByText("v1.0.0")).toBeDefined();
    expect(screen.getByText("Built-in")).toBeDefined();
    expect(screen.getByText("3 themes")).toBeDefined();
    expect(screen.getByRole("switch", { name: "Enable Oppa Theme Pack" })).toBeDefined();
  });

  it("shows an empty state when nothing is installed", async () => {
    listMock.mockResolvedValue([]);
    contributionsMock.mockResolvedValue({ themes: [] });

    render(<ExtensionsPanel />);

    await waitFor(() => {
      expect(screen.getByText("No extensions installed.")).toBeDefined();
    });
  });

  it("errored entries show a failure badge and expose no enable switch", async () => {
    listMock.mockResolvedValue([
      themePack({
        id: "",
        name: "broken-dir",
        version: "",
        description: "",
        enabled: false,
        error: "manifest is not valid JSON",
      }),
    ]);
    contributionsMock.mockResolvedValue({ themes: [] });

    render(<ExtensionsPanel />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load")).toBeDefined();
    });
    expect(screen.getByText(/manifest is not valid JSON/)).toBeDefined();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("toggling the switch flips the extension through the store", async () => {
    listMock.mockResolvedValue([themePack({ enabled: true })]);
    contributionsMock.mockResolvedValue({ themes: [] });
    const toggleSpy = vi
      .spyOn(useExtensionStore.getState(), "toggleExtension")
      .mockResolvedValue(undefined);

    render(<ExtensionsPanel />);
    const sw = await screen.findByRole("switch", { name: "Enable Oppa Theme Pack" });
    fireEvent.click(sw);

    expect(toggleSpy).toHaveBeenCalledWith("oppa.theme-pack", false);
    toggleSpy.mockRestore();
  });

  it("explains an unavailable backend instead of listing nothing", async () => {
    listMock.mockRejectedValue(new Error("registry missing"));

    render(<ExtensionsPanel />);

    await waitFor(() => {
      expect(screen.getByText("Extensions are unavailable in this session.")).toBeDefined();
    });
    expect(screen.getByText(/registry missing/)).toBeDefined();
  });
});
