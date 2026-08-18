import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  listContextPages,
  getContextPage,
  upsertContextPage,
  deleteContextPage,
  searchContext,
  listPersonas,
  upsertPersona,
} from "./transport";
import type { ContextPage, AgentPersona, ContextSearchResult } from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("context transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listContextPages invokes context_list with workspacePath and category", async () => {
    const mockPages: ContextPage[] = [];
    invokeMock.mockResolvedValue(mockPages);

    const res = await listContextPages("/ws", "architecture");

    expect(invokeMock).toHaveBeenCalledWith("context_list", {
      workspacePath: "/ws",
      category: "architecture",
    });
    expect(res).toBe(mockPages);
  });

  it("getContextPage invokes context_get with id and workspacePath", async () => {
    const mockPage: ContextPage = {
      id: "page-1",
      scope: "global",
      category: "architecture",
      path: "arch/1",
      title: "Arch",
      icon: "box",
      abstract_l0: "Abstract",
      overview_l1: "Overview",
      pinned: true,
      created_at: 100,
      updated_at: 200,
    };
    invokeMock.mockResolvedValue(mockPage);

    const res = await getContextPage("page-1", "/ws");

    expect(invokeMock).toHaveBeenCalledWith("context_get", {
      id: "page-1",
      workspacePath: "/ws",
    });
    expect(res).toBe(mockPage);
  });

  it("upsertContextPage invokes context_upsert with page and workspacePath", async () => {
    invokeMock.mockResolvedValue(undefined);
    const page: ContextPage = {
      id: "page-1",
      scope: "global",
      category: "architecture",
      path: "arch/1",
      title: "Arch",
      icon: "box",
      abstract_l0: "Abstract",
      overview_l1: "Overview",
      pinned: true,
      created_at: 100,
      updated_at: 200,
    };

    await upsertContextPage(page, "/ws");

    expect(invokeMock).toHaveBeenCalledWith("context_upsert", {
      page,
      workspacePath: "/ws",
    });
  });

  it("deleteContextPage invokes context_delete with id, scope, and workspacePath", async () => {
    invokeMock.mockResolvedValue(undefined);

    await deleteContextPage("page-1", "workspace", "/ws");

    expect(invokeMock).toHaveBeenCalledWith("context_delete", {
      id: "page-1",
      scope: "workspace",
      workspacePath: "/ws",
    });
  });

  it("searchContext invokes context_search with query and workspacePath", async () => {
    const mockResults: ContextSearchResult[] = [];
    invokeMock.mockResolvedValue(mockResults);

    const res = await searchContext("query string", "/ws");

    expect(invokeMock).toHaveBeenCalledWith("context_search", {
      query: "query string",
      workspacePath: "/ws",
    });
    expect(res).toBe(mockResults);
  });

  it("listPersonas invokes persona_list with workspacePath", async () => {
    const mockPersonas: AgentPersona[] = [];
    invokeMock.mockResolvedValue(mockPersonas);

    const res = await listPersonas("/ws");

    expect(invokeMock).toHaveBeenCalledWith("persona_list", {
      workspacePath: "/ws",
    });
    expect(res).toBe(mockPersonas);
  });

  it("upsertPersona invokes persona_upsert with persona and workspacePath", async () => {
    invokeMock.mockResolvedValue(undefined);
    const persona: AgentPersona = {
      id: "debugger",
      name: "Debugger",
      icon: "bug",
      tagline: "Debugs issues",
      system_prompt: "You are a debugger",
      attached_scopes: ["global"],
      is_built_in: true,
    };

    await upsertPersona(persona, "/ws");

    expect(invokeMock).toHaveBeenCalledWith("persona_upsert", {
      persona,
      workspacePath: "/ws",
    });
  });
});
