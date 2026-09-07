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

## P2 — Worktree aliveness (normal + worktree rows)
- [ ] Worktree row: branch icon, `display_name`, pill `todo|in-progress|in-review|completed`, `→base_ref`, `PR #n` badge if `linked_pr_url`, `⚠ missing`, dim `retired`. Keep existing `...` menu.
- [ ] Status: unhide `blocked` (amber) / `waiting` (hollow); render `unreadBySessionId` bold+dot; keep working dots + done dot.
- Tests: badges, retired/missing, PR link, unread dot.
- // ponytail: badges from already-loaded store only, no per-row git IPC; add when stale-badge complaint lands.

## P3 — Productivity wiring
- [ ] Row keyboard: arrows navigate, `Enter` open, `p` pin, `a` close, `e` expand/collapse-all (cards already have `tabIndex`; extend pattern to rows).
- [ ] Right-click context menu reusing file-menu pattern (Rename/Pin/Split/Close/Copy path).
- [ ] Empty states: keep `No Workspaces`; add `No attention`, `No worktrees → Create` (→ `openWorktreeCreate`).
- Tests: key nav, pin key, menu actions, empty states.
- // ponytail: skipped DnD + custom menu chrome; reuse `dragState`/`...` menu when asked.

## Verify each phase
`pnpm vitest run src/components/LeftSidebar.test.tsx src/components/workspace/WorkspaceList.test.tsx` + `cargo check` in `src-tauri`. End task with conventional commit (`feat:`/`fix:`).
