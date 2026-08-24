// Author in TypeScript against docs/extensions/sdk/oppa.d.ts, then bundle to
// a single `main.js` next to this manifest, e.g.:
//   npx esbuild main.ts --bundle --format=iife --outfile=main.js
// Drop the folder into <appData>/oppa/extensions/<yourname.my-extension>/

import type { SessionExitEvent } from "../sdk/oppa";

const RUN_THRESHOLD_MS = 30_000;

const startedAt = new Map<string, number>();

oppa.on("title-changed", (evt) => {
  if (!startedAt.has(evt.id)) {
    startedAt.set(evt.id, Date.now());
  }
});

oppa.on("session-exit", (evt: SessionExitEvent) => {
  const at = startedAt.get(evt.id);
  startedAt.delete(evt.id);
  const ranMs = at ? Date.now() - at : Number.POSITIVE_INFINITY;
  if (ranMs >= RUN_THRESHOLD_MS) {
    oppa.notify("Terminal finished", "Session ended after " + Math.round(ranMs / 1000) + "s");
  }
});
