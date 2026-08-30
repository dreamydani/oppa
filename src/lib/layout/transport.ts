import { invoke } from "@tauri-apps/api/core";

export function saveLayout(layoutJson: string): Promise<void> {
  return invoke("save_layout", { layoutJson });
}

export function loadLayout(): Promise<string | null> {
  return invoke("load_layout");
}

export async function saveScrollback(id: string, data: string): Promise<void> {
  return invoke("save_scrollback", { id, data });
}

export async function loadScrollback(id: string): Promise<string | null> {
  return invoke("load_scrollback", { id });
}

export async function deleteScrollback(id: string): Promise<void> {
  return invoke("delete_scrollback", { id });
}

export async function cleanupStaleScrollbacks(activeIds: string[]): Promise<void> {
  return invoke("cleanup_stale_scrollbacks", { activeIds });
}

// Signals the Rust close handshake that the layout save has flushed, so the
// app can exit instead of waiting out the full timeout.
export function confirmSaveComplete(): Promise<void> {
  return invoke("confirm_save_complete");
}
