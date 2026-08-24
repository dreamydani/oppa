import React from "react";
import { ShieldAlert } from "lucide-react";
import {
  useExtensionStore,
  type Toast,
} from "../../store/extensionStore";
import "./ExtensionsConsent.css";

// Consent dialog for scriptable extensions. Shown when enabling code whose
// fingerprint has no stored grant; denying leaves the extension off.

const CAPABILITY_LABELS: Record<string, string> = {
  notifications: "Show desktop notifications",
  storage: "Store its own small amount of data",
  "terminal:write": "Write text into a terminal you name",
  events: "React to session events (exit, title, focus)",
};

export function ExtensionConsentModal(): React.ReactElement | null {
  const pendingConsentId = useExtensionStore((s) => s.pendingConsentId);
  const extensions = useExtensionStore((s) => s.extensions);
  const grant = useExtensionStore((s) => s.grantConsentAndEnable);
  const dismiss = useExtensionStore((s) => s.dismissConsent);

  if (!pendingConsentId) return null;
  const ext = extensions.find((e) => e.id === pendingConsentId);
  if (!ext) return null;

  const handleGrant = () => {
    void grant(ext.id).catch(() => {});
  };

  return (
    <div
      className="ext-consent-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Enable extension"
    >
      <div className="ext-consent-modal">
        <div className="ext-consent-header">
          <ShieldAlert size={18} />
          <h3>Run &quot;{ext.name}&quot;?</h3>
        </div>
        <p className="ext-consent-lede">
          This extension contains code. Approving lets it run inside oppa with exactly these
          permissions:
        </p>
        <ul className="ext-consent-caps">
          {ext.capabilities.length === 0 && (
            <li>No special permissions (sandboxed compute only)</li>
          )}
          {ext.capabilities.map((cap) => (
            <li key={cap}>
              <code>{cap}</code>
              <span>{CAPABILITY_LABELS[cap] ?? cap}</span>
            </li>
          ))}
        </ul>
        <p className="ext-consent-note">
          You will be asked again if the extension&apos;s code or permissions change.
        </p>
        <div className="ext-consent-actions">
          <button type="button" className="ext-consent-btn secondary" onClick={dismiss}>
            Cancel
          </button>
          <button type="button" className="ext-consent-btn primary" onClick={handleGrant}>
            Trust and enable
          </button>
        </div>
      </div>
    </div>
  );
}

/** Minimal toast stack fed by extension notifications (auto-expires). */
export function ExtensionToasts(): React.ReactElement | null {
  const toasts = useExtensionStore((s) => s.toasts);

  React.useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t: Toast) =>
      window.setTimeout(() => useExtensionStore.getState().expireToast(t.key), 5000),
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  if (toasts.length === 0) return null;
  return (
    <div className="extension-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.key} className="extension-toast">
          <strong>{toast.title}</strong>
          {toast.body && <span>{toast.body}</span>}
        </div>
      ))}
    </div>
  );
}
