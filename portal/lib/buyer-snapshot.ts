// PURE buyer-snapshot helper — NO crypto import, so it is safe to import from the client (agent screen)
// without pulling Node's crypto into the browser bundle. (lib/buyers.ts imports lib/seal, which imports
// `crypto`; this split keeps the booking-time snapshot client-safe.).

/**
 * The fixed set of honorifics the agent may pick for a buyer's title. A CLOSED list (not free text) so the
 * sealed name is predictable — people can't type unpredictable junk into a title, and the composed legal name
 * stays clean. `""` = no title. Keep this the single source of truth; the form dropdown and the
 * server validator both read it, so adding a title is a one-line change that both surfaces consume.
 */
export const TITLES = ["", "Mr", "Mrs", "Ms", "Miss", "Mx", "Dr", "Prof"] as const;
export type Title = (typeof TITLES)[number];

/** The buyer plaintext fields we snapshot. Mirrors BuyerFields in lib/buyers.ts (kept in sync by hand). */
export type BuyerSnapshotFields = {
  /** The composed display/legal name — the ONE required field and the string every downstream reader
   * uses (S&P contract, policy floor, inbox display). When the structured parts below are provided, `name` is
   * DERIVED from them by `composeName`; when only `name` is typed (no parts), it stands alone as before. */
  name: string;
  // ── Structured name parts (name-split). All optional; each seals + masks independently so the agent
  // can, e.g., show the first name but hide the surname. When any are set, `name` = composeName(parts). ──
  /** Honorific — one of TITLES (a closed set, never free text). Folded into the composed `name`. */
  title?: Title;
  /** Given / first name. */
  firstName?: string;
  /** Preferred name / nickname — NOT part of the legal composed `name`; default-hidden (it's identifying). */
  nickName?: string;
  /** Middle name(s). Folded into the composed `name`. */
  middleName?: string;
  /** Family / last name. Folded into the composed `name`. */
  lastName?: string;
  /** Contact phone. */
  phone?: string;
  email?: string;
  nationality?: string;
  idRef?: string;
  /** Agent-PRIVATE note about this customer (the agent's own CRM memory) — default-hidden from the developer. */
  note?: string;
  /** FREE-TEXT context the agent wants the DEVELOPER to know about this buyer/deal — distinct from the private
   * `note`. Default-hidden until the agent chooses to show it (mask "hide"), same as any identifying field. */
  remarks?: string;
};

/**
 * Compose the display/legal `name` from the structured parts: Title + First + Middle + Last (—
 * the honorific DOES ride in the composed legal name; the nickname does NOT — it's a separate sealed hint).
 * Trims + collapses whitespace so the seal is stable regardless of stray spacing. Returns "" if no part is set
 * (the caller then keeps whatever free-typed `name` the agent entered — full backward compatibility).
 */
export function composeName(parts: {
  title?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
}): string {
  return [parts.title, parts.firstName, parts.middleName, parts.lastName]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}

/**
 * — who ATTESTED this buyer record. A first-class trust tier: buyer-entered detail is more trustworthy
 * than agent-typed, and makes the introduction bilateral (the agent can't fabricate a buyer; the buyer
 * can't later deny engaging the agent). v1 only ever produces "agent" (the frictionless FLOOR);
 * "buyer-confirmed" (acked via a no-wallet confirm link) and "buyer-self" (self-created in the Buyer client)
 * are the UPGRADES that ride the Part-F Buyer client. The developer weights the record by this tier.
 */
export type AttestationSource = "agent" | "buyer-confirmed" | "buyer-self";

/**
 * The attested SNAPSHOT that rides in a booking's offer seal (`seal.buyer`, lib/seal.ts / lib/offers.ts).
 * A FLAT label→value map (string values only) so the developer inbox's BuyerBlock (node/page.tsx), which
 * does `Object.entries(buyer).map(([k,v]) => String(v))`, renders it directly without `[object Object]`.
 * Only non-empty fields appear — an honest minimal snapshot, never fabricated. The booking's own
 * request_hash seals this map (it's folded into the agent's hashRef), so no separate ref object is needed;
 * the developer verifies the whole offer, buyer map included, via the existing ✓ VETTED re-hash.
 *
 * IMPORTANT ( digest stability): whatever this returns becomes part of the booking's request_hash via
 * the agent's hashRef. It must be built the SAME way on every booking so the developer's re-hash reproduces
 * it. Keep it pure + deterministic (fixed field order below, empties dropped).
 */
export function buyerSnapshot(
  fields: BuyerSnapshotFields,
  attestationSource: AttestationSource = "agent"
): Record<string, string> {
  const snap: Record<string, string> = { name: fields.name };
  //  name-split — the structured parts ride the seal as their own fields (each masks independently). Fixed
  // order, empties dropped: a buyer with NO parts produces the IDENTICAL snapshot as before the split, so every
  // already-sealed booking re-hashes to the same digest ( stability — no on-chain churn, backward compat).
  if (fields.title) snap.title = fields.title;
  if (fields.firstName) snap.firstName = fields.firstName;
  if (fields.nickName) snap.nickName = fields.nickName;
  if (fields.middleName) snap.middleName = fields.middleName;
  if (fields.lastName) snap.lastName = fields.lastName;
  if (fields.phone) snap.phone = fields.phone;
  if (fields.email) snap.email = fields.email;
  if (fields.nationality) snap.nationality = fields.nationality;
  if (fields.idRef) snap.idRef = fields.idRef;
  if (fields.note) snap.note = fields.note;
  if (fields.remarks) snap.remarks = fields.remarks;
  // — the attestation tier is part of the sealed snapshot. Always present (defaults to "agent"), so
  // the developer's view + trust badge always has it and a later buyer-confirm UPGRADE is a visible change.
  snap.attestationSource = attestationSource;
  return snap;
}
