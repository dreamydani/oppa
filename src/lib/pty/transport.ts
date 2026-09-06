import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";


// Core PTY payloads & types
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

export interface ResumePlan {
  command_line: string;
  kind: "agent-resume" | "command-relaunch";
}

// Mirrors src-tauri/agents/status.rs (snake_case, field clamps preserved).
export type AgentStatusState = "working" | "blocked" | "waiting" | "done";
export type StatusOrigin = "hook" | "quiet";

export interface AgentStatusEntry {
  state: AgentStatusState;
  prompt?: string;
  agent_type?: string | null;
  model?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  interactive_prompt?: string | null;
  interrupted?: boolean | null;
  turn_completed_at_ms?: number | null;
  state_started_at_ms: number;
  updated_at_ms: number;
  origin: StatusOrigin;
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
  resume?: ResumePlan | null;
  resume_declined_reason?: string | null;
  // Mirrors CreateOrAttachResult.working: hydrates working/idle dots on attach
  working?: boolean;
  // Hydrates the last hook-classified rich status on warm/cold reattach
  agent_status?: AgentStatusEntry | null;
  // Birth name seeded at spawn so panes never show raw s- ids
  title?: string | null;
}

// Type alias (not interface) so it satisfies InvokeArgs' index signature.
export type PtySpawnOptions = {
  id?: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  resumeAgents?: boolean;
  worktreeId?: string;
  // Launch command injected by the daemon once the shell reports ready
  // (oppa-ready marker, timed fallback) — never typed blind from the GUI.
  initialCommand?: string;
};

export interface SessionTitleChangedPayload {
  id: string;
  title: string;
}

export interface SessionFocusRequestedPayload {
  id: string;
}

// Edge-triggered working/idle flips; the Rust forwarder remaps the daemon's
// snake_case session_id to camelCase exactly like the sibling session-* events.
export interface SessionWorkingPayload {
  sessionId: string;
  working: boolean;
}

// Edge-triggered hook-classified status entries; the payload mirrors the Rust
// AgentStatusPayload verbatim (pane_key === session_id in the daemon registry).
export interface AgentStatusPayload {
  paneKey: string;
  entry: AgentStatusEntry;
}

// Core PTY transport functions
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

export function ptyAck(id: string, bytes: number): Promise<void> {
  // WHY dual-emit: old backends take `(id, bytes)` and ignore the unknown
  // `chars` key, while a new backend prefers `bytes` with `chars` fallback —
  // sending both keeps every GUI/backend combination working.
  // Tauri invoke dual-key is OK (serde ignores unknowns); the daemon-wire
  // Ack must stay single-key or every version fails to parse it.
  return invoke("pty_ack", { id, bytes, chars: bytes });
}

export function ptyList(): Promise<string[]> {
  return invoke("pty_list");
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

export async function onTitleChanged(cb: (p: SessionTitleChangedPayload) => void) {
  return listen<SessionTitleChangedPayload>("session-title-changed", (e) => cb(e.payload));
}

export async function onFocusRequested(cb: (p: SessionFocusRequestedPayload) => void) {
  return listen<SessionFocusRequestedPayload>("session-focus-requested", (e) => cb(e.payload));
}

export async function onSessionWorking(cb: (p: SessionWorkingPayload) => void) {
  return listen<SessionWorkingPayload>("session-working", (e) => cb(e.payload));
}

export async function onAgentStatus(cb: (p: AgentStatusPayload) => void) {
  return listen<AgentStatusPayload>("agent-status", (e) => {
    // Normalize snake_case wire key to the camelCase used across the store.
    const raw = e.payload as unknown as {
      pane_key?: string;
      paneKey?: string;
      entry: AgentStatusEntry;
    };
    cb({
      paneKey: raw.paneKey ?? raw.pane_key ?? "",
      entry: raw.entry,
    });
  });
}
