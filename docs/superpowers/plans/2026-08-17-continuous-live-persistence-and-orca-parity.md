# Continuous Live Persistence & Orca Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement continuous live background persistence so all tabs, split hierarchies, working directories, and scrollbacks are continuously written to disk as they change, guaranteeing 100% restoration even when the app is terminated via CLI `Ctrl+C` or sudden crash.

**Architecture:** `TerminalPane.tsx` debounces a 500ms idle snapshot flush after terminal output to keep disk snapshots fresh. `terminalStore.ts` triggers `saveLayout()` on every tab/split/CWD mutation.

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, `@xterm/addon-serialize`, Tauri 2.

## Global Constraints

- **Non-blocking Saves**: All background saves must be asynchronous and non-blocking so they never freeze or drop PTY output.
- **TDD**: Write failing tests first, verify failure, implement, verify pass, and commit.

---

### Task 1: Debounced Live Scrollback Flushing in `TerminalPane.tsx`

**Files:**
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/components/TerminalPane.test.tsx`

**Requirements:**
1. In `src/components/TerminalPane.tsx`:
   - Set up a debounced save helper:
     ```typescript
     const flushScrollback = () => {
       const buffer = serializeAddonRef.current?.serialize();
       if (buffer) {
         useTerminalStore.getState().cacheScrollback(idRef.current, buffer);
         void saveScrollback(idRef.current, buffer).catch(() => {});
       }
     };
     ```
   - On `onWriteParsed`, trigger a debounced `flushScrollback` (e.g. 500ms idle timeout).
   - On component unmount, clear debounce timer and immediately call `flushScrollback()`.
2. Follow TDD: Update `src/components/TerminalPane.test.tsx` to verify debounced scrollback saving on output and immediate flush on unmount.
3. Verify all tests pass with `pnpm vitest run src/components/TerminalPane.test.tsx`.
4. Commit with `feat(ui): continuously persist terminal scrollbacks on output and unmount`.

---

### Task 2: Instant Auto-Save on Store State Mutations (`terminalStore.ts`)

**Files:**
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

**Requirements:**
1. In `src/store/terminalStore.ts`:
   - Ensure `createTab`, `closeTab`, `selectTab`, `renameTab`, `splitPane`, `closePane`, and `updateSessionCwd` all invoke `void get().saveLayout().catch(() => {})`.
2. Follow TDD: Update `src/store/terminalStore.test.ts` to assert `saveLayout` is called on all tab operations and CWD updates.
3. Verify all tests pass with `pnpm vitest run src/store/terminalStore.test.ts`.
4. Commit with `feat(store): auto-persist layout and tabs on all state mutations`.

---

### Task 3: Full Project Verification

- [ ] **Step 1: Run full test and build suite**

Run:
1. `cargo test -p oppa --lib` in `src-tauri`
2. `cargo check` in `src-tauri`
3. `pnpm vitest run`
4. `pnpm build`

- [ ] **Step 2: Commit any final adjustments**
