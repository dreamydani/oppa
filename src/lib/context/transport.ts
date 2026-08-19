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
  is_built_in: boolean;
  attached_scopes_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ContextPageList {
  items: ContextPage[];
  total: number;
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
  total: number;
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
  category?: string,
  limit?: number,
  offset?: number
): Promise<ContextPageList> {
  return invoke<ContextPageList>("context_list", {
    workspacePath,
    category,
    limit,
    offset,
  });
}

export async function getContextPage(
  id: string,
  workspacePath?: string,
  tier?: "l0" | "l1" | "l2"
): Promise<ContextPage | null> {
  return invoke<ContextPage | null>("context_get", { id, workspacePath, tier });
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

export async function restoreContextPage(
  id: string,
  scope: ContextScope | string,
  workspacePath?: string
): Promise<void> {
  return invoke("context_restore", { id, scope, workspacePath });
}

export async function searchContext(
  query: string,
  workspacePath?: string,
  limit?: number
): Promise<ContextSearchResult[]> {
  return invoke<ContextSearchResult[]>("context_search", {
    query,
    workspacePath,
    limit,
  });
}

export async function exportContext(workspacePath?: string): Promise<string> {
  return invoke<string>("context_export", { workspacePath });
}

export async function importContext(
  workspacePath: string | undefined,
  json: string
): Promise<number> {
  return invoke<number>("context_import", { workspacePath, json });
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
