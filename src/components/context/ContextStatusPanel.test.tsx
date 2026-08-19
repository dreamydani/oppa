import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within, fireEvent } from "@testing-library/react";
import { ContextStatusPanel, renderSnippet } from "./ContextStatusPanel";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import { searchContext } from "../../lib/context/transport";
import type { ContextSearchResult } from "../../lib/context/transport";

vi.mock("../../lib/context/transport", () => ({
  searchContext: vi.fn(),
  listContextPages: vi.fn(),
  listPersonas: vi.fn(),
  upsertContextPage: vi.fn(),
  deleteContextPage: vi.fn(),
  upsertPersona: vi.fn(),
}));

const mockSearch = vi.mocked(searchContext);

const mockHeaderResult: ContextSearchResult = {
  id: "header-res-1",
  scope: "global",
  category: "quirk",
  path: "quirks/h",
  title: "Header Result",
  icon: "bug",
  abstract_l0: "Abstract H",
  overview_l1: "Overview H",
  snippet: "Header match with <b>term</b>",
  total: 1,
};

const mockSandboxResult: ContextSearchResult = {
  id: "sandbox-res-1",
  scope: "workspace",
  category: "architecture",
  path: "architecture/s",
  title: "Sandbox Result",
  icon: "architecture",
  abstract_l0: "Abstract S",
  overview_l1: "Overview S",
  snippet: "conpty <b>newline</b> bug with <b>windows</b> fix",
  total: 1,
};

describe("ContextStatusPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useContextStore.setState({
      pages: [],
      personas: [
        {
          id: "persona-1",
          name: "Architect",
          icon: "arch",
          tagline: "tagline",
          system_prompt: "rules",
          attached_scopes: [],
          is_built_in: false,
        },
      ],
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
    useTerminalStore.setState({
      getActiveCwd: () => "D:/oppa/oppa",
      sessions: {
        s1: {
          id: "s1",
          title: "Terminal 1",
          status: "running",
          cols: 80,
          rows: 24,
          cwd: "D:/oppa/oppa",
          personaId: null,
        },
      },
      setSessionPersona: (sessionId: string, personaId: string | null) => {
        const state = useTerminalStore.getState();
        const session = state.sessions[sessionId];
        if (session) {
          useTerminalStore.setState({
            sessions: {
              ...state.sessions,
              [sessionId]: { ...session, personaId },
            },
          });
        }
      },
    } as any);
  });

  describe("renderSnippet safe parsing", () => {
    it("returns null for empty snippet", () => {
      expect(renderSnippet("")).toBeNull();
    });

    it("renders plain text in span when no bold tags exist", () => {
      const { container } = render(<div data-testid="snippet">{renderSnippet("plain text here")}</div>);
      expect(container.querySelector("span")?.textContent).toBe("plain text here");
      expect(container.querySelector("mark")).toBeNull();
    });

    it("renders matched terms in mark tags and unmatched terms in span tags", () => {
      const { container } = render(
        <div data-testid="snippet">
          {renderSnippet("conpty <b>newline</b> bug with <b>windows</b> fix")}
        </div>
      );
      const marks = container.querySelectorAll("mark");
      expect(marks.length).toBe(2);
      expect(marks[0].textContent).toBe("newline");
      expect(marks[1].textContent).toBe("windows");

      const spans = container.querySelectorAll("span");
      expect(spans.length).toBe(3);
      expect(spans[0].textContent).toBe("conpty ");
      expect(spans[1].textContent).toBe(" bug with ");
      expect(spans[2].textContent).toBe(" fix");

      expect(container.querySelector("b")).toBeNull();
    });

    it("safely escapes HTML tags and avoids injection", () => {
      const { container } = render(
        <div data-testid="snippet">
          {renderSnippet("<script>alert(1)</script> <b>safe</b>")}
        </div>
      );
      expect(container.querySelector("script")).toBeNull();
      expect(container.textContent).toContain("<script>alert(1)</script>");
      expect(container.querySelector("mark")?.textContent).toBe("safe");
    });
  });

  describe("Sandbox isolation & store connection", () => {
    it("sandbox search does not clobber header search", async () => {
      useContextStore.setState({
        searchQuery: "header query",
        searchResults: [mockHeaderResult],
      });
      mockSearch.mockResolvedValueOnce([mockSandboxResult]);

      const { container } = render(<ContextStatusPanel />);
      const input = container.querySelector(".sandbox-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "sandbox query" } });

      await vi.waitFor(() => {
        expect(useContextStore.getState().searchResultsSandbox.length).toBe(1);
        expect(useContextStore.getState().searchResultsSandbox[0].id).toBe("sandbox-res-1");
      });

      expect(mockSearch).toHaveBeenCalledWith("sandbox query", "D:/oppa/oppa");
      // Header search results remain intact
      expect(useContextStore.getState().searchQuery).toBe("header query");
      expect(useContextStore.getState().searchResults.length).toBe(1);
      expect(useContextStore.getState().searchResults[0].id).toBe("header-res-1");
    });

    it("renders snippet with <mark> tags instead of raw HTML", () => {
      useContextStore.setState({
        searchResultsSandbox: [mockSandboxResult],
      });
      const { container } = render(<ContextStatusPanel />);
      const resultCard = container.querySelector(".sandbox-result-card")!;
      expect(resultCard).toBeTruthy();
      expect(resultCard.querySelector("mark")?.textContent).toBe("newline");
      expect(resultCard.querySelector("b")).toBeNull();
      expect(within(resultCard as HTMLElement).getByText("Sandbox Result")).toBeTruthy();
    });

    it("selects page when clicking a sandbox search result card", () => {
      useContextStore.setState({
        searchResultsSandbox: [mockSandboxResult],
      });
      const { container } = render(<ContextStatusPanel />);
      const resultCard = container.querySelector(".sandbox-result-card")!;
      fireEvent.click(resultCard);

      expect(useContextStore.getState().selectedPageId).toBe("sandbox-res-1");
    });

    it("renders empty hint when searchResultsSandbox is empty", () => {
      useContextStore.setState({
        searchResultsSandbox: [],
      });
      const { container } = render(<ContextStatusPanel />);
      expect(container.querySelector(".sandbox-empty-hint")).toBeTruthy();
      expect(
        within(container).getByText(/Type in search box above to test live SQLite FTS5 matching/i)
      ).toBeTruthy();
    });
  });

  describe("Sessions & Scope statistics", () => {
    it("renders active sessions and updates persona assignment", () => {
      const { container } = render(<ContextStatusPanel />);
      expect(within(container).getByText("Terminal 1")).toBeTruthy();
      const select = container.querySelector(".session-persona-select") as HTMLSelectElement;
      expect(select).toBeTruthy();

      fireEvent.change(select, { target: { value: "persona-1" } });
      expect(useTerminalStore.getState().sessions["s1"].personaId).toBe("persona-1");
    });

    it("renders scope metadata metrics", () => {
      useContextStore.setState({
        pages: [
          {
            id: "p1",
            scope: "workspace",
            category: "architecture",
            path: "a",
            title: "A",
            icon: "file",
            abstract_l0: "",
            overview_l1: "",
            pinned: true,
            is_built_in: false,
            attached_scopes_json: "[]",
            created_at: 0,
            updated_at: 0,
            deleted_at: null,
          },
          {
            id: "p2",
            scope: "global",
            category: "preference",
            path: "b",
            title: "B",
            icon: "file",
            abstract_l0: "",
            overview_l1: "",
            pinned: false,
            is_built_in: false,
            attached_scopes_json: "[]",
            created_at: 0,
            updated_at: 0,
            deleted_at: null,
          },
        ],
      });
      const { container } = render(<ContextStatusPanel />);
      const metricTiles = container.querySelectorAll(".metric-tile");
      expect(metricTiles.length).toBe(4);
      // Total pages = 2, Pinned = 1, Workspace = 1, Global = 1
      expect(within(metricTiles[0] as HTMLElement).getByText("2")).toBeTruthy();
      expect(within(metricTiles[1] as HTMLElement).getByText("1")).toBeTruthy();
      expect(within(metricTiles[2] as HTMLElement).getByText("1")).toBeTruthy();
      expect(within(metricTiles[3] as HTMLElement).getByText("1")).toBeTruthy();
    });
  });
});
