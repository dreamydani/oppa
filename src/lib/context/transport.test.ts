import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  listContextPages,
  getContextPage,
  upsertContextPage,
  deleteContextPage,
  restoreContextPage,
  searchContext,
  exportContext,
  importContext,
  listPersonas,
  upsertPersona,
} from "./transport";
import type {
  ContextPage,
  ContextPageList,
  AgentPersona,
  ContextSearchResult,
} from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("context transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listContextPages invokes context_list with workspacePath, category, limit, and offset", async () => {
    const mockList: ContextPageList = {
      items: [],
      total: 0,
    };
    invokeMock.mockResolvedValue(mockList);

    const res = await listContextPages("/ws", "architecture", 20, 40);

    expect(invokeMock).toHaveBeenCalledWith("context_list", {
      workspacePath: "/ws",
      category: "architecture",
      limit: 20,
      offset: 40,
    });
    expect(res).toBe(mockList);
  });

  it("getContextPage invokes context_get with id, workspacePath, and tier", async () => {
    const mockPage: ContextPage = {
      id: "page-1",
      scope: "global",
      category: "architecture",
      path: "arch/1",
      title: "Arch",
      icon: "box",
      abstract_l0: "Abstract",
      overview_l1: "Overview",
      details_l2: "Details",
      pinned: true,
      is_built_in: false,
      attached_scopes_json: "[]",
      created_at: 100,
      updated_at: 200,
      deleted_at: null,
    };
    invokeMock.mockResolvedValue(mockPage);

    const res = await getContextPage("page-1", "/ws", "l1");

    expect(invokeMock).toHaveBeenCalledWith("context_get", {
      id: "page-1",
      workspacePath: "/ws",
      tier: "l1",
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
      is_built_in: false,
      attached_scopes_json: "[]",
      created_at: 100,
      updated_at: 200,
      deleted_at: null,
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

  it("restoreContextPage invokes context_restore with id, scope, and workspacePath", async () => {
    invokeMock.mockResolvedValue(undefined);

    await restoreContextPage("page-1", "workspace", "/ws");

    expect(invokeMock).toHaveBeenCalledWith("context_restore", {
      id: "page-1",
      scope: "workspace",
      workspacePath: "/ws",
    });
  });

  it("searchContext invokes context_search with query, workspacePath, and limit", async () => {
    const mockResults: ContextSearchResult[] = [];
    invokeMock.mockResolvedValue(mockResults);

    const res = await searchContext("query string", "/ws", 10);

    expect(invokeMock).toHaveBeenCalledWith("context_search", {
      query: "query string",
      workspacePath: "/ws",
      limit: 10,
    });
    expect(res).toBe(mockResults);
  });

  it("exportContext invokes context_export with workspacePath", async () => {
    invokeMock.mockResolvedValue('{"version":1,"pages":[],"personas":[]}');

    const res = await exportContext("/ws");

    expect(invokeMock).toHaveBeenCalledWith("context_export", {
      workspacePath: "/ws",
    });
    expect(res).toBe('{"version":1,"pages":[],"personas":[]}');
  });

  it("importContext invokes context_import with workspacePath and json", async () => {
    invokeMock.mockResolvedValue(5);

    const res = await importContext("/ws", '{"version":1,"pages":[],"personas":[]}');

    expect(invokeMock).toHaveBeenCalledWith("context_import", {
      workspacePath: "/ws",
      json: '{"version":1,"pages":[],"personas":[]}',
    });
    expect(res).toBe(5);
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
