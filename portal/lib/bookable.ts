// BOOKABLE GATE — the fail-closed release rule (of the vetting/release lifecycle).
//
// THE INVARIANT: a unit may be booked ONLY once its developer has gone on contract AND the
// unit is stamped OPEN. Everything else — not stamped yet (-1), held/closed/done, or a building that hasn't
// gone on contract — is NOT bookable. Fail-closed: any unknown / missing state → NOT bookable.
//
// WHY DERIVED, NOT A NEW STORE: "released / on contract" is already modeled by the sale baseline —
// `goOnContract` writes it at the developer's deliberate sign-off (lib/sale-baseline). "Open" is already
// modeled by the on-chain tile status mirrored in the snapshot. So this is a PURE DERIVED gate over two
// existing facts, no new on-chain state, no contract change. When the V7 cut lands the on-chain vetting flag
// (Option B), only the "released" READ below swaps to prefer the chain — this function stays the single
// chokepoint and everything that calls it is unchanged.
//
// PRIVACY: reads neutral developer accounts + opaque building/unit ids + a status code. No PII, no terms.
//
// WHERE IT'S WIRED (both — because offers/route.ts runs POST-chain and can't un-book):
//  • agent/page.tsx submit — the PRE-SUBMIT guard: refuse BEFORE open_claim is sent (real enforcement
//     today, beside the listingsPaused / freehold-quota re-checks).
//   • app/api/offers/route.ts  — the RECORD BELT: the server refuses to ATTEST an offer for a unit it does
//     not consider bookable (never seal a booking we'd have refused).
// Both are the honest Option-A enforcement until the V7 contract's own NO_GATE makes the chain refuse.

import { getBaseline } from "./sale-baseline";
import { getBuildingSnapshot } from "./status-store";
import { isHeldPendingApproval } from "./inventory-version";

/** Status code a bookable (open/available) unit must carry in the snapshot. (0 open · 1 hold · 2 closed ·
 *  3 done · -1 not stamped — see lib/status-store.) */
export const STATUS_OPEN = 0;

/** Why a unit is not bookable — a stable, plain-language reason code the UI/route can surface. */
export type NotBookableReason =
  | "pre_contract" // the building hasn't gone on contract (no baseline) → not released yet
  | "not_open" // the unit isn't stamped open (not stamped -1, or held/closed/done)
  | "held_pending_approval"; // a version-gated change over this unit is awaiting VRX approval

// ── The agent-facing MESSAGE vs the reason CODE ──────────────────────────────────────────────
// The reason CODE is specific (the developer's own UI colors a `held_pending_approval` unit distinctly, so
// "those who know, know"). The MESSAGE a booking AGENT sees is NEUTRAL — a competing sales party must never
// learn that a price move / VRX review is in flight on a specific unit (the privacy moat). So a held
// unit reads to the agent exactly like any other temporarily-unavailable unit; only the code differs.

export type BookableResult =
  | { ok: true }
  | { ok: false; reason: NotBookableReason; message: string };

const MESSAGES: Record<NotBookableReason, string> = {
  pre_contract: "This building isn’t released for booking yet.",
  not_open: "This unit isn’t available for booking.",
  // Deliberately the SAME neutral wording as not_open — the agent must not learn a change is in review.
  held_pending_approval: "This unit isn’t available for booking.",
};

/**
 * The full result: bookable, or the plain reason why not. Fail-closed — a missing baseline, a missing
 * snapshot, or any status other than OPEN all refuse. Pure read (no chain call; snapshot is the mirror).
 *
 * "Released / on contract" = a sale baseline exists for (developer, building) — `goOnContract` wrote it.
 * "Open" = the unit's snapshot status is exactly STATUS_OPEN (0).
 */
export async function bookableResult(
  developer: string,
  building: string,
  unit: string
): Promise<BookableResult> {
  const baseline = await getBaseline(developer, building);
  if (!baseline) return { ok: false, reason: "pre_contract", message: MESSAGES.pre_contract };

  const snap = await getBuildingSnapshot(building);
  const status = snap?.units?.[unit];
  if (status !== STATUS_OPEN) return { ok: false, reason: "not_open", message: MESSAGES.not_open };

  //  pending-approval HOLD: an otherwise-open unit is NOT bookable while a version-gated change over it is
  // awaiting VRX approval. Derived from the inventory-version store (no stored per-unit flag) — the hold lifts
  // the instant the version is approved (change lands) or rejected (write never happened; old figures stand).
  if (await isHeldPendingApproval(building, unit)) {
    return { ok: false, reason: "held_pending_approval", message: MESSAGES.held_pending_approval };
  }

  return { ok: true };
}

/**
 * The boolean chokepoint most callers want: is this (developer, building, unit) bookable RIGHT NOW?
 * on-contract AND stamped open. Fail-closed on anything else. Pure.
 */
export async function isBookable(developer: string, building: string, unit: string): Promise<boolean> {
  return (await bookableResult(developer, building, unit)).ok;
}
