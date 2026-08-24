/**
 * OPPA Extension SDK — Phase 2 (scriptable extensions).
 *
 * A scriptable extension is a directory with:
 *   - `oppa-extension.json` declaring `"main"` and its `capabilities`
 *   - a JS entry file (author in TypeScript, bundle to one file with esbuild)
 *
 * The entry runs inside a sandboxed QuickJS engine: no filesystem, no network,
 * no timers beyond your own state, hard memory/CPU budgets. The only way out
 * is the global `oppa` object below.
 */

/** Event payloads delivered to handlers registered via {@link Oppa.on}. */
export interface SessionExitEvent {
  id: string;
}

export interface TitleChangedEvent {
  id: string;
  title: string;
}

export interface FocusChangedEvent {
  id: string;
}

export type EventMap = {
  "session-exit": SessionExitEvent;
  "title-changed": TitleChangedEvent;
  "focus-changed": FocusChangedEvent;
};

export type EventKind = keyof EventMap;

/** Capabilities as declared in `oppa-extension.json`. */
export type Capability =
  | "notifications"
  | "storage"
  | "terminal:write"
  | "events";

export interface OppaApi {
  /** Sandbox/API revision. */
  readonly version: 1;
  /** The capabilities granted to this extension. */
  readonly capabilities: readonly Capability[];
  /**
   * Subscribe to a session event. Requires the `events` capability.
   * Only one handler per kind — registering again replaces it.
   */
  on<K extends EventKind>(kind: K, handler: (event: EventMap[K]) => void): void;
  /** Show a notification (rate-limited to ~10/minute). Requires `notifications`. */
  notify(title: string, body?: string): void;
  /** Persistent per-extension key/value storage. Values must be JSON-serializable. Requires `storage`. */
  storage: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };
  /**
   * Write text into the named terminal session, as if typed.
   * Requires `terminal:write`. Always name the session explicitly —
   * there is deliberately no "active terminal" here.
   */
  writeTerminal(sessionId: string, text: string): void;
}

declare global {
  // Injected by the host before your entry script runs.
  const oppa: OppaApi;
}

export {};
