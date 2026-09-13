import { invoke } from "@tauri-apps/api/core";

// Serde-verbatim to src-tauri/src/system/memory.rs (snake_case).
export interface HostMemory {
  total: number;
  available: number;
  used: number;
  percent: number;
}

export interface AppMemory {
  cpu: number | null;
  memory: number | null;
}

export interface SessionMemory {
  session_id: string;
  pid: number;
  cpu: number | null;
  memory: number | null;
}

export interface SystemMemorySnapshot {
  app: AppMemory;
  // Detached daemon row; absent on old backends, null metrics when unresolved.
  daemon?: AppMemory | null;
  sessions: SessionMemory[];
  host: HostMemory;
  total_memory: number;
  total_cpu: number;
  collected_at_ms: number;
}

export async function getSystemMemorySnapshot(): Promise<SystemMemorySnapshot | null> {
  try {
    return await invoke<SystemMemorySnapshot | null>("system_memory_snapshot");
  } catch {
    return null;
  }
}
