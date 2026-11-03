// SHARED PAYMENT-PLAN MATH — the ONE place the "split a balance into N instalments, last carries the
// remainder, reconcile to price" rule lives, plus the "is a terms ask inside the developer's acceptable range"
// test. Before the instalment split was duplicated in THREE places (components/PaymentCalculator,
// lib/direct-offer.directPlanFromTemplate, and the buyer's buildIndicativePlan) — each with the same floor/
// last-remainder idiom, each a separate chance to drift. Extracted here per "scan for the reusable pattern
// before building the Nth instance" (the three real consumers already existed).
//
// DEPENDENCY-LIGHT BY DESIGN: this module imports NOTHING from catalog/crypto/fs so it is safe on BOTH the
// client (PaymentCalculator is a "use client" component) and the server (direct-offer, the escalation path).
// It takes plain numbers + the acceptable-range shape; the caller resolves terms/caps and passes them in.
//
// NUMBERS (doc-alongside, the "how values are handled" rule): every amount is whole USD. The split uses
// Math.floor for the per-instalment figure and the LAST instalment absorbs the rounding remainder, so the
// schedule ALWAYS sums back to the balance exactly (no cent drifts away). A plan is `balanced` when the
// milestones + instalments reconcile to the price within $1 (the sub-dollar tolerance covers fractional cents).

/** The acceptable-range shape the desk/overlay use (mirrors query-tools.RealTerms.acceptableRanges — kept
 *  structurally inline so this stays dependency-light). Each milestone is an optional {min,max}; an absent
 *  milestone (or absent bound) means "no published bound" → the in-range test treats a missing bound as open
 *  on that side. Pct milestones are percentages; instalments is a whole count. */
export type AcceptableRanges = {
  depositPct?: { min?: number; max?: number };
  onContractPct?: { min?: number; max?: number };
  onKeyPct?: { min?: number; max?: number };
  instalments?: { min?: number; max?: number };
};

/** A milestone key a buyer can ask to change — the four the ranges cover. */
export type TermsMilestone = "depositPct" | "onContractPct" | "onKeyPct" | "instalments";

/**
 * Split a balance into N equal instalments, the LAST carrying the remainder so the schedule sums to `balance`
 * EXACTLY. PURE. `n < 1` → an empty schedule (the caller handles "no instalments"). Negative balance clamps to 0.
 * Returns the per-instalment `each`, the `lastExtra` the final one carries, and the fully-expanded `amounts`.
 */
export function splitBalanceIntoInstalments(
  balance: number,
  n: number
): { each: number; lastExtra: number; amounts: number[] } {
  const bal = Math.max(0, Math.round(balance));
  const count = Math.max(0, Math.round(n));
  if (count < 1) return { each: 0, lastExtra: 0, amounts: [] };
  const each = Math.floor(bal / count);
  const lastExtra = bal - each * count; // the remainder the last instalment absorbs
  const amounts: number[] = [];
  for (let i = 0; i < count; i++) amounts.push(i === count - 1 ? each + lastExtra : each);
  return { each, lastExtra, amounts };
}

/** Does `amounts` reconcile to `price` within $1? The shared "balanced" test (sub-dollar tolerance for
 *  fractional-cent rounding). PURE. */
export function reconciles(price: number, amounts: number[]): boolean {
  const total = amounts.reduce((s, a) => s + a, 0);
  return Math.abs(Math.round(price) - total) < 1;
}

/**
 * Is a single milestone ASK inside the developer's acceptable range? The ONE in-range test both escalation
 * entry points (the form note + the desk's chat routing) use, so "what the buyer may self-serve" vs "what must
 * go to a human" is decided in ONE place and can't drift between the two surfaces. PURE.
 *
 * Semantics: a MISSING bound is OPEN on that side (min absent ⇒ no floor; max absent ⇒ no ceiling). A milestone
 * with NO published range at all (absent from `ranges`) is treated as NOT self-serviceable → `false` (there is
 * no authority to auto-accept against, so it escalates). Comparison is inclusive of the bounds.
 */
export function isAskInRange(ranges: AcceptableRanges | undefined, milestone: TermsMilestone, value: number): boolean {
  const r = ranges?.[milestone];
  if (!r) return false; // no published range for this milestone → cannot auto-accept → escalate
  if (r.min != null && value < r.min) return false;
  if (r.max != null && value > r.max) return false;
  return true;
}

/** The out-of-range SIDE, for a human-readable escalation reason. Returns "below" / "above" / null (in range or
 *  no bound breached). PURE — so the escalation record can say "36 instalments (above the 24 maximum)". */
export function rangeBreach(
  ranges: AcceptableRanges | undefined,
  milestone: TermsMilestone,
  value: number
): { side: "below" | "above"; bound: number } | null {
  const r = ranges?.[milestone];
  if (!r) return null;
  if (r.min != null && value < r.min) return { side: "below", bound: r.min };
  if (r.max != null && value > r.max) return { side: "above", bound: r.max };
  return null;
}
