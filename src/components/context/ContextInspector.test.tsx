import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within, fireEvent, waitFor } from "@testing-library/react";
import { ContextInspector } from "./ContextInspector";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import * as contextTransport from "../../lib/context/transport";
import type { ContextPage, AgentPersona } from "../../lib/context/transport";

vi.mock("../../lib/context/transport", () => ({
  deleteContextPage: vi.fn(),
  restoreContextPage: vi.fn(),
  upsertContextPage: vi.fn(),
  upsertPersona: vi.fn(),
  listContextPages: vi.fn(),
  listPersonas: vi.fn(),
  searchContext: vi.fn(),
  getContextPage: vi.fn(),
  exportContext: vi.fn(),
  importContext: vi.fn(),
}));

const mockPage: ContextPage = {
  id: "p1",
  scope: "workspace",
  category: "quirk",
  path: "quirks/x",
  title: "X",
  icon: "bug",
  abstract_l0: "a",
  overview_l1: "b",
  details_l2: "c",
  pinned: false,
  is_built_in: false,
  attached_scopes_json: "[]",
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
};

const mockBuiltIn: ContextPage = {
  id: "debugger",
  scope: "global",
  category: "persona",
  path: "personas/debugger",
  title: "Debugger",
  icon: "bug",
  abstract_l0: "a",
  overview_l1: "b",
  details_l2: undefined,
  pinned: false,
  is_built_in: true,
  attached_scopes_json: "[\"workspace\",\"quirks\"]",
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
};

const mockDeletedPage: ContextPage = {
  id: "p2",
  scope: "workspace",
  category: "runbook",
  path: "runbooks/deploy",
  title: "Deploy Runbook",
  icon: "run",
  abstract_l0: "a",
  overview_l1: "b",
  details_l2: "c",
  pinned: false,
  is_built_in: false,
  attached_scopes_json: "[]",
  created_at: 0,
  updated_at: 0,
  deleted_at: 12345,
};

const mockCustomPersonaPage: ContextPage = {
  id: "custom-role",
  scope: "workspace",
  category: "persona",
  path: "personas/custom-role",
  title: "Custom Role",
  icon: "persona",
  abstract_l0: "tagline",
  overview_l1: "rules",
  details_l2: undefined,
  pinned: false,
  is_built_in: false,
  attached_scopes_json: "[\"workspace\"]",
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
};

describe("ContextInspector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(contextTransport.listContextPages).mockResolvedValue({
      items: [mockPage, mockBuiltIn, mockDeletedPage, mockCustomPersonaPage],
      total: 4,
    });
    vi.mocked(contextTransport.listPersonas).mockResolvedValue([]);
    vi.mocked(contextTransport.restoreContextPage).mockResolvedValue(undefined);
    vi.mocked(contextTransport.deleteContextPage).mockResolvedValue(undefined);
    vi.mocked(contextTransport.upsertContextPage).mockResolvedValue(undefined);
    vi.mocked(contextTransport.upsertPersona).mockResolvedValue(undefined);

    useContextStore.setState({
      pages: [mockPage, mockBuiltIn, mockDeletedPage, mockCustomPersonaPage],
      personas: [],
      selectedPageId: null,
      selectedPersonaId: null,
      activeTier: "l0",
      searchQuery: "",
      searchResults: [],
      searchResultsSandbox: [],
      sandboxQuery: "",
      isEditing: false,
      isLoading: false,
      lastError: null,
    });
    useTerminalStore.setState({ getActiveCwd: () => undefined } as any);
  });

  it("hides L2 editor for persona pages", () => {
    useContextStore.setState({ selectedPageId: "debugger" });
    const { container } = render(<ContextInspector />);
    fireEvent.click(within(container).getByRole("button", { name: /l2 attached scopes/i }));
    expect(container.querySelector("textarea.inspector-textarea")).toBeNull();
  });

  it("renders scope chips for persona pages under L2 tab", () => {
    useContextStore.setState({ selectedPageId: "debugger" });
    const { container } = render(<ContextInspector />);
    fireEvent.click(within(container).getByRole("button", { name: /l2 attached scopes/i }));
    const chips = container.querySelectorAll(".persona-scope-chip");
    expect(chips.length).toBe(7); // ["global", "workspace", "architecture", "quirks", "runbooks", "preferences", "personas"]
    expect(within(container).getByText("workspace")).toBeTruthy();
    expect(within(container).getByText("quirks")).toBeTruthy();
  });

  it("shows delete for non built-in pages", () => {
    useContextStore.setState({ selectedPageId: "p1" });
    const { container } = render(<ContextInspector />);
    expect(container.querySelector(".inspector-action-btn.delete")).toBeTruthy();
  });

  it("hides delete for built-in personas", () => {
    useContextStore.setState({ selectedPageId: "debugger" });
    const { container } = render(<ContextInspector />);
    expect(container.querySelector(".inspector-action-btn.delete")).toBeNull();
  });

  it("renders error banner when lastError is set with a dismiss button", () => {
    useContextStore.setState({ selectedPageId: "p1", lastError: "Something went wrong" });
    const { container } = render(<ContextInspector />);
    const errorBanner = container.querySelector(".inspector-error-banner");
    expect(errorBanner).toBeTruthy();
    expect(within(errorBanner as HTMLElement).getByText("Something went wrong")).toBeTruthy();

    const dismissBtn = within(errorBanner as HTMLElement).getByRole("button", { name: /dismiss/i });
    fireEvent.click(dismissBtn);
    expect(useContextStore.getState().lastError).toBeNull();
  });

  it("renders restore button for deleted pages", async () => {
    useContextStore.setState({ selectedPageId: "p2" });
    const { container } = render(<ContextInspector />);
    const restoreBtn = container.querySelector(".inspector-action-btn.restore");
    expect(restoreBtn).toBeTruthy();

    fireEvent.click(restoreBtn!);
    await waitFor(() => {
      expect(contextTransport.restoreContextPage).toHaveBeenCalledWith("p2", "workspace", undefined);
    });
  });

  it("saves persona page with attached_scopes_json and details_l2 null/undefined", async () => {
    useContextStore.setState({ selectedPageId: "custom-role", isEditing: true, activeTier: "l2" });
    const { container } = render(<ContextInspector />);

    const archChip = within(container).getByRole("button", { name: "architecture" });
    fireEvent.click(archChip);

    const saveBtn = within(container).getByRole("button", { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(contextTransport.upsertContextPage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "custom-role",
          category: "persona",
          details_l2: undefined,
          attached_scopes_json: expect.stringContaining("architecture"),
        }),
        undefined
      );
    });
  });
});
