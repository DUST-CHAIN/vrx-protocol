// VRX §3c LISTING GATE — the enforcement that turns a developer's §3c STANDING into platform consequences
// (enforcement seam #2) — SERVER-ONLY. Design: the design docs §3c.
//
// The standing machine (lib/dev-standing) computes a stage + `listingsHidden`. THIS module is the consumer
// that acts on it, at the DEVELOPER grain — which is the grain the fact actually lives at. §3c suspension is
// one truth ("this developer is late paying VRX"), so we enforce it at the two places a NEW deal can begin,
// NOT by mutating the hundreds of individual units a developer owns:
//
//   (1) BUYER DISCOVERY (lib/buyer-catalog) — a buyer browsing the Direct-Sales Desk never sees a
//  suspended/removed developer's buildings (developer-WHOLESALE; see buyer-catalog). No conflict:
//       the buyer catalog is pure NEW-inventory discovery — nobody's existing deal routes through it.
//   (2) NEW-DEAL ADMISSION (the agent booking path) — the agent cannot START a NEW booking against a
//       suspended developer. This is the real lever: a new deal is admitted by the on-chain GATE
//       (open_claim fails NO_GATE without an active gate). §3c suspension = the platform stops honouring
//       NEW bookings for a late developer. It is the strongest, lightest, most legally-clean remedy —
//       VRX withholds its OWN forward-looking service (surfacing + admitting new deals) for non-payment,
//       and touches NOTHING already signed.
//
// ── Why NOT a per-unit hide ───────────────────────────────────────────────────────────────────────────────
// Suspension is a developer-level fact. Expressing it as a per-unit status sweep (greying out every
// available unit) is the wrong grain: heavy (hundreds of units), racey (it fights the live on-chain status
// layer), and it would risk hiding a unit with a live hold — breaking §3c's own "existing deals continue"
// promise. Gating the single NEW-DEAL action instead honours "existing deals continue" FOR FREE (an existing
// deal never travels the new-booking path), with no sweep and no race. (the discipline:
// don't do the heavy per-unit thing when one gate expresses the truth.)
//
// ── On-chain target (V7+, DEFERRED — contract is FROZEN) ─────────────────────────────────────────────────
// The eventual on-chain enforcement of (2) is to SUSPEND / revoke the agency↔developer GATE for a late
// developer, so even a direct RPC open_claim is refused by the contract (the gate IS the admission
// authority). The contract is frozen and the signing/defrost arc is sequenced last, so this module is the
// OFF-CHAIN overlay that enforces the same intent now: a server-side courtesy gate consulted before the
// wallet signs, plus a witness-store guard. When the on-chain gate-suspend ships it slots in BEHIND this
// same seam (the overlay becomes belt-and-suspenders, the chain becomes the authority). See §3c +.
//
// PRIVACY: server-only; consumes a B2B standing fact (a stage). No PII, no amounts, nothing new on-chain.

import { resolveStandingForDeveloper } from "./dev-standing";
import { currentVrxDeveloperAgreement, VRX_DEVELOPER_TERMS_VERSION } from "./vrx-developer-agreement";
import { haltedBuildings, isBuildingHalted } from "./building-halt";

// ── §7 "SIGNING PRECEDES LISTING" (spirit) ─────────────────────────────────────────────────
// A developer who has not SIGNED the CURRENT VRX disclosure terms must have NO live listings. This is the
// upstream half of the §3c scheduler's §7 safety (lib/standing-scheduler): if an unsigned developer can't be
// discovered / can't admit a new deal, they accrue no VRX-fee obligation, so they can never reach a late state,
// so the scheduler never fires a timed consequence against a developer who never consented. The check is a
// SEPARATE reason from §3c suspension (different cause, different plain-words copy) — we OR them in the hide,
// we don't conflate them. "Signed current terms" means a signed agreement whose frozen termsVersion equals the
// live VRX_DEVELOPER_TERMS_VERSION: a terms re-wording bumps the version and re-requires signing,
// matching the §7 "disclosed THIS version" spirit — an old-version signature is NOT current consent.

/** True iff this developer has a CURRENT signed VRX agreement on the LIVE terms version. A developer with no
 *  signed agreement, or one frozen on a superseded terms version, is NOT current → their listings are hidden
 *  (see isDeveloperHidden). Fail-safe: any read error ⇒ false (treated as not-signed, i.e. hidden — the safe
 *  side is to withhold NEW VRX service until consent is proven, never to leak a listing from an unsigned dev). */
export async function hasSignedCurrentTerms(developer: string): Promise<boolean> {
  try {
    const g = await currentVrxDeveloperAgreement(developer);
    return !!g && g.seal.termsVersion === VRX_DEVELOPER_TERMS_VERSION;
  } catch {
    return false;
  }
}

/** The plain-words reason a developer's listings are withheld because they have not signed (or are not
 *  current on) the VRX agreement. Distinct from NEW_DEAL_PAUSED_REASON (a §3c non-payment pause) — this is a
 *  not-yet-onboarded state, not a penalty. */
export const NOT_SIGNED_REASON =
  "This developer hasn't completed their VRX agreement yet, so their listings aren't published. They'll appear once the agreement is signed.";

/** Resolve which of a set of developers are currently §3c-PAUSED (suspended/removed → `listingsHidden`).
 *  Returns a Set of developer labels (trimmed, lower-cased) the listing/booking reads must gate. Distinct
 *  developers are resolved once each (a catalog read can touch many buildings across a few developers).
 *  `asOf` injectable for tests/determinism. */
export async function suspendedDevelopers(
  developers: Iterable<string>,
  opts?: { asOf?: number }
): Promise<Set<string>> {
  const distinct = new Set<string>();
  for (const d of developers) {
    const key = (d ?? "").trim().toLowerCase();
    if (key) distinct.add(key);
  }
  const hidden = new Set<string>();
  await Promise.all(
    [...distinct].map(async (dev) => {
      if (await isDeveloperHidden(dev, opts)) hidden.add(dev);
    })
  );
  return hidden;
}

/** Is this ONE developer's inventory HIDDEN right now? TWO independent reasons, OR'd (see `whyDeveloperHidden`
 *  for which): (1) §3c-paused — suspended/removed → `listingsHidden`; (2) NOT signed on the current VRX terms
 *  ("signing precedes listing"). The buyer per-building check and the new-deal admission guard both use this.
 *  `asOf` injectable for tests. */
export async function isDeveloperHidden(developer: string, opts?: { asOf?: number }): Promise<boolean> {
  const standing = await resolveStandingForDeveloper(developer, { asOf: opts?.asOf });
  if (standing.listingsHidden) return true;
  return !(await hasSignedCurrentTerms(developer));
}

/** WHICH reason a developer is hidden (for the right plain-words copy). `"suspended"` = a §3c non-payment/
 *  misrepresentation pause (NEW_DEAL_PAUSED_REASON); `"not_signed"` = hasn't completed the VRX agreement
 *  (NOT_SIGNED_REASON); `null` = not hidden. §3c takes precedence when both apply (it's the active penalty). */
export async function whyDeveloperHidden(
  developer: string,
  opts?: { asOf?: number }
): Promise<"suspended" | "not_signed" | null> {
  const standing = await resolveStandingForDeveloper(developer, { asOf: opts?.asOf });
  if (standing.listingsHidden) return "suspended";
  if (!(await hasSignedCurrentTerms(developer))) return "not_signed";
  return null;
}

/** The plain-words reason a NEW booking is refused for a §3c-paused developer. No contract-speak, no
 *  field names — the agent sees why, honestly. Reused by the server guard and the agent booking UI. */
export const NEW_DEAL_PAUSED_REASON =
  "This developer's listings are paused while overdue platform fees are settled. Existing deals continue; new bookings can't be opened until this clears.";

// ── BUILDING HALT GATE (Part A, the design docs) — a SECOND, finer grain ───────────────
// §3c above hides at the DEVELOPER grain (a late/misrepresenting account's WHOLE inventory). A developer HALT
// (lib/building-halt) is a BUILDING-grain pause the DEVELOPER themselves asserts (their inalienable right to
// stop selling a building — transparency not permission). The two are ORed at the read: a building
// is withheld if its developer is §3c-hidden OR the building itself is halted (active). Grain differs, so the
// building-halt check is per-building here, consulted by the buyer-catalog read alongside isDeveloperHidden.
// Like §3c, a halt is FORWARD-ONLY: it drops NEW discovery + NEW bookings; existing deals continue (H1).

/** The plain-words reason a building is withheld because its developer HALTED it. Distinct from the §3c
 *  reasons (a developer-level pause) and NOT_SIGNED — this is the developer's own deliberate pause on ONE
 *  building. The developer's specific NOTE is surfaced separately (verbatim) where the halt is explained; this
 *  is the neutral fallback copy for a buyer/agent who only needs to know the building isn't open right now. */
export const BUILDING_HALTED_REASON =
  "This development isn't accepting new bookings right now. Existing deals continue; it may reopen later.";

/** Is THIS building currently halted (an active developer halt hides it)? Building grain — pass a building id,
 *  not a developer. Fail-safe: any read error ⇒ false is NOT appropriate here (a halt is a withhold, so the
 *  safe side is to treat an error as hidden); building-halt.isBuildingHalted already returns false only when
 *  the store genuinely has no active halt, so we surface its verdict directly. */
export async function isListingHaltedBuilding(building: string): Promise<boolean> {
  return isBuildingHalted(building);
}

/** The set of building ids currently withheld by an active halt — the building-grain companion to
 *  suspendedDevelopers (which returns withheld DEVELOPERS). A catalog read ORs the two: drop a building if its
 *  developer is in suspendedDevelopers OR the building is in this set. Lower-cased ids. */
export async function haltedListingBuildings(): Promise<Set<string>> {
  return haltedBuildings();
}
