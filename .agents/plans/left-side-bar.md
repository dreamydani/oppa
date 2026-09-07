# Left Sidebar Pro-grade Plan (`left-side-bar` branch)

Base: branched off `voice-orca-parity` (clean tree). Do NOT work on `voice-orca-parity`.
Mode: ponytail full (global plugin active, `.ponytail-active` = full).
Frozen: search box + `+` button (`LeftSidebar.tsx:122-163`) stay untouched.

Locked decisions: 1) 56px icon rail 2) interleaved + `Worktrees` chip 3) taller rows (~36px, 13px titles + 11px second line).

## P0 — Tri-state rail (fixes collapse/minimized) ✅ DONE
- [x] `store/slices/appChromeSlice.ts`: `leftSidebarMode: "open"|"rail"|"hidden"` (+ migrate `leftSidebarOpen`), `railWidth=56`. Persist `layout.json:ui`; `sidebarOnLaunch: open|rail|collapsed`.
- [x] `LeftSidebar.tsx/.css`: rail column = avatars + status dots + tooltips only; `--sidebar-w: 56px`; width-var switch for open↔rail, existing `SlideDrawer` slide only for hidden. No new drawer pose.
- [x] `TitleBar.tsx`: rail indicator state; `Cmd/Ctrl+B` cycles open→rail→hidden.
- [x] Rail collapsed state always shows avatars + attention dots, never empty.
- [ ] CUT (ponytail): card collapse-overrides persist — stays local-only until restart pain reported.
- Tests first: rail render, B-cycle, persistence, migration (`LeftSidebar.test.tsx`, `terminalStore.test.ts`).
- // ponytail: collapse local-only first, persist when restart pain reported.

## P1 — Interleaved sections + chips + tall rows ✅ DONE
- [x] Sections Pinned/Active/Recents + counts, sticky 11px uppercase headers (`WorkspaceList.tsx`, `workspace-list.css`).
- [x] Filter chips All/Active/Worktrees/Attention narrowing sections (`LeftSidebar.tsx` + CSS); search box untouched.
- [x] Tall two-line rows (13px title + 11px `cwd · branch` sub, deduped vs titles); repo initial avatar w/ hash hue; 13px card titles.
- [x] Token fixes: `--text-secondary` defined (both themes), `--font-mono` leads with Geist Mono.
- [ ] CUT (ponytail): per-row ahead/behind/dirty (no per-row git in store); inline rename (existing rename flows stay); card-collapse persist; DnD.
- Tests: 7 new (sections, pinned show/hide, 3 chip filters, subtitle) + 1 pin-test scoping fix.

## P2 — Worktree aliveness (normal + worktree rows) ✅ DONE
- [x] Row: status pill (`in-progress → main`), PR `#n` badge (shared `openWorktreeUrl`/`prNumberFromUrl` home in `WorktreeActionsMenu`), missing mark, `retired` dim. `...` menu kept.
- [x] Status: blocked amber dot + waiting hollow dot unhidden; unread rows bold; working dots + done dot kept.
- Tests: pill, PR badge href, missing, retired, blocked/waiting dots, unread (old silence test replaced as intended behavior change).

## P3 — Productivity wiring ✅ DONE
- [x] Row keyboard: `tabIndex` + Enter/Space focus, `p` pin, Delete/Backspace close (inner buttons keep own keys via closest-guard); focus-visible ring on `--focus-ring`.
- [x] Right-click row menu reusing `.worktree-card-menu` panel: Focus/Pin/Split/Copy path/Close (+ Esc/outside close). Copy uses `record.path ?? session.cwd`.
- [x] Empty states: Attention → "All caught up"; Worktrees → "No worktrees" + New Worktree button (→ `openWorktreeCreate`); search keeps "No Matches".
- [ ] CUT (ponytail): arrow-key roving nav (Tab order suffices); custom menu chrome; DnD.
- Tests: Enter focus, p/Del shortcuts, context menu + clipboard, 2 empty states.

## Verify each phase
`pnpm vitest run src/components/LeftSidebar.test.tsx src/components/workspace/WorkspaceList.test.tsx` + `cargo check` in `src-tauri`. End task with conventional commit (`feat:`/`fix:`).
