import { describe, it, expect, vi, beforeEach } from "vitest";
import { useContextStore } from "./contextStore";
import * as contextTransport from "../lib/context/transport";
import type {
  ContextPage,
  AgentPersona,
  ContextSearchResult,
} from "../lib/context/transport";
import { useTerminalStore } from "./terminalStore";

vi.mock("../lib/context/transport", () => ({
  listContextPages: vi.fn(),
  getContextPage: vi.fn(),
  upsertContextPage: vi.fn(),
  deleteContextPage: vi.fn(),
  searchContext: vi.fn(),
  listPersonas: vi.fn(),
  upsertPersona: vi.fn(),
}));

const listContextPagesMock = vi.mocked(contextTransport.listContextPages);
const upsertContextPageMock = vi.mocked(contextTransport.upsertContextPage);
const deleteContextPageMock = vi.mocked(contextTransport.deleteContextPage);
const searchContextMock = vi.mocked(contextTransport.searchContext);
const listPersonasMock = vi.mocked(contextTransport.listPersonas);
const upsertPersonaMock = vi.mocked(contextTransport.upsertPersona);

const mockPage1: ContextPage = {
  id: "page-1",
  scope: "global",
  category: "architecture",
  path: "architecture/core",
  title: "Core Architecture",
  icon: "cpu",
  abstract_l0: "OPPA architecture overview",
  overview_l1: "Daemon + GUI multi-process architecture",
  details_l2: "Tokio IPC named pipes with vt100 screen mirror",
  pinned: true,
  created_at: 1000,
  updated_at: 2000,
};

const mockPage2: ContextPage = {
  id: "page-2",
  scope: "workspace",
  category: "quirk",
  path: "quirks/windows-conpty",
  title: "Windows ConPTY",
  icon: "alert-triangle",
  abstract_l0: "ConPTY escape sequences quirk",
  overview_l1: "Handles newline translations",
  pinned: false,
  created_at: 1100,
  updated_at: 2100,
};

const mockPersona1: AgentPersona = {
  id: "lead-architect",
  name: "Lead Architect",
  icon: "compass",
  tagline: "Systems architect and design reviewer",
  system_prompt: "You are a lead architect.",
  attached_scopes: ["global", "workspace"],
  is_built_in: true,
};

const mockPersona2: AgentPersona = {
  id: "debugger",
  name: "Debugger",
  icon: "bug",
  tagline: "Pinpoints root causes",
  system_prompt: "You are an elite debugger.",
  attached_scopes: ["workspace"],
  is_built_in: false,
};

const mockSearchResult: ContextSearchResult = {
  id: "page-1",
  scope: "global",
  category: "architecture",
  path: "architecture/core",
  title: "Core Architecture",
  icon: "cpu",
  abstract_l0: "OPPA architecture overview",
  overview_l1: "Daemon + GUI multi-process architecture",
  snippet: "Tokio IPC <b>named pipes</b> with vt100",
};

describe("contextStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useContextStore.setState({
      pages: [],
      personas: [],
      selectedPageId: null,
      selectedPersonaId: null,
      activeTier: "l0",
      searchQuery: "",
      searchResults: [],
      isEditing: false,
      isLoading: false,
    });
  });

  describe("initial state", () => {
    it("has correct default state", () => {
      const state = useContextStore.getState();
      expect(state.pages).toEqual([]);
      expect(state.personas).toEqual([]);
      expect(state.selectedPageId).toBeNull();
      expect(state.selectedPersonaId).toBeNull();
      expect(state.activeTier).toBe("l0");
      expect(state.searchQuery).toBe("");
      expect(state.searchResults).toEqual([]);
      expect(state.isEditing).toBe(false);
      expect(state.isLoading).toBe(false);
    });
  });

  describe("loadContext", () => {
    it("loads pages and personas and updates state", async () => {
      listContextPagesMock.mockResolvedValue([mockPage1, mockPage2]);
      listPersonasMock.mockResolvedValue([mockPersona1, mockPersona2]);

      await useContextStore.getState().loadContext("/workspace/path");

      expect(listContextPagesMock).toHaveBeenCalledWith("/workspace/path");
      expect(listPersonasMock).toHaveBeenCalledWith("/workspace/path");

      const state = useContextStore.getState();
      expect(state.pages).toEqual([mockPage1, mockPage2]);
      expect(state.personas).toEqual([mockPersona1, mockPersona2]);
      expect(state.isLoading).toBe(false);
    });

    it("handles errors gracefully during loadContext", async () => {
      listContextPagesMock.mockRejectedValue(new Error("Failed to load pages"));
      listPersonasMock.mockResolvedValue([]);

      await useContextStore.getState().loadContext();

      const state = useContextStore.getState();
      expect(state.isLoading).toBe(false);
    });
  });

  describe("selection and tier navigation", () => {
    it("selectPage selects page and clears selectedPersonaId", () => {
      useContextStore.setState({ selectedPersonaId: "lead-architect" });

      useContextStore.getState().selectPage("page-1");

      const state = useContextStore.getState();
      expect(state.selectedPageId).toBe("page-1");
      expect(state.selectedPersonaId).toBeNull();
    });

    it("selectPersona selects persona and clears selectedPageId", () => {
      useContextStore.setState({ selectedPageId: "page-1" });

      useContextStore.getState().selectPersona("lead-architect");

      const state = useContextStore.getState();
      expect(state.selectedPersonaId).toBe("lead-architect");
      expect(state.selectedPageId).toBeNull();
    });

    it("setActiveTier updates active tier (l0, l1, l2)", () => {
      useContextStore.getState().setActiveTier("l1");
      expect(useContextStore.getState().activeTier).toBe("l1");

      useContextStore.getState().setActiveTier("l2");
      expect(useContextStore.getState().activeTier).toBe("l2");

      useContextStore.getState().setActiveTier("l0");
      expect(useContextStore.getState().activeTier).toBe("l0");
    });
  });

  describe("search", () => {
    it("setSearchQuery updates query and clears results if query is empty", () => {
      useContextStore.setState({ searchResults: [mockSearchResult] });

      useContextStore.getState().setSearchQuery("architecture");
      expect(useContextStore.getState().searchQuery).toBe("architecture");

      useContextStore.getState().setSearchQuery("");
      expect(useContextStore.getState().searchQuery).toBe("");
      expect(useContextStore.getState().searchResults).toEqual([]);
    });

    it("searchContext performs search via transport and sets results", async () => {
      searchContextMock.mockResolvedValue([mockSearchResult]);

      await useContextStore.getState().searchContext("named pipes", "/ws");

      expect(searchContextMock).toHaveBeenCalledWith("named pipes", "/ws");
      const state = useContextStore.getState();
      expect(state.searchQuery).toBe("named pipes");
      expect(state.searchResults).toEqual([mockSearchResult]);
    });

    it("searchContext with empty query clears search results without calling transport", async () => {
      useContextStore.setState({ searchResults: [mockSearchResult] });

      await useContextStore.getState().searchContext("   ");

      expect(searchContextMock).not.toHaveBeenCalled();
      const state = useContextStore.getState();
      expect(state.searchQuery).toBe("");
      expect(state.searchResults).toEqual([]);
    });
  });

  describe("savePage and deletePage", () => {
    it("savePage creates new page and updates state", async () => {
      upsertContextPageMock.mockResolvedValue(undefined);
      useContextStore.setState({ pages: [mockPage1], isEditing: true });

      await useContextStore.getState().savePage(mockPage2, "/workspace/path");

      expect(upsertContextPageMock).toHaveBeenCalledWith(mockPage2, "/workspace/path");
      const state = useContextStore.getState();
      expect(state.pages).toEqual([mockPage1, mockPage2]);
      expect(state.selectedPageId).toBe("page-2");
      expect(state.isEditing).toBe(false);
    });

    it("savePage updates existing page in state", async () => {
      upsertContextPageMock.mockResolvedValue(undefined);
      useContextStore.setState({ pages: [mockPage1, mockPage2] });

      const updatedPage1: ContextPage = {
        ...mockPage1,
        title: "Updated Core Architecture",
        updated_at: 3000,
      };

      await useContextStore.getState().savePage(updatedPage1);

      expect(upsertContextPageMock).toHaveBeenCalledWith(updatedPage1, undefined);
      const state = useContextStore.getState();
      expect(state.pages.find((p) => p.id === "page-1")?.title).toBe(
        "Updated Core Architecture"
      );
      expect(state.selectedPageId).toBe("page-1");
    });

    it("deletePage calls transport and removes page from state", async () => {
      deleteContextPageMock.mockResolvedValue(undefined);
      useContextStore.setState({
        pages: [mockPage1, mockPage2],
        selectedPageId: "page-1",
      });

      await useContextStore.getState().deletePage("page-1", "global", "/ws");

      expect(deleteContextPageMock).toHaveBeenCalledWith("page-1", "global", "/ws");
      const state = useContextStore.getState();
      expect(state.pages).toEqual([mockPage2]);
      expect(state.selectedPageId).toBeNull();
    });
  });

  describe("savePersona", () => {
    it("savePersona creates/updates persona and selects it", async () => {
      upsertPersonaMock.mockResolvedValue(undefined);
      useContextStore.setState({ personas: [mockPersona1] });

      await useContextStore.getState().savePersona(mockPersona2, "/ws");

      expect(upsertPersonaMock).toHaveBeenCalledWith(mockPersona2, "/ws");
      const state = useContextStore.getState();
      expect(state.personas).toEqual([mockPersona1, mockPersona2]);
      expect(state.selectedPersonaId).toBe("debugger");
    });
  });

  describe("editing state", () => {
    it("setIsEditing sets isEditing flag", () => {
      useContextStore.getState().setIsEditing(true);
      expect(useContextStore.getState().isEditing).toBe(true);

      useContextStore.getState().setIsEditing(false);
      expect(useContextStore.getState().isEditing).toBe(false);
    });
  });

  describe("terminalStore integration", () => {
    it("supports context mode in activeAppMode", () => {
      useTerminalStore.getState().setAppMode("context");
      expect(useTerminalStore.getState().activeAppMode).toBe("context");
    });

    it("allows assigning and changing personaId on a session", () => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "s1",
            status: "running",
            cols: 80,
            rows: 24,
          },
        },
      });

      useTerminalStore.getState().setSessionPersona("s1", "lead-architect");
      expect(useTerminalStore.getState().sessions["s1"].personaId).toBe("lead-architect");

      useTerminalStore.getState().setSessionPersona("s1", null);
      expect(useTerminalStore.getState().sessions["s1"].personaId).toBeNull();
    });
  });
});
