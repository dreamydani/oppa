import { create } from "zustand";
import {
  listContextPages,
  upsertContextPage,
  deleteContextPage,
  restoreContextPage,
  searchContext as transportSearchContext,
  listPersonas,
  upsertPersona,
} from "../lib/context/transport";
import type {
  ContextPage,
  ContextScope,
  ContextSearchResult,
  AgentPersona,
} from "../lib/context/transport";

export interface ContextState {
  pages: ContextPage[];
  personas: AgentPersona[];
  selectedPageId: string | null;
  selectedPersonaId: string | null;
  activeTier: "l0" | "l1" | "l2";
  searchQuery: string;
  searchResults: ContextSearchResult[];
  searchResultsSandbox: ContextSearchResult[];
  sandboxQuery: string;
  isEditing: boolean;
  isLoading: boolean;
  lastError: string | null;

  loadContext: (workspacePath?: string) => Promise<void>;
  selectPage: (id: string | null) => void;
  selectPersona: (id: string | null) => void;
  setActiveTier: (tier: "l0" | "l1" | "l2") => void;
  setSearchQuery: (query: string) => void;
  searchContext: (query: string, workspacePath?: string) => Promise<void>;
  searchContextSandbox: (query: string, workspacePath?: string) => Promise<void>;
  setSandboxQuery: (query: string) => void;
  savePage: (page: ContextPage, workspacePath?: string) => Promise<void>;
  deletePage: (id: string, scope: ContextScope, workspacePath?: string) => Promise<void>;
  restorePage: (id: string, scope: ContextScope, workspacePath?: string) => Promise<void>;
  savePersona: (persona: AgentPersona, workspacePath?: string) => Promise<void>;
  setIsEditing: (isEditing: boolean) => void;
  clearError: () => void;
}

export const useContextStore = create<ContextState>((set, get) => ({
  pages: [],
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

  loadContext: async (workspacePath) => {
    set({ isLoading: true });
    try {
      const [pagesList, personas] = await Promise.all([
        listContextPages(workspacePath),
        listPersonas(workspacePath),
      ]);
      const pages = Array.isArray(pagesList) ? pagesList : (pagesList?.items ?? []);
      set({ pages, personas, isLoading: false });
    } catch (e: any) {
      set({ isLoading: false, lastError: String(e?.message ?? e) });
    }
  },

  selectPage: (id) => {
    set({ selectedPageId: id, selectedPersonaId: id ? null : get().selectedPersonaId });
  },

  selectPersona: (id) => {
    set({ selectedPersonaId: id, selectedPageId: id ? null : get().selectedPageId });
  },

  setActiveTier: (tier) => {
    set({ activeTier: tier });
  },

  setSearchQuery: (query) => {
    set((state) => ({
      searchQuery: query,
      searchResults: query ? state.searchResults : [],
    }));
  },

  searchContext: async (query, workspacePath) => {
    const trimmed = query.trim();
    if (!trimmed) {
      set({ searchQuery: "", searchResults: [] });
      return;
    }
    try {
      const results = await transportSearchContext(trimmed, workspacePath);
      set({ searchQuery: query, searchResults: results });
    } catch (e: any) {
      set({ searchQuery: query, searchResults: [], lastError: String(e?.message ?? e) });
    }
  },

  searchContextSandbox: async (query, workspacePath) => {
    const trimmed = query.trim();
    if (!trimmed) {
      set({ sandboxQuery: "", searchResultsSandbox: [] });
      return;
    }
    try {
      const results = await transportSearchContext(trimmed, workspacePath);
      set({ sandboxQuery: query, searchResultsSandbox: results });
    } catch (e: any) {
      set({ sandboxQuery: query, searchResultsSandbox: [], lastError: String(e?.message ?? e) });
    }
  },

  setSandboxQuery: (query) => {
    set((state) => ({
      sandboxQuery: query,
      searchResultsSandbox: query ? state.searchResultsSandbox : [],
    }));
  },

  savePage: async (page, workspacePath) => {
    try {
      await upsertContextPage(page, workspacePath);
      set((state) => {
        const existingIdx = state.pages.findIndex((p) => p.id === page.id);
        const pages =
          existingIdx >= 0
            ? state.pages.map((p, i) => (i === existingIdx ? page : p))
            : [...state.pages, page];
        return { pages, selectedPageId: page.id, isEditing: false };
      });
    } catch (e: any) {
      await get().loadContext(workspacePath);
      set({ lastError: String(e?.message ?? e) });
    }
  },

  deletePage: async (id, scope, workspacePath) => {
    try {
      await deleteContextPage(id, scope, workspacePath);
      set((state) => ({
        pages: state.pages.filter((p) => p.id !== id),
        selectedPageId: state.selectedPageId === id ? null : state.selectedPageId,
      }));
    } catch (e: any) {
      await get().loadContext(workspacePath);
      set({ lastError: String(e?.message ?? e) });
    }
  },

  restorePage: async (id, scope, workspacePath) => {
    try {
      await restoreContextPage(id, scope, workspacePath);
      await get().loadContext(workspacePath);
    } catch (e: any) {
      await get().loadContext(workspacePath);
      set({ lastError: String(e?.message ?? e) });
    }
  },

  savePersona: async (persona, workspacePath) => {
    try {
      await upsertPersona(persona, workspacePath);
      set((state) => {
        const existingIdx = state.personas.findIndex((p) => p.id === persona.id);
        const personas =
          existingIdx >= 0
            ? state.personas.map((p, i) => (i === existingIdx ? persona : p))
            : [...state.personas, persona];
        return { personas, selectedPersonaId: persona.id };
      });
    } catch (e: any) {
      await get().loadContext(workspacePath);
      set({ lastError: String(e?.message ?? e) });
    }
  },

  setIsEditing: (isEditing) => {
    set({ isEditing });
  },

  clearError: () => {
    set({ lastError: null });
  },
}));
