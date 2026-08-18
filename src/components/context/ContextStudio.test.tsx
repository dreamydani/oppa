import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { useContextStore } from "../../store/contextStore";
import { ContextStudio } from "./ContextStudio";
import { TitleBar } from "../TitleBar";
import { AppShell } from "../layout/AppShell";
import * as contextTransport from "../../lib/context/transport";
import type { ContextPage, AgentPersona, ContextSearchResult } from "../../lib/context/transport";

vi.mock("../../lib/context/transport", () => ({
  listContextPages: vi.fn(),
  getContextPage: vi.fn(),
  upsertContextPage: vi.fn(),
  deleteContextPage: vi.fn(),
  searchContext: vi.fn(),
  listPersonas: vi.fn(),
  upsertPersona: vi.fn(),
}));

vi.mock("../../lib/pty/transport", () => ({
  ptySpawn: vi.fn().mockResolvedValue("s1"),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  onPtyData: vi.fn().mockResolvedValue(vi.fn()),
  onPtyExit: vi.fn().mockResolvedValue(vi.fn()),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/fs/transport", () => ({
  readDir: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/git/transport", () => ({
  getGitStatus: vi.fn().mockResolvedValue({
    is_git: false,
    branch: "",
    files: [],
    ahead: 0,
    behind: 0,
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

const mockPage1: ContextPage = {
  id: "page-arch-1",
  scope: "workspace",
  category: "architecture",
  path: "architecture/core-engine",
  title: "Core Architecture Engine",
  icon: "🏗️",
  abstract_l0: "L0 summary of the core engine",
  overview_l1: "## L1 Overview\nDetailed multi-process IPC architecture description.",
  details_l2: "### L2 Details\nRaw low-level Tokio named pipes protocol implementation.",
  pinned: false,
  created_at: 1000,
  updated_at: 2000,
};

const mockPage2: ContextPage = {
  id: "page-quirk-1",
  scope: "workspace",
  category: "quirk",
  path: "quirks/conpty-newline",
  title: "ConPTY Newline Bug",
  icon: "🐛",
  abstract_l0: "L0 summary of ConPTY bug",
  overview_l1: "ConPTY translates CR LF on Windows.",
  details_l2: "Raw details on workaround.",
  pinned: true,
  created_at: 1100,
  updated_at: 2100,
};

const mockPage3: ContextPage = {
  id: "page-runbook-1",
  scope: "workspace",
  category: "runbook",
  path: "runbooks/deploy",
  title: "Deploy Runbook",
  icon: "⚡",
  abstract_l0: "Deployment runbook abstract",
  overview_l1: "Run cargo build and pnpm build.",
  pinned: false,
  created_at: 1200,
  updated_at: 2200,
};

const mockGlobalPage: ContextPage = {
  id: "page-global-pref-1",
  scope: "global",
  category: "preference",
  path: "preferences/theme",
  title: "Editor Preferences",
  icon: "⚙️",
  abstract_l0: "Global user preferences",
  overview_l1: "Dark-tech theme and Geist font defaults.",
  pinned: false,
  created_at: 900,
  updated_at: 1900,
};

const mockPersona1: AgentPersona = {
  id: "lead-architect",
  name: "Lead Architect",
  icon: "🏛️",
  tagline: "Systems architect and design reviewer",
  system_prompt: "You are a Lead Architect. Review all designs for modularity and performance.",
  attached_scopes: ["global", "workspace", "architecture"],
  is_built_in: true,
};

const mockPersona2: AgentPersona = {
  id: "custom-tester",
  name: "Testing Guru",
  icon: "🧪",
  tagline: "Specialist in Vitest and TDD testing",
  system_prompt: "You are a TDD advocate. Always write failing tests first.",
  attached_scopes: ["workspace", "quirks"],
  is_built_in: false,
};

const mockSearchResult: ContextSearchResult = {
  id: "page-arch-1",
  scope: "workspace",
  category: "architecture",
  path: "architecture/core-engine",
  title: "Core Architecture Engine",
  icon: "🏗️",
  abstract_l0: "L0 summary of the core engine",
  overview_l1: "## L1 Overview\nDetailed multi-process IPC architecture description.",
  snippet: "Multi-process <b>IPC architecture</b> with Tokio named pipes",
};

describe("Context Studio & Workbench Mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(contextTransport.listContextPages).mockResolvedValue([
      mockPage1,
      mockPage2,
      mockPage3,
      mockGlobalPage,
    ]);
    vi.mocked(contextTransport.listPersonas).mockResolvedValue([
      mockPersona1,
      mockPersona2,
    ]);
    vi.mocked(contextTransport.searchContext).mockResolvedValue([mockSearchResult]);
    vi.mocked(contextTransport.upsertContextPage).mockResolvedValue(undefined);
    vi.mocked(contextTransport.deleteContextPage).mockResolvedValue(undefined);
    vi.mocked(contextTransport.upsertPersona).mockResolvedValue(undefined);

    useTerminalStore.setState({
      activeAppMode: "terminal",
      sessions: {
        s1: {
          id: "s1",
          title: "Main Terminal",
          status: "running",
          cols: 80,
          rows: 24,
          cwd: "D:/oppa/oppa",
          personaId: null,
        },
      },
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      ready: true,
    });

    useContextStore.setState({
      pages: [mockPage1, mockPage2, mockPage3, mockGlobalPage],
      personas: [mockPersona1, mockPersona2],
      selectedPageId: null,
      selectedPersonaId: null,
      activeTier: "l0",
      searchQuery: "",
      searchResults: [],
      isEditing: false,
      isLoading: false,
    });
  });

  describe("TitleBar Mode Switcher", () => {
    it("renders context mode tab in TitleBar", () => {
      render(<TitleBar />);
      const contextTab = screen.getByRole("button", { name: /context/i });
      expect(contextTab).toBeTruthy();
    });

    it("clicking context tab switches activeAppMode to 'context'", () => {
      render(<TitleBar />);
      const contextTab = screen.getByRole("button", { name: /context/i });
      fireEvent.click(contextTab);
      expect(useTerminalStore.getState().activeAppMode).toBe("context");
      expect(contextTab.classList.contains("active")).toBe(true);
    });
  });

  describe("AppShell Routing", () => {
    it("renders ContextStudio when activeAppMode is 'context'", () => {
      useTerminalStore.setState({ activeAppMode: "context" });
      const { container } = render(<AppShell />);
      expect(container.querySelector(".context-studio")).toBeTruthy();
    });
  });

  describe("ContextStudio 3-Column Layout & Header", () => {
    it("renders top header bar and 3 columns (tree, inspector, status panel)", () => {
      const { container } = render(<ContextStudio />);
      expect(container.querySelector(".context-studio-header")).toBeTruthy();
      expect(container.querySelector(".context-tree")).toBeTruthy();
      expect(container.querySelector(".context-inspector")).toBeTruthy();
      expect(container.querySelector(".context-status-panel")).toBeTruthy();
    });

    it("renders search input in top bar and triggers search on typing", async () => {
      render(<ContextStudio />);
      const searchInput = screen.getByPlaceholderText(
        /search all context, rules & personas/i
      );
      expect(searchInput).toBeTruthy();

      fireEvent.change(searchInput, { target: { value: "core engine" } });
      await waitFor(() => {
        expect(contextTransport.searchContext).toHaveBeenCalledWith(
          "core engine",
          expect.anything()
        );
      });
    });

    it("renders + Add Item dropdown and toggles menu options", () => {
      const { container } = render(<ContextStudio />);
      const addBtn = screen.getByRole("button", { name: /\+ add item/i });
      expect(addBtn).toBeTruthy();

      fireEvent.click(addBtn);
      const addMenu = container.querySelector(".context-add-menu")!;
      expect(within(addMenu as HTMLElement).getByText(/\+ new memory note/i)).toBeTruthy();
      expect(within(addMenu as HTMLElement).getByText(/\+ new persona/i)).toBeTruthy();
    });

    it("opens PersonaModal when + New Persona is clicked", () => {
      const { container } = render(<ContextStudio />);
      const addBtn = screen.getByRole("button", { name: /\+ add item/i });
      fireEvent.click(addBtn);

      const addMenu = container.querySelector(".context-add-menu")!;
      const newPersonaBtn = within(addMenu as HTMLElement).getByText(/\+ new persona/i);
      fireEvent.click(newPersonaBtn);

      expect(screen.getByRole("dialog", { name: /create persona/i })).toBeTruthy();
    });

    it("creates a draft memory note when + New Memory Note is clicked", async () => {
      const { container } = render(<ContextStudio />);
      const addBtn = screen.getByRole("button", { name: /\+ add item/i });
      fireEvent.click(addBtn);

      const addMenu = container.querySelector(".context-add-menu")!;
      const newNoteBtn = within(addMenu as HTMLElement).getByText(/\+ new memory note/i);
      fireEvent.click(newNoteBtn);

      await waitFor(() => {
        const state = useContextStore.getState();
        expect(state.selectedPageId).toBeTruthy();
        expect(state.isEditing).toBe(true);
      });
    });
  });

  describe("Column 1: ContextTree", () => {
    it("renders Workspace and Global Profile sections", () => {
      const { container } = render(<ContextStudio />);
      const tree = container.querySelector(".context-tree")!;
      expect(within(tree as HTMLElement).getByText(/workspace/i)).toBeTruthy();
      expect(within(tree as HTMLElement).getByText(/global profile/i)).toBeTruthy();
    });

    it("renders category groups (Architecture, Solved Quirks, Runbooks, Personas)", () => {
      const { container } = render(<ContextStudio />);
      const tree = container.querySelector(".context-tree")!;
      expect(within(tree as HTMLElement).getByText("Architecture")).toBeTruthy();
      expect(within(tree as HTMLElement).getByText("Solved Quirks")).toBeTruthy();
      expect(within(tree as HTMLElement).getByText("Runbooks")).toBeTruthy();
      expect(within(tree as HTMLElement).getByText("Personas")).toBeTruthy();
    });

    it("renders individual memory pages and selects page on click", () => {
      const { container } = render(<ContextStudio />);
      const tree = container.querySelector(".context-tree")!;
      const pageNode = within(tree as HTMLElement).getByText("Core Architecture Engine");
      expect(pageNode).toBeTruthy();

      fireEvent.click(pageNode);
      expect(useContextStore.getState().selectedPageId).toBe("page-arch-1");
      expect(useContextStore.getState().selectedPersonaId).toBeNull();
    });

    it("renders personas and selects persona on click", () => {
      const { container } = render(<ContextStudio />);
      const tree = container.querySelector(".context-tree")!;
      const personaNode = within(tree as HTMLElement).getByText("Lead Architect");
      expect(personaNode).toBeTruthy();

      fireEvent.click(personaNode);
      expect(useContextStore.getState().selectedPersonaId).toBe("lead-architect");
      expect(useContextStore.getState().selectedPageId).toBeNull();
    });

    it("allows collapsing and expanding categories", () => {
      const { container } = render(<ContextStudio />);
      const tree = container.querySelector(".context-tree")!;
      const archHeader = within(tree as HTMLElement).getByText("Architecture");
      expect(within(tree as HTMLElement).getByText("Core Architecture Engine")).toBeTruthy();

      fireEvent.click(archHeader);
      // Collapsed: page title hidden in tree
      expect(within(tree as HTMLElement).queryByText("Core Architecture Engine")).toBeNull();

      fireEvent.click(archHeader);
      // Expanded again: page title visible in tree
      expect(within(tree as HTMLElement).getByText("Core Architecture Engine")).toBeTruthy();
    });
  });

  describe("Column 2: ContextInspector", () => {
    it("shows empty state when no page or persona is selected", () => {
      render(<ContextStudio />);
      expect(
        screen.getByText(/select a memory note or persona/i)
      ).toBeTruthy();
    });

    it("renders Memory Page header, path, pin button, and tier sub-tabs", () => {
      useContextStore.setState({ selectedPageId: "page-arch-1", activeTier: "l0" });
      const { container } = render(<ContextStudio />);
      const inspector = container.querySelector(".context-inspector")!;

      expect(within(inspector as HTMLElement).getByText("Core Architecture Engine")).toBeTruthy();
      expect(within(inspector as HTMLElement).getByText("architecture/core-engine")).toBeTruthy();
      expect(within(inspector as HTMLElement).getByRole("button", { name: /pin/i })).toBeTruthy();
      expect(within(inspector as HTMLElement).getByRole("button", { name: /l0 abstract/i })).toBeTruthy();
      expect(within(inspector as HTMLElement).getByRole("button", { name: /l1 overview/i })).toBeTruthy();
      expect(within(inspector as HTMLElement).getByRole("button", { name: /l2 raw details/i })).toBeTruthy();
    });

    it("switches tier sub-tabs (L0 -> L1 -> L2) and displays content", () => {
      useContextStore.setState({ selectedPageId: "page-arch-1", activeTier: "l0" });
      const { container } = render(<ContextStudio />);
      const inspector = container.querySelector(".context-inspector")!;

      expect(within(inspector as HTMLElement).getByText("L0 summary of the core engine")).toBeTruthy();

      const l1Tab = within(inspector as HTMLElement).getByRole("button", { name: /l1 overview/i });
      fireEvent.click(l1Tab);
      expect(useContextStore.getState().activeTier).toBe("l1");
      expect(within(inspector as HTMLElement).getByText(/detailed multi-process ipc architecture/i)).toBeTruthy();

      const l2Tab = within(inspector as HTMLElement).getByRole("button", { name: /l2 raw details/i });
      fireEvent.click(l2Tab);
      expect(useContextStore.getState().activeTier).toBe("l2");
      expect(within(inspector as HTMLElement).getByText(/raw low-level tokio named pipes/i)).toBeTruthy();
    });

    it("toggles pin status when pin button is clicked", async () => {
      useContextStore.setState({ selectedPageId: "page-arch-1" });
      const { container } = render(<ContextStudio />);
      const inspector = container.querySelector(".context-inspector")!;

      const pinBtn = within(inspector as HTMLElement).getByRole("button", { name: /pin/i });
      fireEvent.click(pinBtn);

      await waitFor(() => {
        expect(contextTransport.upsertContextPage).toHaveBeenCalledWith(
          expect.objectContaining({ id: "page-arch-1", pinned: true }),
          expect.anything()
        );
      });
    });

    it("allows editing and saving a memory page", async () => {
      useContextStore.setState({ selectedPageId: "page-arch-1", isEditing: false });
      const { container } = render(<ContextStudio />);
      const inspector = container.querySelector(".context-inspector")!;

      const editBtn = within(inspector as HTMLElement).getByRole("button", { name: /edit/i });
      fireEvent.click(editBtn);

      const titleInput = within(inspector as HTMLElement).getByDisplayValue("Core Architecture Engine");
      fireEvent.change(titleInput, { target: { value: "Updated Architecture Engine" } });

      const saveBtn = within(inspector as HTMLElement).getByRole("button", { name: /save/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(contextTransport.upsertContextPage).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "page-arch-1",
            title: "Updated Architecture Engine",
          }),
          expect.anything()
        );
      });
    });

    it("deletes a memory page when delete button is clicked", async () => {
      useContextStore.setState({ selectedPageId: "page-arch-1" });
      const { container } = render(<ContextStudio />);
      const inspector = container.querySelector(".context-inspector")!;

      const deleteBtn = within(inspector as HTMLElement).getByRole("button", { name: /delete/i });
      fireEvent.click(deleteBtn);

      await waitFor(() => {
        expect(contextTransport.deleteContextPage).toHaveBeenCalledWith(
          "page-arch-1",
          "workspace",
          expect.anything()
        );
      });
    });

    it("renders Persona details when persona is selected", () => {
      useContextStore.setState({ selectedPersonaId: "lead-architect" });
      const { container } = render(<ContextStudio />);
      const inspector = container.querySelector(".context-inspector")!;

      expect(within(inspector as HTMLElement).getByText("Lead Architect")).toBeTruthy();
      expect(
        within(inspector as HTMLElement).getAllByText(
          "Systems architect and design reviewer"
        )[0]
      ).toBeTruthy();
      expect(within(inspector as HTMLElement).getByText(/built-in/i)).toBeTruthy();
      expect(within(inspector as HTMLElement).getByRole("button", { name: /l0 summary/i })).toBeTruthy();
      expect(within(inspector as HTMLElement).getByRole("button", { name: /l1 system rules/i })).toBeTruthy();
      expect(within(inspector as HTMLElement).getByRole("button", { name: /l2 attached scopes/i })).toBeTruthy();
    });

    it("inspects persona system prompt and attached scopes", () => {
      useContextStore.setState({ selectedPersonaId: "lead-architect", activeTier: "l1" });
      const { container } = render(<ContextStudio />);
      const inspector = container.querySelector(".context-inspector")!;

      expect(
        within(inspector as HTMLElement).getByText(/review all designs for modularity and performance/i)
      ).toBeTruthy();

      const l2Tab = within(inspector as HTMLElement).getByRole("button", { name: /l2 attached scopes/i });
      fireEvent.click(l2Tab);

      expect(within(inspector as HTMLElement).getByText("architecture")).toBeTruthy();
    });
  });

  describe("Column 3: ContextStatusPanel", () => {
    it("renders active terminal panes and allows assigning persona", () => {
      const { container } = render(<ContextStudio />);
      const statusPanel = container.querySelector(".context-status-panel")!;

      expect(within(statusPanel as HTMLElement).getByText(/active terminal sessions/i)).toBeTruthy();
      expect(within(statusPanel as HTMLElement).getByText("Main Terminal")).toBeTruthy();

      const personaSelect = within(statusPanel as HTMLElement).getByRole("combobox", {
        name: /assign persona to session main terminal/i,
      });
      expect(personaSelect).toBeTruthy();

      fireEvent.change(personaSelect, { target: { value: "lead-architect" } });
      expect(useTerminalStore.getState().sessions["s1"].personaId).toBe("lead-architect");
    });

    it("renders FTS5 search results with snippet highlights and selects on click", () => {
      useContextStore.setState({
        searchQuery: "IPC architecture",
        searchResults: [mockSearchResult],
      });
      const { container } = render(<ContextStudio />);
      const statusPanel = container.querySelector(".context-status-panel")!;

      expect(within(statusPanel as HTMLElement).getByText(/fts5 search sandbox/i)).toBeTruthy();
      const searchResultItem = within(statusPanel as HTMLElement).getByText("Core Architecture Engine");
      expect(searchResultItem).toBeTruthy();

      fireEvent.click(searchResultItem);
      expect(useContextStore.getState().selectedPageId).toBe("page-arch-1");
    });

    it("renders scope & metadata statistics", () => {
      const { container } = render(<ContextStudio />);
      const statusPanel = container.querySelector(".context-status-panel")!;

      expect(within(statusPanel as HTMLElement).getByText(/scope & metadata/i)).toBeTruthy();
      expect(within(statusPanel as HTMLElement).getByText("4")).toBeTruthy(); // 4 total pages
    });
  });

  describe("PersonaModal Creation & Editing", () => {
    it("creates a new persona with custom scopes and saves via transport", async () => {
      const { container } = render(<ContextStudio />);
      const addBtn = screen.getByRole("button", { name: /\+ add item/i });
      fireEvent.click(addBtn);

      const addMenu = container.querySelector(".context-add-menu")!;
      const newPersonaBtn = within(addMenu as HTMLElement).getByText(/\+ new persona/i);
      fireEvent.click(newPersonaBtn);

      const nameInput = screen.getByPlaceholderText(/persona name/i);
      const taglineInput = screen.getByPlaceholderText(/tagline/i);
      const promptInput = screen.getByPlaceholderText(/system rules/i);

      fireEvent.change(nameInput, { target: { value: "Security Auditor" } });
      fireEvent.change(taglineInput, {
        target: { value: "Vulnerability analysis expert" },
      });
      fireEvent.change(promptInput, {
        target: { value: "Perform security audits on all code." },
      });

      const quirksCheckbox = screen.getByLabelText(/quirks/i);
      fireEvent.click(quirksCheckbox);

      const submitBtn = screen.getByRole("button", { name: /create persona/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(contextTransport.upsertPersona).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Security Auditor",
            tagline: "Vulnerability analysis expert",
            system_prompt: "Perform security audits on all code.",
            attached_scopes: expect.arrayContaining(["quirks"]),
          }),
          expect.anything()
        );
      });
    });
  });

  describe("MCP Config Modal Integration", () => {
    it("renders MCP Config button and opens modal on click", () => {
      render(<ContextStudio />);
      const mcpBtn = screen.getByRole("button", { name: /mcp config/i });
      expect(mcpBtn).toBeTruthy();

      fireEvent.click(mcpBtn);
      expect(screen.getByRole("dialog", { name: /mcp server configuration/i })).toBeTruthy();
      expect(screen.getByText(/~[/\\]\.config[/\\]opencode[/\\]opencode\.json/i)).toBeTruthy();
    });
  });
});

