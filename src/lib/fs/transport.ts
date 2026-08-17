import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export async function readDir(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("fs_read_dir", { path });
}
