// Operator secret — the owner's key that unlocks the VRX team dashboards (/root, /applications).
// It used to live as an inline field on each owner page; moved it into ⚙ Settings (owner-only), so
// it's a quiet once-per-session setting instead of dashboard clutter. This module is the single source of
// truth: one sessionStorage key + a browser event so a setter (Settings) and readers (the dashboards) stay
// in sync WITHOUT prop-drilling across the shell. Kept only in sessionStorage — never persisted to disk,
// never sent anywhere except as the x-vrx-operator header the server checks (fix #3, fails closed).

export const OPERATOR_SECRET_KEY = "vrx.operator.secret"; // shared by /root + /applications (historical key)
export const OPERATOR_SECRET_EVENT = "vrx:operator-secret"; // dispatched on window when the secret changes

export function readOperatorSecret(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(OPERATOR_SECRET_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeOperatorSecret(secret: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(OPERATOR_SECRET_KEY, secret);
  } catch {
    /* private mode — best-effort */
  }
  // Tell any open dashboard to pick up the new secret and re-fetch (same tab; storage event only fires
  // cross-tab, so we use a custom event for the common same-tab case).
  window.dispatchEvent(new CustomEvent(OPERATOR_SECRET_EVENT, { detail: secret }));
}

/** Subscribe to secret changes (same-tab custom event + cross-tab storage event). Returns an unsubscribe. */
export function onOperatorSecretChange(cb: (secret: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (e: Event) => cb((e as CustomEvent<string>).detail ?? readOperatorSecret());
  const onStorage = (e: StorageEvent) => {
    if (e.key === OPERATOR_SECRET_KEY) cb(e.newValue ?? "");
  };
  window.addEventListener(OPERATOR_SECRET_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(OPERATOR_SECRET_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
