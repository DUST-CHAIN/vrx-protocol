// AI Sales Director — the conversation PHASE resolver (the design docs §10). PURE.
//
// WHY THIS EXISTS: the permission matrix gates the ACTION tools by phase (reveal_unit at qualify+, open_unit at
// book+, record_deposit at deposit). But before the context's phase was hard-coded "browse" and never
// advanced — so the WHOLE action layer was unreachable in production (the AI could only talk about holding/
// reserving, never do it). This module is the fix: it RESOLVES the phase each turn by a HYBRID rule:
//
//   resolved = clamp( modelDeclaredPhase , floor = serverFloor , cap = serverFloor's next notch )
//
//   • serverFloor — a PROVABLE lower bound from real deal state the model cannot fake: a recorded deposit ⇒
//     at least "deposit"; a live soft-hold ⇒ at least "book"; a focused unit ⇒ at least "qualify"; else "browse".
//   • cap — the model may ADVANCE the conversation by at most ONE notch above what the deal state justifies, so
//     a model can move browse→qualify→negotiate as the talk warrants, but can NOT leap to "book"/"deposit" (and
//     thus self-unlock a hold/deposit) without the real state (a hold / a deposit) actually existing. The action
//     tools stay double-gated anyway (availability + the canOpenUnit toggle), so this is defence in depth.
//   • monotonic — never REGRESS below the stored phase (a deal doesn't go backwards within a session); the floor
//     already enforces the state-backed part, and the stored phase pins any model-advanced progress.
//
// This is the generic seam (phase resolution) the action layer reads from; the sidecar persists the resolved
// phase so next turn reads it back. No network / no model / no fs — testable with plain inputs.

import type { Phase } from "./permissions";

/** The phase ladder, lowest→highest. The matrix widens access as this climbs. "aftercare" is post-close and is
 *  never auto-resolved here (it follows a settled deal), so the live ladder the resolver walks ends at deposit. */
export const PHASE_ORDER: Phase[] = ["browse", "qualify", "negotiate", "book", "deposit", "aftercare"];

/** Rank of a phase on the ladder (−1 if unknown → treated as browse by callers). */
export function phaseRank(p: Phase): number {
  const i = PHASE_ORDER.indexOf(p);
  return i < 0 ? 0 : i;
}

/** The real, model-independent deal signals the server floor is computed from. All optional — absent ⇒ the deal
 *  hasn't reached that state. Derived by the caller from the stores it already reads (sidecar + holds + deposit). */
export type DealState = {
  /** A reservation deposit has been recorded for this deal. ⇒ floor "deposit". */
  depositRecorded?: boolean;
  /** A live (un-released) soft-hold exists for this deal. ⇒ floor "book". */
  heldUnit?: boolean;
  /** The deal has centred on a specific unit (focusUnitId set, or a unit was revealed/looked at). ⇒ floor "qualify". */
  focusedUnit?: boolean;
};

/** The PROVABLE lower bound from real deal state — the model can never pull the phase below this. */
export function serverFloor(state: DealState): Phase {
  if (state.depositRecorded) return "deposit";
  if (state.heldUnit) return "book";
  if (state.focusedUnit) return "qualify";
  return "browse";
}

/** Coerce an untrusted model-supplied phase string to a valid Phase, or undefined if it isn't one. "aftercare"
 *  is accepted as a value but the cap below prevents the model jumping to it without a settled deal. */
export function coercePhase(v: unknown): Phase | undefined {
  return typeof v === "string" && (PHASE_ORDER as string[]).includes(v) ? (v as Phase) : undefined;
}

/**
 * Resolve the phase for THIS turn (the hybrid rule). Pure.
 *   base    = max(floor, storedPhase)                  — monotonic: never regress below where we already were
 *   ceiling = min(base+1, max(floor, "negotiate"))     — the model may step ONE notch above base, but NEVER into
 *             book/deposit unless the real floor (a hold / deposit) proves it. So without real state the model
 *             can walk browse→qualify→negotiate (one notch per turn) but is BLOCKED at negotiate (can't self-
 *             unlock a hold); a live hold raises floor→book so book (and +1 deposit) open.
 *   result  = clamp(modelPhase ?? base, base, ceiling) — the model may nudge forward, bounded both ends.
 *
 * So: with NO real state and NO model phase the result is "browse" (unchanged — production is untouched until the
 * AI starts declaring phases). The model declaring "qualify" unlocks reveal_unit (qualify+), the goal; it can
 * never jump to a hold/deposit without the deal state actually being there.
 */
export function resolvePhase(opts: {
  storedPhase?: Phase;
  modelPhase?: Phase;
  state: DealState;
}): Phase {
  const floorRank = phaseRank(serverFloor(opts.state));
  const negotiateRank = phaseRank("negotiate");
  const depositRank = phaseRank("deposit"); // the top auto-advanceable phase (aftercare is a separate transition)

  // Monotonic base: never regress below the stored phase (but the floor can RAISE it if state advanced).
  const storedRank = opts.storedPhase ? phaseRank(opts.storedPhase) : 0;
  const baseRank = Math.max(floorRank, storedRank);

  // How high the MODEL may climb: to "negotiate" freely (talk-only phases), OR one notch above the PROVEN floor
  // (so a real hold ⇒ the model may reach book→deposit, but without a hold the model is blocked at negotiate and
  // can NEVER self-unlock book/deposit). Clamped to the deposit end — a close to aftercare isn't an auto-advance.
  const floorCap = Math.min(Math.max(floorRank + 1, negotiateRank), depositRank);
  // The ceiling this turn: one notch above base, bounded by what the model may reach.
  const ceilingRank = Math.min(baseRank + 1, floorCap);

  // The model's wish, clamped to [baseRank, ceilingRank]. Absent ⇒ stay at base.
  const wishRank = opts.modelPhase ? phaseRank(opts.modelPhase) : baseRank;
  const resolvedRank = Math.max(baseRank, Math.min(wishRank, ceilingRank));
  return PHASE_ORDER[resolvedRank];
}
