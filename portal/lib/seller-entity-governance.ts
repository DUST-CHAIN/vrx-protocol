// SELLER-ENTITY GOVERNANCE — the TIER-1 "a governance fact a party relied on changed" path (Slice 4,
// the design docs §Slice 4; arc design the design docs §3 TIER-1). SERVER-ONLY.
//
// ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────────────────────────────────
// A seller entity is developer-GLOBAL and reused by id (lib/seller-entities). Editing its `directorName` /
// company / bank-destination through /api/seller-entities silently ripples to EVERY building pointing at it —
// including on-contract buildings an agency/buyer trusted ("contract with company Y, signed off by director X").
// The taxonomy (§3 TIER-1) says those are first-class SEALED events with mandatory notification. The entity
// store has no building context, so the governance layer bridges it: on an entity edit, DIFF the governed
// fields, find the entity's ON-CONTRACT buildings, and seal evidence + notify the affected parties PER building.
//
// A TIER-1 governance event is NOT an amendment/dispute trigger by itself (§3 — unlike a TIER-2 material spec
// change, Slice 3). It is part of the permanent evidence trail: sealed + notified, no amendment filed.
//
// ── PRIVACY ────────────────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY. The before/after are the developer's OWN business identity (company/director/bank) — not buyer
// PII; they appear on the S&P anyway (the seller must be identified). The feed line never carries the values
// (only WHICH field moved + the building); the before/after lives in the sealed evidence. Opaque party refs.

import type { SellerEntity } from "./catalog-client";

/** Which governed field moved on a seller-entity edit → which TIER-1 governance event it is. `director` = the
 *  director/signatory changed; `seller` = the company identity or the bank/payment destination changed. An edit
 *  can trigger BOTH (e.g. a company AND its director changed) — we return the set actually affected. */
export type GovernanceFieldKind = "director" | "seller";

/** The governed fields on a seller entity, in a canonical string form for a stable diff. `director` is the
 *  signatory; `seller` folds the company identity + the payment destinations (what a party contracts/pays into).
 *  A change in EITHER group is a governance event; the two map to the two verbs. */
function governedView(e: Partial<SellerEntity> | null | undefined) {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const ent = (e ?? {}) as Partial<SellerEntity>;
  // Payment destinations: the id-independent "where money goes" — kind|destination pairs, sorted (an id churn or
  // reorder is NOT a governance change; a destination change IS). Falls back to the legacy bankPayable string.
  const dests = Array.isArray(ent.paymentOptions)
    ? ent.paymentOptions
        .map((o) => `${s(o?.kind)}:${s(o?.destination)}`)
        .filter((x) => x !== ":")
        .sort()
        .join("|")
    : "";
  const legacyBank = s(ent.bankPayable);
  return {
    director: s(ent.directorName),
    seller: [s(ent.companyName), s(ent.companyNameTH), s(ent.taxId), dests, legacyBank].join("¦"),
  };
}

/**
 * Diff the governed fields of a seller entity across an edit. Returns the set of TIER-1 governance events the
 * change triggers: "director" if the signatory moved, "seller" if the company identity or payment destination
 * moved. Empty when nothing governed changed (a pure label/email/phone tweak is not a governance event). Pure.
 *
 * `before`/`after` may be partial/absent (a create has no `before` → nothing to diff, returns []). Bias to
 * evidence is applied at the CALL site (we only seal/notify for on-contract buildings), not here — this is the
 * precise "what governed field actually moved" classifier.
 */
export function governanceDiff(
  before: Partial<SellerEntity> | null | undefined,
  after: Partial<SellerEntity> | null | undefined
): GovernanceFieldKind[] {
  if (!before || !after) return []; // a create (no prior) is not a governance CHANGE
  const b = governedView(before);
  const a = governedView(after);
  const out: GovernanceFieldKind[] = [];
  if (a.director !== b.director) out.push("director");
  if (a.seller !== b.seller) out.push("seller");
  return out;
}

/** The ChangeClass + verb a governance field kind maps to (so the seal/evidence + the feed line agree). */
export function governanceClassOf(kind: GovernanceFieldKind): "directorChange" | "sellerEntity" {
  return kind === "director" ? "directorChange" : "sellerEntity";
}
