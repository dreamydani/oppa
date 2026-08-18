import { create } from "zustand";
import {
  listContextPages,
  upsertContextPage,
  deleteContextPage,
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
  isEditing: boolean;
  isLoading: boolean;

  loadContext: (workspacePath?: string) => Promise<void>;
  selectPage: (id: string | null) => void;
  selectPersona: (id: string | null) => void;
  setActiveTier: (tier: "l0" | "l1" | "l2") => void;
  setSearchQuery: (query: string) => void;
  searchContext: (query: string, workspacePath?: string) => Promise<void>;
  savePage: (page: ContextPage, workspacePath?: string) => Promise<void>;
  deletePage: (id: string, scope: ContextScope, workspacePath?: string) => Promise<void>;
  savePersona: (persona: AgentPersona, workspacePath?: string) => Promise<void>;
  setIsEditing: (isEditing: boolean) => void;
}

export const useContextStore = create<ContextState>((set, get) => ({
  pages: [],
  personas: [],
  selectedPageId: null,
  selectedPersonaId: null,
  activeTier: "l0",
  searchQuery: "",
  searchResults: [],
  isEditing: false,
  isLoading: false,

  loadContext: async (workspacePath) => {
    set({ isLoading: true });
    try {
      const [pages, personas] = await Promise.all([
        listContextPages(workspacePath),
        listPersonas(workspacePath),
      ]);
      set({ pages, personas, isLoading: false });
    } catch {
      set({ isLoading: false });
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
    } catch {
      set({ searchQuery: query, searchResults: [] });
    }
  },

  savePage: async (page, workspacePath) => {
    await upsertContextPage(page, workspacePath);
    set((state) => {
      const existingIdx = state.pages.findIndex((p) => p.id === page.id);
      const pages =
        existingIdx >= 0
          ? state.pages.map((p, i) => (i === existingIdx ? page : p))
          : [...state.pages, page];
      return { pages, selectedPageId: page.id, isEditing: false };
    });
  },

  deletePage: async (id, scope, workspacePath) => {
    await deleteContextPage(id, scope, workspacePath);
    set((state) => ({
      pages: state.pages.filter((p) => p.id !== id),
      selectedPageId: state.selectedPageId === id ? null : state.selectedPageId,
    }));
  },

  savePersona: async (persona, workspacePath) => {
    await upsertPersona(persona, workspacePath);
    set((state) => {
      const existingIdx = state.personas.findIndex((p) => p.id === persona.id);
      const personas =
        existingIdx >= 0
          ? state.personas.map((p, i) => (i === existingIdx ? persona : p))
          : [...state.personas, persona];
      return { personas, selectedPersonaId: persona.id };
    });
  },

  setIsEditing: (isEditing) => {
    set({ isEditing });
  },
}));
