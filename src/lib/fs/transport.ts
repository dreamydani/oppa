import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export async function readDir(path: string): Promise<FileEntry[]> {
  try {
    return await invoke<FileEntry[]>("fs_read_dir", { path });
  } catch {
    return [];
  }
}

export async function readFile(path: string): Promise<string> {
  try {
    return await invoke<string>("fs_read_file", { path });
  } catch {
    return "";
  }
}

export async function writeFile(path: string, content: string): Promise<void> {
  try {
    await invoke("fs_write_file", { path, content });
  } catch {}
}

export async function createFile(path: string): Promise<void> {
  try {
    await invoke("fs_create_file", { path });
  } catch {}
}

export interface EditorApp {
  name: string;
  command: string;
}

// Creation/launch report success so the explorer can surface inline errors
export async function createDir(path: string): Promise<boolean> {
  try {
    await invoke("fs_create_dir", { path });
    return true;
  } catch {
    return false;
  }
}

export async function detectEditors(): Promise<EditorApp[]> {
  try {
    return await invoke<EditorApp[]>("fs_detect_editors");
  } catch {
    return [];
  }
}

export async function openWith(path: string, app?: string): Promise<boolean> {
  try {
    await invoke("fs_open_with", { path, app: app ?? null });
    return true;
  } catch {
    return false;
  }
}
