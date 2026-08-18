import { invoke } from "@tauri-apps/api/core";

export type ContextScope = "global" | "workspace";
export type ContextCategory = "architecture" | "quirk" | "runbook" | "preference" | "persona";

export interface ContextPage {
  id: string;
  scope: ContextScope;
  category: ContextCategory;
  path: string;
  title: string;
  icon: string;
  abstract_l0: string;
  overview_l1: string;
  details_l2?: string;
  pinned: boolean;
  created_at: number;
  updated_at: number;
}

export interface ContextSearchResult {
  id: string;
  scope: ContextScope;
  category: ContextCategory;
  path: string;
  title: string;
  icon: string;
  abstract_l0: string;
  overview_l1: string;
  snippet: string;
}

export interface AgentPersona {
  id: string;
  name: string;
  icon: string;
  tagline: string;
  system_prompt: string;
  attached_scopes: string[];
  is_built_in: boolean;
}

export async function listContextPages(
  workspacePath?: string,
  category?: string
): Promise<ContextPage[]> {
  return invoke<ContextPage[]>("context_list", { workspacePath, category });
}

export async function getContextPage(
  id: string,
  workspacePath?: string
): Promise<ContextPage | null> {
  return invoke<ContextPage | null>("context_get", { id, workspacePath });
}

export async function upsertContextPage(
  page: ContextPage,
  workspacePath?: string
): Promise<void> {
  return invoke("context_upsert", { page, workspacePath });
}

export async function deleteContextPage(
  id: string,
  scope: ContextScope | string,
  workspacePath?: string
): Promise<void> {
  return invoke("context_delete", { id, scope, workspacePath });
}

export async function searchContext(
  query: string,
  workspacePath?: string
): Promise<ContextSearchResult[]> {
  return invoke<ContextSearchResult[]>("context_search", { query, workspacePath });
}

export async function listPersonas(
  workspacePath?: string
): Promise<AgentPersona[]> {
  return invoke<AgentPersona[]>("persona_list", { workspacePath });
}

export async function upsertPersona(
  persona: AgentPersona,
  workspacePath?: string
): Promise<void> {
  return invoke("persona_upsert", { persona, workspacePath });
}
