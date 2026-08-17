import { invoke } from "@tauri-apps/api/core";

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface GitStatusResult {
  is_git: boolean;
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
}

export async function getGitStatus(path: string): Promise<GitStatusResult> {
  return invoke<GitStatusResult>("git_status", { path });
}
