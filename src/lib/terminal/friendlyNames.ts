// Friendly single-word birth names for terminal panes. Mirror of the Rust
// pool (src-tauri/src/pty/friendly_name.rs): the daemon seeds names, this
// fallback covers web-dev/no-daemon spawns only.

// Keep in sync with the Rust FRIENDLY_NAMES pool.
export const FRIENDLY_NAMES: readonly string[] = [
  "fox", "wolf", "bear", "hawk", "otter", "raven", "badger", "heron", "mole", "newt",
  "wren", "finch", "bison", "lynx", "seal", "crane", "gecko", "koala", "lemur", "magpie",
  "narwhal", "ocelot", "pika", "quail", "robin", "sparrow", "stoat", "tapir", "vole", "weasel",
  "birch", "cedar", "elm", "fern", "grove", "heath", "ivy", "juniper", "kelp", "larch",
  "moss", "oak", "pine", "reed", "spruce", "thyme", "willow", "yarrow", "amber", "basalt",
  "cinder", "dune", "ember", "flint", "garnet", "harbor", "inlet", "jasper", "knoll", "lagoon",
  "meadow", "onyx", "prairie", "quartz", "ridge", "summit", "tide", "umber", "vista", "brook",
  "comet", "drift", "frost", "glade",
];

// Synthetic titles are raw ids (s-… or the bare session id).
export function isSyntheticTitle(title: string | undefined, id: string): boolean {
  if (!title) return true;
  return title === id || title.startsWith("s-");
}

function hashStr(s: string): number {
  let hash = 0xcbf29ce484222325;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x100000001b3);
  }
  return Math.abs(hash);
}

// Deterministic per session id; first untaken word wins, numeric suffix only
// when the pool is exhausted.
export function pickFriendlyName(sessionId: string, taken: ReadonlySet<string>): string {
  const n = FRIENDLY_NAMES.length;
  const start = hashStr(sessionId) % n;
  for (let i = 0; i < n; i++) {
    const cand = FRIENDLY_NAMES[(start + i) % n];
    if (!taken.has(cand)) return cand;
  }
  let k = 2;
  for (;;) {
    const cand = `${FRIENDLY_NAMES[start]}-${k}`;
    if (!taken.has(cand)) return cand;
    k += 1;
  }
}
