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

## P1 — Interleaved sections + chips + tall rows
- [ ] `workspace/WorkspaceList.tsx`: sections Pinned / Active-now / Recents (+ counts, sticky 11px uppercase headers). Chips = preset `searchQuery` values only (`All|Active|Worktrees|Needs-attn`). No filter system.
- [ ] Card: repo avatar (initial + deterministic hash color) + 13px/600 title + 11px second line (`cwd · branch · ↑↓`). Full path stays in tooltip. Inline rename → `titlePinned`.
- [ ] `theme.css`: 13px titles, 11px context/mono meta; fix `--text-secondary` undef + `--font-mono` → loaded Geist Mono.
- Tests: grouping, counts, chip filter, second line, rename pins title.
- // ponytail: avatar = title[0] + inline-style hash, no util/dep.

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
