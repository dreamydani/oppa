import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// The ONLY module that touches Tauri APIs for the extensions domain.
// Everything else goes through here (mirrors src/lib/pty/transport.ts).

/** Backend sentinel the renderer matches to trigger the consent dialog. */
export const CONSENT_REQUIRED_PREFIX = "consent required:";

export interface ExtensionListItem {
  id: string; // empty for errored entries
  name: string;
  version: string;
  description: string;
  is_builtin: boolean;
  enabled: boolean;
  error: string | null;
  theme_count: number;
  snippet_count: number;
  command_count: number;
  /** Scriptable = ships executable code; enabling requires consent. */
  is_scriptable: boolean;
  capabilities: string[];
  /** Enabling now would require the consent dialog. */
  consent_required: boolean;
  /** Last crash message recorded by the host supervisor. */
  crash_error: string | null;
}

export interface ContributedTheme {
  extension_id: string;
  /** Globally unique id persisted in settings: "<extension.id>:<theme.id>" */
  theme_id: string;
  name: string;
  theme_type: "dark" | "light";
  colors: Record<string, string>;
  preview_colors: [string, string, string, string];
}

export interface ContributionPayload {
  themes: ContributedTheme[];
}

export interface ExtensionNotification {
  id: string;
  title: string;
  body: string;
}

export interface ExtensionCrash {
  id: string;
  reason: string;
}

export function listExtensions(): Promise<ExtensionListItem[]> {
  return invoke<ExtensionListItem[]>("list_extensions");
}

export function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke("set_extension_enabled", { id, enabled });
}

export function getContributions(): Promise<ContributionPayload> {
  return invoke<ContributionPayload>("get_contributions");
}

/** Grant consent for a fingerprint and enable the extension atomically. */
export function grantExtensionConsent(id: string, fingerprint: string): Promise<void> {
  return invoke("grant_extension_consent", { id, fingerprint });
}

export function getExtensionFingerprint(id: string): Promise<string> {
  return invoke<string>("get_extension_fingerprint", { id });
}

export function onExtensionNotify(
  handler: (payload: ExtensionNotification) => void,
): Promise<() => void> {
  return listen<ExtensionNotification>("extensions:notify", (event) =>
    handler(event.payload),
  );
}

export function onExtensionCrashed(
  handler: (payload: ExtensionCrash) => void,
): Promise<() => void> {
  return listen<ExtensionCrash>("extensions:crashed", (event) => handler(event.payload));
}
