import { invoke } from "@tauri-apps/api/core";

// The ONLY module that touches Tauri APIs for the extensions domain.
// Everything else goes through here (mirrors src/lib/pty/transport.ts).

export interface ExtensionListItem {
  id: string; // empty for errored entries
  name: string;
  version: string;
  description: string;
  is_builtin: boolean;
  enabled: boolean;
  error: string | null;
  theme_count: number;
  snippet_count: number;
  command_count: number;
}

export interface ContributedTheme {
  extension_id: string;
  /** Globally unique id persisted in settings: "<extension.id>:<theme.id>" */
  theme_id: string;
  name: string;
  theme_type: "dark" | "light";
  colors: Record<string, string>;
  preview_colors: [string, string, string, string];
}

export interface ContributionPayload {
  themes: ContributedTheme[];
}

export function listExtensions(): Promise<ExtensionListItem[]> {
  return invoke<ExtensionListItem[]>("list_extensions");
}

export function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke("set_extension_enabled", { id, enabled });
}

export function getContributions(): Promise<ContributionPayload> {
  return invoke<ContributionPayload>("get_contributions");
}
