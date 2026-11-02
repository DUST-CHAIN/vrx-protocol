// VRX DEVELOPER STANDING — the late-payment → grace → suspension → wind-down routine ( §3c) — SERVER-ONLY.
// • resolveDeveloperStanding — the PURE RESOLVER (the stepping-stone, exactly how the §3b clock landed):
// obligations + `asOf` in → platform STANDING + stage dates + copy out. No IO; trivially testable.
// • resolveStandingForDeveloper — the ASSEMBLER: the one impure consumer that BUILDS a developer's
// obligations from the live stores (earmark's per-unit §3b clock verdicts + the §3c "VRX got paid" receipt
// fact, lib/vrx-receipts) and drives the pure resolver. This is the "VRX got paid" data seam of the
// enforcement arc — it turns the standing machine from a test-only computation into a store-driven one.
// WIRED (the enforcement arc is live): catalog hiding CONSUMES this module's `listingsHidden` — lib/listing-gate
// (isDeveloperHidden → suspendedDevelopers) + lib/buyer-catalog drop a suspended/removed developer from buyer
// discovery and gate new-deal admission; the stage-advancement scheduler (lib/standing-scheduler, driven
// by /api/root/misrepresentations `advance`) moves a developer grace→suspended→removed and notifies all parties
// in chat. This module COMPUTES standing (a pure resolver + a store-driven assembler); the LISTING-GATE module
// is the consumer that acts on it — kept apart on purpose (computation vs enforcement), not because enforcement
// is missing. Composes OVER lib/payment-ledger.resolveVrxClock (§3b) — it never re-derives the clock, it reads
// earmark's. (Updated: the old "it enforces nothing yet" line was stale — §3c has been enforced since the
// listing-gate arc landed.)
// A developer falls out of good standing for one of two reasons, and BOTH run the SAME staged consequence
//: don't fork the suspension machine — generalise its INPUT). The two triggers differ only in how the
// timeline is ANCHORED:
// • LATE PAYMENT (objective, machine-asserted) — a VRX protocol-fee obligation whose §3b working-day window
// has CLOSED is still unpaid. Anchor = the EARLIEST such missed obligation's due date. A machine can
// assert this (clock + receipt fact); it clears automatically when paid.
// • MISREPRESENTATION / FRAUD (a judgment call, OPERATOR-asserted) — a listing is found materially wrong and
// not corrected. There is no payment clock, so the anchor = the moment a VRX operator ASSERTED it. This is
// NEVER machine-computed: it enters the resolver only as an explicit operator-attested fact (like a
// The consequence stages are identical for both, anchored on the EARLIEST active trigger:
// good no active trigger (nothing owed / all paid / nothing flagged)
// grace within 1 WEEK of the anchor — listings still live but FLAGGED (§3c.1)
// suspended after the grace week — listings hidden / unbookable (§3c.2)
// wind_down 2 more WEEKS after suspension — existing deals + agency commissions CONTINUE; all parties (§3c.3)
// notified in chat; a last window to put it right and be reinstated
// removed after wind-down — off the platform (terminal; a real re-entry is an operator decision, off this resolver)
// CLEARING: for LATE PAYMENT, paying every overdue obligation returns standing to `good` immediately (the
// resolver reads the CURRENT set of obligations — a caller that marks one paid simply stops passing it). For
// MISREPRESENTATION, the operator clears it by stopping passing the trigger (a resolved/withdrawn assertion) —
// symmetric: the resolver always reflects the CURRENT asserted state, it holds no latch of its own.
// ── CALENDAR days here, WORKING days in the clock (deliberate, named) ────────────────────────────────────────
// The §3b FEE-DUE date is counted in WORKING days (business calendar — weekends skipped) because it's a
// settlement term. The §3c CONSEQUENCE timeline (grace/suspension/wind-down) is counted in CALENDAR days: a
// "1 week grace / 2 week wind-down" notice period is a real-world span the parties experience continuously, not
// a business-day count. Mixing the two would make the notice periods silently longer than "a week". This split
// is intentional — if a regional rule ever wants working-day notice periods, that's a named later refinement
// (the same discipline as §3b's holiday calendar), not a silent assumption.
// PRIVACY: server-only; produces a B2B standing fact (which stage + the dates), never customer payment
// amounts, never on-chain.: the copy speaks plain words (no field-names, no contract-speak, no D-refs).
// deals + agency commissions continue through EVERY stage incl. removal (VRX never unwinds a signed S&P), the
// in-chat notice to all parties, and manual re-entry after removal — must be stated UP-FRONT in the VRX↔developer
// agreement. No VRX action against a developer that wasn't disclosed to them. The agreement isn't a built signed

import type { VrxClockStatus } from "./payment-ledger";
import { settlementRollup } from "./earmark";
import { paidForUnit } from "./vrx-receipts";

/** The developer's platform standing w.r.t. VRX protocol-fee payment. Ordered good → removed by severity. */
export type DeveloperStandingStage =
  | "good" // no overdue-unpaid VRX obligation
  | "grace" // first obligation missed its due date — within the 1-week grace (listings live but flagged)
  | "suspended" // grace week elapsed — listings hidden/unbookable AND the 2-week wind-down is running (existing
  // deals + commissions continue; a last window to pay and be reinstated). §3c folds "suspension"
  // and "wind-down" into one operational state: hidden + reinstatable. They differ only in what
  // they describe (the listing state vs the deals clock), not in what the platform does.
  | "removed"; // wind-down elapsed, still unpaid — off the platform (terminal; re-entry is a manual operator call)

/** WHY a developer is out of good standing — the trigger(s) currently active. Both run the same stages
 *; this records which fired so a caller (and the disclosure-aligned notice copy) can say the right
 * thing. `none` ⇔ stage `good`. Both can be true at once (late AND misrepresenting); the timeline anchors on
 * whichever is earliest, and this reports every active reason. */
export type StandingReason = "none" | "late_payment" | "misrepresentation";

export type DeveloperStanding = {
  stage: DeveloperStandingStage;
  /** Every active trigger reason (empty ⇔ `good`). Ordered as [late_payment?, misrepresentation?]. */
  reasons: StandingReason[];
  /** How many of the developer's obligations are overdue (window closed) AND unpaid. 0 ⇒ not late. */
  overdueUnpaidCount: number;
  /** The EARLIEST active trigger anchor (ms epoch) — the consequence timeline is measured from here. For
   * late_payment it's the earliest overdue-unpaid due date; for misrepresentation it's the operator's
   * assertedAt; with both active it's whichever is earlier. Absent when standing is `good`. */
  firstMissedDueAt?: number;
  /** ms epoch the grace period ends / suspension begins (firstMissedDueAt + 1 week). Absent when `good`. */
  suspendsAt?: number;
  /** ms epoch the wind-down ends / removal begins (suspendsAt + 2 weeks). Absent when `good`. */
  removesAt?: number;
  /** Whether a buyer-facing listing read should HIDE this developer's inventory. True from `suspended` onward;
   * `grace` does NOT hide (listings stay live, just flagged). The enforcement arc reads this. */
  listingsHidden: boolean;
  /** Whether existing deals + agency commissions must still be honoured. True for every stage — §3c keeps them
   * running through grace, suspension AND wind-down; even `removed` is about NEW discoverability, not tearing
   * up signed deals (a signed S&P is a buyer↔developer contract VRX doesn't unwind). */
  existingDealsContinue: boolean;
};

/** One VRX protocol-fee obligation for a developer — one unit's clock verdict plus whether VRX has been paid
 * for it. The caller builds these from the per-unit §3b clock (resolveVrxClock) + a "VRX received payment"
 * fact (which, with the on-rail TAKE frozen, is today a manually-attested VRX-side fact — see §4b Rail B). */
export type VrxObligation = {
  /** The §3b clock verdict for this unit (as returned by resolveVrxClock). */
  clock: Pick<VrxClockStatus, "payable" | "reason" | "dueAt">;
  /** True iff VRX has actually been paid this fee. Until the on-rail TAKE exists this is an attested fact. */
  paid: boolean;
};

/** A MISREPRESENTATION / FRAUD trigger — a VRX operator's explicit assertion that a developer's listing
 * was found materially wrong and not corrected. NEVER machine-computed: "is this fraud?" is a
 * human judgment, so it enters the resolver only as this operator-attested fact, carried from a VRX-root
 * action. Its `assertedAt` anchors the SAME §3c timeline the late-payment clock anchors — one state machine,
 * two inputs. Passing no trigger (undefined) means "no misrepresentation flagged" — the operator clears it by
 * withdrawing the assertion (the resolver holds no latch; it reflects the current asserted state). */
export type MisrepresentationTrigger = {
  /** ms epoch a VRX operator asserted the misrepresentation — the §3c timeline anchor for this trigger. */
  assertedAt: number;
  /** The VRX operator account that asserted it (audit trail; never a machine/automatic source). */
  assertedBy: string;
  /** Optional building id the assertion concerns (for the notice copy / audit). Standing is developer-level
   * regardless — a misrepresentation in one building degrades the developer's platform standing. */
  buildingId?: string;
};

const DAY_MS_STANDING = 86_400_000;

/** §3c.1 — grace period length after the first missed due date, in CALENDAR days (1 week). */
export const GRACE_DAYS = 7;
/** §3c.3 — wind-down length after suspension, in CALENDAR days (2 weeks). */
export const WIND_DOWN_DAYS = 14;

/**
 * Resolve a developer's platform STANDING from their VRX obligations, an optional operator-asserted
 * misrepresentation trigger, and the clock. Pure — `asOf` is injectable for tests.
 *
 * TWO triggers, ONE timeline:
 * • late payment — an obligation counts as "late" only when its clock is `payable` (the §3b window CLOSED or
 * early-settle fired) AND it is unpaid; obligations still inside the window (accrued-but-not-due) are NOT
 * late and never degrade standing. Anchor candidate = the EARLIEST such late obligation's `dueAt`.
 * • misrepresentation — an operator-asserted fact (never machine-computed). Anchor candidate = its
 * `assertedAt`.
 * The consequence timeline anchors on the EARLIEST active candidate across both triggers, then grace/suspend/
 * remove are the same math. `reasons` reports every active trigger (both can be active at once).
 *
 * No active trigger → `good` (covers "nothing owed", "all paid", "accrued but not yet due", "nothing flagged").
 */
export function resolveDeveloperStanding(args: {
  obligations: VrxObligation[];
  /** Operator-asserted misrepresentation. Absent/undefined = none flagged. */
  misrepresentation?: MisrepresentationTrigger;
  asOf?: number;
}): DeveloperStanding {
  const asOf = args.asOf ?? Date.now();

  // "Late" = the fee is payable (window closed / early-settle) AND VRX hasn't been paid. A due date is required
  // to anchor the timeline; a payable obligation always carries one (resolveVrxClock sets dueAt whenever payable).
  const overdueDueAts = args.obligations
    .filter((o) => o.paid !== true && o.clock.payable === true && typeof o.clock.dueAt === "number")
    .map((o) => o.clock.dueAt as number);
  const isLate = overdueDueAts.length > 0;

  // Misrepresentation is active iff an operator asserted it with a valid anchor timestamp.
  const mis = args.misrepresentation;
  const isMisrep = !!mis && typeof mis.assertedAt === "number" && Number.isFinite(mis.assertedAt);

  // Gather every active trigger's anchor candidate; the timeline runs from the EARLIEST.
  const anchorCandidates: number[] = [];
  if (isLate) anchorCandidates.push(Math.min(...overdueDueAts));
  if (isMisrep) anchorCandidates.push(mis!.assertedAt);

  if (anchorCandidates.length === 0) {
    return {
      stage: "good",
      reasons: [],
      overdueUnpaidCount: 0,
      listingsHidden: false,
      existingDealsContinue: true,
    };
  }

  const reasons: StandingReason[] = [];
  if (isLate) reasons.push("late_payment");
  if (isMisrep) reasons.push("misrepresentation");

  const firstMissedDueAt = Math.min(...anchorCandidates);
  const suspendsAt = firstMissedDueAt + GRACE_DAYS * DAY_MS_STANDING;
  const removesAt = suspendsAt + WIND_DOWN_DAYS * DAY_MS_STANDING;

  // Stage from the timeline: within the grace week → grace; between suspension and removal → suspended (listings
  // hidden + the 2-week wind-down running, reinstatable); past removal → removed.
  const stage: DeveloperStandingStage =
    asOf < suspendsAt ? "grace" : asOf < removesAt ? "suspended" : "removed";

  return {
    stage,
    reasons,
    overdueUnpaidCount: overdueDueAts.length,
    firstMissedDueAt,
    suspendsAt,
    removesAt,
    // Listings hide from `suspended` onward; `grace` keeps them live (flagged, not hidden).
    listingsHidden: stage === "suspended" || stage === "removed",
    // Signed deals + agency commissions continue through every stage (§3c.3).
    existingDealsContinue: true,
  };
}

// ── The ASSEMBLER — the one impure consumer that drives the pure resolver from the real stores ──────
// The resolver above is pure (obligations in, standing out). This is the seam that BUILDS a developer's
// obligations from what's actually recorded: the §3b VRX clock (already surfaced per-unit on earmark's
// VrxLine.deals as {vrxPayable, vrxPayableReason, vrxDueAt}) + the NEW "VRX got paid" fact per unit
// (lib/vrx-receipts.paidForUnit). It never re-derives the clock — it reads the clock verdicts earmark already
// computed, pairs each with its receipt fact, and hands the obligations to resolveDeveloperStanding. This is
// what turns the standing machine from a test-only computation into a real, store-driven one. Async (it reads
// the receipt store); keep the pure resolver pure so it stays trivially testable.

/** The shape of one earmark VRX-fee deal line this reads — the clock verdict earmark already computed, keyed
 * by unit. (Structurally a subset of lib/earmark.DealLine; declared here so the mapper is testable without
 * the whole earmark rig.) */
export type VrxDealClock = {
  buildingId?: string;
  unitId?: string;
  vrxPayable?: boolean;
  vrxPayableReason?: VrxClockStatus["reason"];
  vrxDueAt?: number;
};

/**
 * PURE mapper: earmark's per-unit §3b clock verdicts + a `paid?(building,unit)` lookup → the obligations the
 * resolver reads. Deals without a known building/unit are skipped honestly (earmark resolves the clock only
 * for a known unit — and only a unit is receiptable). The clock half is read verbatim from the line (never
 * re-derived); the `paid` half comes from the §3c receipt fact. `paidLookup` is injected so this is unit-
 * testable; `resolveStandingForDeveloper` supplies the real `lib/vrx-receipts.paidForUnit`.
 */
export async function obligationsFromVrxDeals(
  developer: string,
  deals: VrxDealClock[],
  paidLookup: (developer: string, buildingId: string, unitId: string) => Promise<boolean>
): Promise<VrxObligation[]> {
  const obligations: VrxObligation[] = [];
  for (const d of deals) {
    if (!d.buildingId || !d.unitId) continue;
    const paid = await paidLookup(developer, d.buildingId, d.unitId);
    obligations.push({
      clock: { payable: d.vrxPayable === true, reason: d.vrxPayableReason ?? "no_exit", dueAt: d.vrxDueAt },
      paid,
    });
  }
  return obligations;
}

/** Resolve ONE developer's current standing from the live stores. Thin impure wrapper: reads earmark's VRX
 * line for the developer, maps it via the pure `obligationsFromVrxDeals` (with the real receipt fact), then
 * the pure resolver. `asOf` injectable for tests/determinism. A developer with no VRX fee lines (no unit has
 * left `available`) and no flagged misrepresentation resolves to `good`.
 *
 * `misrepresentation` is an OPERATOR-asserted trigger the caller supplies when VRX-root has flagged a
 * developer — it is NOT read from a store here, by design: the fraud judgment is made by a human
 * at the operator surface and passed IN, never derived. The persisted operator-assertion store + the VRX-root
 * action that writes it land with the /root console / scheduler arc; this wrapper already accepts the trigger
 * so that arc plugs in without reshaping the standing machine. */
export async function resolveStandingForDeveloper(
  developer: string,
  opts?: { asOf?: number; misrepresentation?: MisrepresentationTrigger }
): Promise<DeveloperStanding> {
  const dev = developer.trim().toLowerCase();
  const { byVrx } = await settlementRollup();
  const line = byVrx.find((v) => v.developer.trim().toLowerCase() === dev);
  const obligations = await obligationsFromVrxDeals(developer, line?.deals ?? [], paidForUnit);
  return resolveDeveloperStanding({
    obligations,
    misrepresentation: opts?.misrepresentation,
    asOf: opts?.asOf,
  });
}

/**  plain-words copy for each standing stage (B2B/developer surface; no field-names/contract-speak).
 * LATE-PAYMENT wording (the original trigger). For reason-aware copy use `standingCopy` below. */
export const developerStandingCopy: Record<DeveloperStandingStage, string> = {
  good: "In good standing — protocol fees are current.",
  grace: "Payment overdue — your listings stay live for one more week, then are paused until you pay.",
  suspended: "Listings paused — overdue protocol fees unpaid. Existing deals continue; pay now to be reinstated.",
  removed: "Removed from the platform — overdue protocol fees were not paid. Re-entry is a manual review.",
};

/** MISREPRESENTATION-trigger wording — same stages, different "why". Kept parallel to the late-payment
 * map so a caller shows the reason the developer actually faces. Still plain-words. */
export const developerMisrepCopy: Record<DeveloperStandingStage, string> = {
  good: "In good standing — your listings are accurate.",
  grace: "A listing was found to be inaccurate — your listings stay live for one more week, then are paused until it is corrected.",
  suspended: "Listings paused — a listing was found materially wrong and not corrected. Existing deals continue; correct it to be reinstated.",
  removed: "Removed from the platform — a listing was found materially wrong and not corrected. Re-entry is a manual review.",
};

/** Reason-aware standing copy. Picks the wording that matches the ACTIVE trigger(s): misrepresentation takes
 * precedence in the message when both are active (it's the more serious, operator-asserted cause), but the
 * caller still has `standing.reasons` to show both if it wants. `good` always uses the late-payment map's
 * neutral "fees current" line. Never invents a date or a field-name. */
export function standingCopy(standing: DeveloperStanding): string {
  if (standing.stage === "good") return developerStandingCopy.good;
  if (standing.reasons.includes("misrepresentation")) return developerMisrepCopy[standing.stage];
  return developerStandingCopy[standing.stage];
}
