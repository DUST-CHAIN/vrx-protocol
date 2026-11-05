// PURE buyer-masking helper — NO crypto / NO fs import, so it is safe to import from the client (the agent
// screen, which lets the agent choose per-field masking at booking time) AND from the server (which applies
// the mask before shipping a developer-scoped response). Mirrors the lib/buyer-snapshot.ts split. (.)
//
// WHAT THIS IS (the anti-poaching moat): at booking the agent seals the buyer's identifying detail so
// the developer sees only a NON-IDENTIFYING proof until the deal is finalized (deposit paid). This protects
// the agent's customer relationship from being poached by the developer before the agent's work is secured.
//
// CRITICAL (the access-control truth): masking is SERVER-SIDE, not a UI blur. The sealed fields must
// NEVER be shipped in a developer-scoped response until the unlock event fires — if the plaintext reaches
// the browser, dev-tools reveals it and the protection is theatre. This module is the pure masking LOGIC;
// the server gate that actually withholds the sealed part lives in lib/offers.ts / app/api/offers (which
// call `publicBuyerView` below for a locked offer, and ship the full `seal.buyer` only once unlocked).
//
// The on-chain request_hash still seals the WHOLE buyer record (public + sealed) via seal.buyer, so when it
// unlocks the developer re-hashes and gets ✓ VETTED — privacy AND tamper-evidence from the same seal. The
// agent's per-field mask CHOICE is itself recorded (seal.buyerMask) so a later dispute shows what was shown.

/** Per-field visibility the agent chooses at booking. `partial` = reveal a non-identifying hint only. */
export type MaskMode = "show" | "partial" | "hide";

/** The agent's per-field mask choice. Keys mirror BuyerSnapshotFields. Absent key → the DEFAULT_MASK below. */
export type BuyerMask = Partial<Record<string, MaskMode>>;

/**
 * The DEFAULT masking preset (Q2/Q3): show first+last char of name & id, show country, hide
 * address/contact. This is what applies to any field the agent doesn't explicitly override — "enough to
 * decide whether to hold the unit and to talk about the deal, but not enough to poach it."
 */
export const DEFAULT_MASK: Record<string, MaskMode> = {
  name: "partial",
  //  name-split — each part masks independently. Mirror the composed `name` policy ("enough to talk, not
  // to poach"): the honorific is harmless (show); first + last get the partial hint (first+last char); the
  // nickname and middle name are extra identifying detail → hidden by default, the agent can reveal per-field.
  title: "show",
  firstName: "partial",
  nickName: "hide",
  middleName: "hide",
  lastName: "partial",
  idRef: "partial",
  nationality: "show",
  phone: "hide",
  email: "hide",
  note: "hide",
  remarks: "hide",
};

/** Named presets the agent can one-click apply, then still customise any field. */
export type MaskPreset = "default" | "mask-all" | "show-all";

/** Resolve a preset to a full per-field mask map over the known snapshot keys. */
export function presetMask(preset: MaskPreset): BuyerMask {
  const keys = [
    "name", "title", "firstName", "nickName", "middleName", "lastName",
    "phone", "email", "nationality", "idRef", "note", "remarks",
  ];
  if (preset === "show-all") return Object.fromEntries(keys.map((k) => [k, "show" as MaskMode]));
  if (preset === "mask-all") return Object.fromEntries(keys.map((k) => [k, "hide" as MaskMode]));
  return { ...DEFAULT_MASK };
}

/**
 * Partial-reveal a single value = first + last visible character, the middle dotted. A 1-char value shows
 * as that char + a dot; empty stays empty. Multi-word (a full name) is masked word-by-word so "John Smith"
 * → "J•• S••••" keeps the word shape (how many names, roughly how long) without revealing them.
 */
export function partialValue(v: string): string {
  const mask1 = (w: string): string => {
    if (w.length <= 1) return w ? `${w}•` : "";
    if (w.length === 2) return `${w[0]}•`;
    return `${w[0]}${"•".repeat(Math.max(1, w.length - 2))}${w[w.length - 1]}`;
  };
  return v
    .split(/(\s+)/) // keep the whitespace tokens so spacing is preserved
    .map((tok) => (/\s/.test(tok) ? tok : mask1(tok)))
    .join("");
}

/**
 * Apply one field's mask mode to its value. `show` → verbatim; `partial` → first+last chars; `hide` →
 * omitted entirely (caller drops the key so it never reaches the developer at all).
 */
export function applyMask(mode: MaskMode, value: string): string | null {
  if (mode === "hide") return null;
  if (mode === "partial") return partialValue(value);
  return value;
}

/**
 * The DEFAULT mask for a DIRECT-SALES buyer profile (d). The direct funnel (lib/buyers-direct.ts)
 * uses its OWN field vocabulary (legalName/passportNo/idCardNo/address) — NOT the booking snapshot's
 * (idRef/note). So the booking DEFAULT_MASK does not cover it; relying on the `?? "hide"` fall-through would
 * work but be silent + fragile. This preset names EVERY direct-profile field explicitly, so adding a new
 * profile field forces a deliberate masking decision here (fail-visible, not fail-silent).
 *
 * Policy mirrors the booking default ("enough to decide + talk, not enough to poach"): show a partial name
 * hint + nationality (needed for the freehold quota conversation); DROP the hard identifiers (passport, ID
 * card, address) and contact — these are exactly what a developer could poach or a scammer could abuse, and
 * the desk gets them only after a consented reveal (the B–E negotiation arc, next session).
 */
export const DIRECT_PROFILE_MASK: Record<string, MaskMode> = {
  name: "partial",
  legalName: "hide",
  nationality: "show",
  phone: "hide",
  email: "hide",
  passportNo: "hide",
  idCardNo: "hide",
  address: "hide",
};

/**
 * Project a DIRECT-SALES buyer PROFILE (a nested BuyerDirectProfile object) into the counterparty-safe view
 * the desk developer may see. Thin wrapper over `publicBuyerView` with the direct vocabulary + default mask.
 * Reuses the exact masking PRIMITIVES (partial/hide/show) so there is ONE masking seam, not a parallel one.
 * `mask` overrides per field (e.g. a buyer who chose to show their name → { name: "show" }); absent → the
 * DIRECT_PROFILE_MASK default. Returns a plain field map safe to ship to the desk (no withheld plaintext).
 */
export function publicDirectProfileView(
  profile: Record<string, unknown> | undefined,
  mask?: BuyerMask
): Record<string, string> | undefined {
  if (!profile || typeof profile !== "object") return undefined;
  // Stringify values (profile fields are strings; coerce defensively) then run the shared masker with the
  // direct default folded in, so an unmapped future key still fails CLOSED (hide) rather than leaking.
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (v == null) continue;
    flat[k] = String(v);
  }
  const effective: BuyerMask = { ...DIRECT_PROFILE_MASK, ...(mask ?? {}) };
  return publicBuyerView(flat, effective);
}

/**
 * Build the PUBLIC buyer view the developer may see BEFORE unlock — the full snapshot run through the mask.
 * Hidden fields are dropped; partial fields are reduced to a non-identifying hint; shown fields pass. The
 * returned map is SAFE to ship to a developer-scoped response (it contains no withheld plaintext).
 *
 * This is the server's gate input: for a LOCKED offer the server ships `publicBuyerView(buyer, mask)`; for
 * an UNLOCKED offer it ships the full `buyer`. The browser never receives withheld plaintext either way.
 */
export function publicBuyerView(
  buyer: Record<string, string> | undefined,
  mask: BuyerMask | undefined
): Record<string, string> | undefined {
  if (!buyer || typeof buyer !== "object") return buyer;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(buyer)) {
    // attestationSource is RECORD METADATA (a trust tier), not maskable PII. Always pass it through
    // verbatim so the developer's trust badge is honest even while every identifying field stays hidden.
    if (k === "attestationSource") {
      out[k] = String(v);
      continue;
    }
    const mode = (mask?.[k] ?? DEFAULT_MASK[k] ?? "hide") as MaskMode;
    const shown = applyMask(mode, String(v));
    if (shown !== null) out[k] = shown;
  }
  return out;
}
