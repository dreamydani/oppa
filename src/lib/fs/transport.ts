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
