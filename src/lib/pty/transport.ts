import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// The ONLY module that touches Tauri APIs. Everything else goes through here.
export interface PtyDataPayload {
  id: string;
  data: string;
  bytes: number;
  seq: number;
}
export interface PtyExitPayload {
  id: string;
  code: number | null;
  error?: string;
}
export interface PtyCwdPayload {
  id: string;
  cwd: string;
}

export interface PtySpawnResult {
  id: string;
  is_new: boolean;
  is_warm?: boolean;
  snapshot?: string | null;
  cold_scrollback?: string | null;
  pid?: number;
  cols?: number;
  rows?: number;
  cwd?: string | null;
}


// Type alias (not interface) so it satisfies InvokeArgs' index signature.
export type PtySpawnOptions = {
  id?: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
};

export async function ptySpawn(opts?: PtySpawnOptions): Promise<PtySpawnResult> {
  return invoke<PtySpawnResult>("pty_spawn", opts ?? {});
}
export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}
export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}
export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}
export function ptyAck(id: string, chars: number): Promise<void> {
  return invoke("pty_ack", { id, chars });
}
export function ptyList(): Promise<string[]> {
  return invoke("pty_list");
}
export function ptyDisconnect(): Promise<void> {
  return invoke("pty_disconnect");
}
export function ptyShutdown(): Promise<void> {
  return invoke("pty_shutdown");
}
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
export async function onPtyData(cb: (p: PtyDataPayload) => void) {
  return listen<PtyDataPayload>("pty:data", (e) => cb(e.payload));
}
export async function onPtyExit(cb: (p: PtyExitPayload) => void) {
  return listen<PtyExitPayload>("pty:exit", (e) => cb(e.payload));
}
export async function onPtyCwd(cb: (p: PtyCwdPayload) => void) {
  return listen<PtyCwdPayload>("pty:cwd", (e) => cb(e.payload));
}
