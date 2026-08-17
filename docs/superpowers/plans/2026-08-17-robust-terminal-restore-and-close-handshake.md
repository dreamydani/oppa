# Robust Terminal Restore & Window Close Handshake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Intercept Tauri 2 window close events before webview destruction to flush layout and multi-tab scrollback snapshots, and cache background tab buffers on unmount to match Orca's terminal restore pipeline.

**Architecture:** Rust backend in `src-tauri/src/lib.rs` hooks `on_window_event` for `WindowEvent::CloseRequested`, prevents immediate destruction, emits `app:before-close`, and awaits `confirm_save_complete`. `terminalStore.ts` and `TerminalPane.tsx` maintain a `cachedScrollbacks` map so background tabs persist their scrollbacks on close or auto-save.

**Tech Stack:** Tauri 2, Rust, React 19, TypeScript, Zustand, Vitest.

## Global Constraints

- **Non-blocking Destruction**: If the renderer hangs or fails to respond within 1.5s, Rust must proceed to destroy the window cleanly.
- **TDD**: Write failing tests first, verify failure, implement, verify pass, and commit.
- **Complete Parity**: Preserves all active and background tab terminals and scrollback histories across restarts.

---

### Task 1: Tauri 2 Window Close Handshake on `WindowEvent::CloseRequested` (`src-tauri/src/lib.rs`)

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `on_window_event` handling `WindowEvent::CloseRequested` with `api.prevent_close()`, asynchronous `app:before-close` emission, `confirm_save_complete` handshake loop, and `window.destroy()`.

- [ ] **Step 1: Update `src-tauri/src/lib.rs`**

```rust
mod layout;
mod pty;

use pty::manager::PtyManager;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let save_done = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
            pty::commands::pty_ack,
            pty::commands::pty_list,
            pty::commands::save_scrollback,
            pty::commands::load_scrollback,
            pty::commands::delete_scrollback,
            pty::commands::cleanup_stale_scrollbacks,
            layout::save_layout,
            layout::load_layout,
            confirm_save_complete,
        ])
        .setup(move |app| {
            let save_done = Arc::clone(&save_done);
            app.manage(save_done);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent immediate window destruction so webview can flush state
                api.prevent_close();

                let window_clone = window.clone();
                let flag = window.state::<Arc<AtomicBool>>();
                flag.store(false, Ordering::SeqCst);

                tauri::async_runtime::spawn(async move {
                    let _ = window_clone.emit("app:before-close", ());
                    let deadline = Instant::now() + Duration::from_millis(1500);
                    while Instant::now() < deadline {
                        if flag.load(Ordering::SeqCst) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                    let _ = window_clone.destroy();
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}

#[tauri::command]
fn confirm_save_complete(app: tauri::AppHandle) {
    let flag = app.state::<Arc<AtomicBool>>();
    flag.store(true, Ordering::SeqCst);
}
```

- [ ] **Step 2: Check Rust compilation and tests**

Run: `cargo test -p oppa --lib` in `src-tauri`
Expected: PASS (45 tests passed)

Run: `cargo check` in `src-tauri`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(tauri): intercept WindowEvent::CloseRequested for reliable close-save handshake"
```

---

### Task 2: Background Tab Scrollback Cache & Auto-Save in Store (`terminalStore.ts` & `TerminalPane.tsx`)

**Files:**
- Modify: `src/store/terminalStore.ts`
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/store/terminalStore.test.ts`
- Modify: `src/components/TerminalPane.test.tsx`

**Interfaces:**
- Produces: `cachedScrollbacks: Record<string, string>` and `cacheScrollback: (id: string, buffer: string) => void` in `TerminalState`.
- Produces: `saveLayout()` saving buffers from both `serializers` and `cachedScrollbacks`.
- Produces: `TerminalPane` caching buffer on unmount.

- [ ] **Step 1: Write failing unit tests in `src/store/terminalStore.test.ts`**

Test that:
1. `cacheScrollback` stores buffer in `cachedScrollbacks`.
2. `saveLayout` saves buffer from `cachedScrollbacks` when a session has no active serializer in `serializers` (e.g. background tab).
3. `loadLayout` preloads scrollback from `saveScrollback` and restores sessions.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `src/store/terminalStore.ts`**

1. Add `cachedScrollbacks: Record<string, string>` in `TerminalState`.
2. Add `cacheScrollback: (id: string, buffer: string) => void`:
   ```typescript
   cacheScrollback: (id, buffer) =>
     set((state) => ({
       cachedScrollbacks: { ...state.cachedScrollbacks, [id]: buffer },
     })),
   ```
3. Update `saveLayout()`:
   ```typescript
   saveLayout: async () => {
     if (!get().ready) return;
     const { activeTabId, sessions, serializers, cachedScrollbacks } = get();
     const currentTabs = getSyncedTabs(get());
     const snapshot = {
       tabs: currentTabs.map((t) => ({
         id: t.id,
         ...(t.title !== undefined ? { title: t.title } : {}),
         layout: t.layout,
         focusedPath: t.focusedPath,
       })),
       activeTabId: activeTabId || currentTabs[0]?.id || "tab-1",
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
     for (const s of Object.values(sessions)) {
       const buffer = serializers[s.id]?.() || cachedScrollbacks[s.id];
       if (buffer) {
         await saveScrollback(s.id, buffer);
       }
     }
     await cleanupStaleScrollbacks(Object.keys(sessions));
   }
   ```
4. In `TerminalPane.tsx`:
   On unmount in cleanup return:
   ```typescript
   return () => {
     disposed = true;
     ro.disconnect();
     unsubs.forEach((u) => u());
     const buffer = serializeAddonRef.current?.serialize();
     if (buffer) {
       useTerminalStore.getState().cacheScrollback(idRef.current, buffer);
     }
     unregisterSerializer(idRef.current);
     term.dispose();
     termRef.current = null;
     searchAddonRef.current = null;
     serializeAddonRef.current = null;
   };
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/components/TerminalPane.tsx src/store/terminalStore.test.ts src/components/TerminalPane.test.tsx
git commit -m "feat(store): cache background tab scrollbacks on unmount for full restore parity"
```

---

### Task 3: Full Project Verification

- [ ] **Step 1: Run full test and build suite**

Run:
1. `cargo test -p oppa --lib` in `src-tauri`
2. `cargo check` in `src-tauri`
3. `pnpm vitest run`
4. `pnpm build`

- [ ] **Step 2: Commit any final adjustments**
