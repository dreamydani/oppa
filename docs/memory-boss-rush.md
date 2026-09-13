# Memory Boss Rush — 975MB idle → <250MB total

> LANDED (5 commits): footer Σ double-count fix + sysinfo trim
> (`1d6cd74`); tmp orphans + Kill snapshot delete + dead-sub rewire +
> resume-claim release (`18708d7`); history/port caps + `opt-level="z"`
> (`e35f3d3`); mirror scrollback 1000→200 + profile cache (`a2e5fa4`).
> Gates: `cargo test -p oppa --lib` 802 passed,
> `pnpm vitest run` 1493 passed.
> VERIFIED LAZY (no change): sherpa model loads only on first dictation
> (`stt_service.rs:250-257`, 1h idle eviction); rquickjs Runtime only per
> started engine, zero extensions = 1 parked pump thread.
> NEXT (needs product call): thread-per-session merge, queue drop policy
> ("never drop output" invariant), xterm rows, iframe unmount.

Target: 5 idle PowerShell panes, release build, 60s settle. `pnpm tauri dev` numbers don't count (debug + HMR inflate ~40-50%).
Done already (`de44f26`): reaper, store prune, 5k/2.5k scrollback. Don't redo.

## Lvl 0 — Release baseline (no code)
1. `pnpm build` + `cargo check` in `src-tauri`, install release, 5 idle panes, 60s settle.
2. Record GUI vs `oppa --daemon` vs ConPTY shells (footer Resource Manager + Task Manager).
3. Done when: three numbers logged here as the honest HP bar.

## Boss 1 — Lying meter (1-line fix)
Files: `src-tauri/src/system/memory.rs:158-159,104-105`, `src/components/layout/MemorySegment.tsx:131`.
Plan:
1. Failing test first: overlapping daemon/session PIDs assert `total = app + daemon` only.
2. Fix `collect_snapshot` sum; switch `System::new_all + refresh_all` to `new() + refresh_processes_specifics()` with reused instance.
3. Verify: `cargo test -p oppa --lib` + footer Σ drops with no behavior change.
Done when: Σ no longer exceeds host, 2s poll allocates O(sessions) not O(all procs).

## Boss 2 — Daemon hydra (460MB → ~80MB)
Files: `src-tauri/Cargo.toml:38,52`, `voice/stt_engine.rs:13`, `extensions/host.rs:9`, `pty/daemon_session.rs:20,362,403,495,538,571,573`, `pty/screen_mirror.rs:55-56`, `pty/daemon_client.rs:81-85`, `pty/daemon_server.rs:33`, `checkpoint.rs:194-219`.
Plan:
1. Lazy-load `sherpa-onnx` + `rquickjs` behind first use (never on boot); optional `--features voice,extensions`, default off.
2. Merge 6 threads/session into reader + 1s poller; checkpoint `3s → 15s` idle; `vt100` scrollback `1000 → 200`.
3. Snapshot single-pass viewport-only; cap `MAX_SNAPSHOT_BYTES 500KB → 64KB` on hash change only.
4. Cap subscriber/batcher channels at 256KB; drop hidden panes before channel; one shared tokio runtime.
5. Verify: `cargo test -p oppa --test daemon_integration_test`, release daemon RSS with 5 idle panes.
Done when: daemon idle <100MB, checkpoint spike <10MB.

## Boss 3 — Leak imps (growth without free)
Files: `pty/daemon_server.rs:304,381-395,56,83,99,171`, `pty/ipc_protocol.rs:187`, `pty/agent_handoff.rs:220-240`, `pty/snapshot.rs:141-177,265-287`, `pty/request_router.rs:263-293`, `voice/stt_service.rs:293-304,413-432`, `extensions/host.rs:68`.
Plan:
1. Failing tests first: `Kill` drains `subscribed_sessions`; `Disconnect` aborts `sub_task`; `Kill` deletes `<id>.json`; boot calls `cleanup_stale` (incl. `*.tmp.*`).
2. Remove sub entry on `Kill`, add `Unsubscribe` variant, clear `resumed_agent_ids` on `Kill`/`Shutdown`, cache `Box::leak` by command string, delete scrollback on `Kill`/`WorktreeRemove`, `Drop` guard joins dictation worker, bound extension mailbox.
3. Verify: `cargo test -p oppa --lib` + new integration tests; churn 100 fresh ids leaves no RAM/disk growth.
Done when: id churn is flat in RAM and `terminal-scrollback/`.

## Boss 4 — Frontend hoarders (514MB → ~120MB)
Files: `lib/terminal/scrollbackBudget.ts:69,47`, `TerminalPane.tsx:203-222`, `lib/terminal/webglRegistry.ts:15`, `lib/terminal/tabParking.ts:7-10`, `App.tsx:471`, `BrowserViewport.tsx:72-104`, `store/slices/browserPaneSlice.ts:58-73,106-124`, `store/slices/codeEditorSlice.ts:144-178,162-170,261-288`, `lib/terminal/writeQueue.ts:47`, `components/editor/CodeEditor.tsx:61`, `lib/monaco/localMonaco.ts:4-12`.
Plan:
1. Failing tests first: history cap, port cap, tab cap, writeQueue cap, diff cleared on mode switch.
2. xterm `5000 → 1000` focused / `200` background, agent `2500 → 1000`; park `30s → 10s`; blank/unmount hidden iframe; history cap 50, ports cap 32 LRU, editor tabs cap 10 + single `content` when clean; writeQueue 512KB coalesced; Monaco `React.lazy` + dispose `editorRef`.
3. Verify: `pnpm vitest run`, release GUI RSS with 5 panes.
Done when: GUI idle <150MB, background burst doesn't grow queue.

## Boss 5 — Build flags + gates (free)
Files: `src-tauri/Cargo.toml:71-74`.
Plan:
1. Add `opt-level="z"`, `panic="abort"`, keep `lto="fat"`.
2. Gates per quest: `cargo test -p oppa --lib`, `cargo test -p oppa --test daemon_integration_test`, `pnpm vitest run`; end each quest with `fix:`/`feat:` commit.
Done when: release binary smaller, all gates green, idle total <250MB.
