# Scrollback Snapshots & Cold Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement persistent scrollback recovery and cold restore in OPPA, serializing terminal history to disk on exit and replaying it with a `[Session Restored]` indicator when reopening the app.

**Architecture:** Rust backend in `snapshot.rs` manages atomic file persistence in `<app_data_dir>/terminal-scrollback/`. Frontend uses `@xterm/addon-serialize` on `TerminalPane` to capture ANSI buffers, and `loadLayout` in `terminalStore.ts` replays the buffer before starting the fresh shell process.

**Tech Stack:** Rust, Tauri 2, `@xterm/addon-serialize`, React 19, TypeScript, Vitest, Zustand.

## Global Constraints

- **Atomic Writes**: Always write to a temp file and rename to prevent corrupted snapshot files on unexpected termination.
- **TDD**: Write failing tests first, verify failure, implement, verify pass, and commit.
- **Safe Fallback**: If a snapshot file is missing or corrupted, fail gracefully and start a clean shell without errors or panics.

---

### Task 1: Rust Snapshot Backend (`snapshot.rs` & `commands.rs`)

**Files:**
- Create: `src-tauri/src/pty/snapshot.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Modify: `src-tauri/src/pty/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/pty/snapshot.rs` (inline test module)

**Interfaces:**
- Produces: `pub struct SnapshotStorage`
- Produces: `impl SnapshotStorage { pub fn new(app_data_dir: PathBuf) -> Self; pub fn save(&self, id: &str, data: &str) -> std::io::Result<()>; pub fn load(&self, id: &str) -> std::io::Result<Option<String>>; pub fn delete(&self, id: &str) -> std::io::Result<()>; pub fn cleanup_stale(&self, active_ids: &[String]) -> std::io::Result<()>; }`
- Tauri Commands: `save_scrollback`, `load_scrollback`, `delete_scrollback`, `cleanup_stale_scrollbacks`

- [ ] **Step 1: Write failing tests in `src-tauri/src/pty/snapshot.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_save_and_load_scrollback_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_snap_test_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        let sample_ansi = "\x1b[32mSuccess\x1b[0m\r\nLine 2";
        storage.save("session-1", sample_ansi).expect("save succeeds");

        let loaded = storage.load("session-1").expect("load succeeds");
        assert_eq!(loaded, Some(sample_ansi.to_string()));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_delete_scrollback() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_snap_del_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        storage.save("session-2", "content").expect("save succeeds");
        storage.delete("session-2").expect("delete succeeds");

        let loaded = storage.load("session-2").expect("load succeeds");
        assert_eq!(loaded, None);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib pty::snapshot` in `src-tauri`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src-tauri/src/pty/snapshot.rs`**

```rust
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const SNAPSHOT_DIR: &str = "terminal-scrollback";
const MAX_SNAPSHOT_BYTES: usize = 500 * 1024; // 500KB cap

pub struct SnapshotStorage {
    dir: PathBuf,
}

impl SnapshotStorage {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            dir: app_data_dir.join(SNAPSHOT_DIR),
        }
    }

    fn snapshot_path(&self, id: &str) -> PathBuf {
        let safe_id = id.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
        self.dir.join(format!("{safe_id}.bin"))
    }

    pub fn save(&self, id: &str, data: &str) -> std::io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(&self.dir)?;

        let target_path = self.snapshot_path(id);
        let tmp_path = self.dir.join(format!("{}.tmp.{}", id, std::process::id()));

        // Truncate to trailing MAX_SNAPSHOT_BYTES on valid UTF-8 boundary
        let bytes = data.as_bytes();
        let slice = if bytes.len() > MAX_SNAPSHOT_BYTES {
            let start = bytes.len() - MAX_SNAPSHOT_BYTES;
            let mut valid_start = start;
            while valid_start < bytes.len() && (bytes[valid_start] & 0xc0) == 0x80 {
                valid_start += 1;
            }
            &bytes[valid_start..]
        } else {
            bytes
        };

        {
            let mut file = File::create(&tmp_path)?;
            file.write_all(slice)?;
            file.sync_all()?;
        }

        fs::rename(&tmp_path, &target_path)?;
        Ok(())
    }

    pub fn load(&self, id: &str) -> std::io::Result<Option<String>> {
        let path = self.snapshot_path(id);
        if !path.exists() {
            return Ok(None);
        }
        let mut file = File::open(&path)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        let path = self.snapshot_path(id);
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }

    pub fn cleanup_stale(&self, active_ids: &[String]) -> std::io::Result<()> {
        if !self.dir.exists() {
            return Ok(());
        }
        let active_set: std::collections::HashSet<_> = active_ids.iter().map(|id| self.snapshot_path(id)).collect();
        for entry in fs::read_dir(&self.dir)? {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() && path.extension().map_or(false, |ext| ext == "bin") {
                    if !active_set.contains(&path) {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
        Ok(())
    }
}
```

- [ ] **Step 4: Register `snapshot` module and add Tauri commands in `commands.rs` & `lib.rs`**

In `src-tauri/src/pty/commands.rs`:
```rust
#[tauri::command]
pub fn save_scrollback(app: AppHandle, id: String, data: String) -> Result<(), String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let storage = crate::pty::snapshot::SnapshotStorage::new(app_data_dir);
    storage.save(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_scrollback(app: AppHandle, id: String) -> Result<Option<String>, String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let storage = crate::pty::snapshot::SnapshotStorage::new(app_data_dir);
    storage.load(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_scrollback(app: AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let storage = crate::pty::snapshot::SnapshotStorage::new(app_data_dir);
    storage.delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cleanup_stale_scrollbacks(app: AppHandle, active_ids: Vec<String>) -> Result<(), String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let storage = crate::pty::snapshot::SnapshotStorage::new(app_data_dir);
    storage.cleanup_stale(&active_ids).map_err(|e| e.to_string())
}
```

In `src-tauri/src/lib.rs`, register the 4 new invoke handlers:
`save_scrollback`, `load_scrollback`, `delete_scrollback`, `cleanup_stale_scrollbacks`.

- [ ] **Step 5: Run tests and verify**

Run: `cargo test -p oppa --lib` in `src-tauri`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty/snapshot.rs src-tauri/src/pty/mod.rs src-tauri/src/pty/commands.rs src-tauri/src/lib.rs
git commit -m "feat(pty): add atomic scrollback snapshot storage and Tauri commands"
```

---

### Task 2: Frontend Serialization Addon & Transport Helpers (`package.json`, `transport.ts`)

**Files:**
- Modify: `package.json`
- Modify: `src/lib/pty/transport.ts`
- Modify: `src/lib/pty/transport.test.ts`

**Interfaces:**
- Produces: `export async function saveScrollback(id: string, data: string): Promise<void>`
- Produces: `export async function loadScrollback(id: string): Promise<string | null>`
- Produces: `export async function deleteScrollback(id: string): Promise<void>`
- Produces: `export async function cleanupStaleScrollbacks(activeIds: string[]): Promise<void>`

- [ ] **Step 1: Install `@xterm/addon-serialize`**

Run: `pnpm add @xterm/addon-serialize`

- [ ] **Step 2: Add failing unit tests in `src/lib/pty/transport.test.ts`**

```typescript
describe("scrollback transport", () => {
  it("calls save_scrollback with id and data", async () => {
    await saveScrollback("s1", "\x1b[32mhi\x1b[0m");
    expect(mockInvoke).toHaveBeenCalledWith("save_scrollback", { id: "s1", data: "\x1b[32mhi\x1b[0m" });
  });

  it("calls load_scrollback and returns content", async () => {
    mockInvoke.mockResolvedValueOnce("previous output");
    const result = await loadScrollback("s1");
    expect(mockInvoke).toHaveBeenCalledWith("load_scrollback", { id: "s1" });
    expect(result).toBe("previous output");
  });

  it("calls delete_scrollback with id", async () => {
    await deleteScrollback("s1");
    expect(mockInvoke).toHaveBeenCalledWith("delete_scrollback", { id: "s1" });
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm vitest run src/lib/pty/transport.test.ts`
Expected: FAIL (functions not exported)

- [ ] **Step 4: Implement transport helpers in `src/lib/pty/transport.ts`**

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/pty/transport.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/pty/transport.ts src/lib/pty/transport.test.ts
git commit -m "feat(transport): add scrollback snapshot transport helpers"
```

---

### Task 3: Cold Restore Lifecycle & Session Restored Banner (`terminalStore.ts`, `TerminalPane.tsx`)

**Files:**
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`
- Modify: `src/components/TerminalPane.test.tsx`

**Interfaces:**
- Produces: `saveLayout()` captures each active pane's buffer via `serializeAddon.serialize()` and calls `saveScrollback`.
- Produces: `loadLayout()` loads scrollback, replays into xterm, displays session restored indicator, and spawns fresh shell.

- [ ] **Step 1: Write failing unit test in `src/store/terminalStore.test.ts` and `TerminalPane.test.tsx`**

Test that:
1. `saveLayout` saves serialized scrollbacks for each active session.
2. `closePane` deletes the removed session's scrollback.
3. `loadLayout` loads previous scrollback and maps to restored sessions.

- [ ] **Step 2: Implement SerializeAddon and Scrollback capture in `TerminalPane.tsx`**

In `TerminalPane.tsx`:
- Load `SerializeAddon`:
  ```tsx
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  serializeAddonRef.current = serialize;
  ```
- Expose getter or register serializer callback on store.

- [ ] **Step 3: Update `saveLayout` and `loadLayout` in `src/store/terminalStore.ts`**

In `terminalStore.ts`:
1. In `saveLayout`:
   ```typescript
   saveLayout: async () => {
     if (!get().ready) return;
     const { layout, sessions } = get();
     const snapshot = {
       layout,
       sessions: Object.values(sessions).map((s) => ({
         id: s.id,
         title: s.title,
         status: s.status,
         cwd: s.cwd,
         cols: s.cols,
         rows: s.rows,
       })),
     };
     await transportSaveLayout(JSON.stringify(snapshot));
     // Save buffers for each running session
     for (const s of Object.values(sessions)) {
       const buffer = get().serializers[s.id]?.();
       if (buffer) {
         await saveScrollback(s.id, buffer).catch(() => {});
       }
     }
     const activeIds = Object.keys(sessions);
     await cleanupStaleScrollbacks(activeIds).catch(() => {});
   }
   ```
2. In `loadLayout`:
   ```typescript
   loadLayout: async () => {
     try {
       const saved = await transportLoadLayout();
       if (!saved) return;
       const parsed = JSON.parse(saved);
       const byId = new Map(parsed.sessions.map((s: any) => [s.id, s]));
       const remap: Record<string, string> = {};
       for (const oldId of leafIds(parsed.layout)) {
         if (oldId === "") continue;
         const savedCwd = byId.get(oldId)?.cwd;
         const newId = await get().spawnSession(savedCwd);
         remap[oldId] = newId;
         // Pre-load scrollback for newId from oldId
         const previousScrollback = await loadScrollback(oldId).catch(() => null);
         if (previousScrollback) {
           get().setRestoredScrollback(newId, previousScrollback);
           // Migrate snapshot file to newId
           await saveScrollback(newId, previousScrollback).catch(() => {});
           await deleteScrollback(oldId).catch(() => {});
         }
       }
       set({ layout: remapLeafIds(parsed.layout, remap) });
     } finally {
       set({ ready: true });
     }
   }
   ```
3. In `TerminalPane.tsx`:
   On terminal mount, check `restoredScrollback = useTerminalStore((s) => s.restoredScrollbacks[id]);`
   If present:
   ```typescript
   term.write(restoredScrollback);
   term.writeln("\r\n\x1b[2m── [Session Restored] ──────────────────────────────────────\x1b[0m\r\n");
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalPane.tsx src/store/terminalStore.ts src/store/terminalStore.test.ts src/components/TerminalPane.test.tsx
git commit -m "feat(ui): implement cold restore replay and session restored divider"
```

---

### Task 4: Full Project Verification

- [ ] **Step 1: Run full test and build suite**

Run:
1. `cargo test -p oppa --lib` in `src-tauri`
2. `cargo check` in `src-tauri`
3. `pnpm vitest run`
4. `pnpm build`

- [ ] **Step 2: Commit any final integration adjustments if needed**
