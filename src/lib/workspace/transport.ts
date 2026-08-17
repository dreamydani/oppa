import { invoke } from "@tauri-apps/api/core";

export interface RecentWorkspace {
  name: string;
  path: string;
  terminal_count: number;
  last_opened: number;
}

export interface WorkspacePreset {
  id: string;
  name: string;
  description?: string | null;
  terminal_count: number;
  shell?: string | null;
  commands: string[];
  agent_persona?: string | null;
}

export async function saveRecents(recents: RecentWorkspace[]): Promise<void> {
  return invoke("save_recents", { recents });
}

export async function loadRecents(): Promise<RecentWorkspace[]> {
  return invoke<RecentWorkspace[]>("load_recents");
}

export async function savePresets(presets: WorkspacePreset[]): Promise<void> {
  return invoke("save_presets", { presets });
}

export async function loadPresets(): Promise<WorkspacePreset[]> {
  return invoke<WorkspacePreset[]>("load_presets");
}
