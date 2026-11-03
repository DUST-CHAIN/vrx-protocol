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

/** The free (not-floor-backed) ceiling the model may climb to: "book" when the desk permits autonomous holds
 *, else "negotiate" (the safe default — the AI talks but can't self-unlock a hold). */
function allowAutoBookCap(allowAutoBook: boolean | undefined, negotiateRank: number, bookRank: number): number {
  return allowAutoBook ? bookRank : negotiateRank;
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
  /**  (D-): this desk is configured to let the AI place a FIRST firm-hold itself (cfg.canOpenUnit). When
   *  true the model may climb to "book" from negotiate — so it can actually reserve a unit a ready buyer asked
   *  for, instead of being stuck at "I can't place the hold" (the catch-22: open_unit needs book, book needed an
   *  existing hold). STILL double-gated at fire time (availability + canOpenUnit in open_unit), so this only
   *  UNLOCKS the attempt; it can't hold an unavailable unit or when the desk has autonomous holds off.
   *
 * BOOK FAST-PATH (D- live-demo finding): when allowAutoBook is on AND a unit is already in focus
   *  (state.focusedUnit — revealed/looked at), the one-notch-per-turn throttle is lifted so the model may reach
 * `book` DIRECTLY instead of being dragged through "negotiate" for 2–3 extra turns (: "why negotiate
   *  before the buyer has booked?"). A focused unit + an autonomous-hold desk = the buyer is genuinely at the
   *  booking step; the model must still DECLARE book (intent stays required), and deposit is unaffected. */
  allowAutoBook?: boolean;
}): Phase {
  const floorRank = phaseRank(serverFloor(opts.state));
  const negotiateRank = phaseRank("negotiate");
  const bookRank = phaseRank("book");
  const depositRank = phaseRank("deposit"); // the top auto-advanceable phase (aftercare is a separate transition)

  // Monotonic base: never regress below the stored phase (but the floor can RAISE it if state advanced).
  const storedRank = opts.storedPhase ? phaseRank(opts.storedPhase) : 0;
  const baseRank = Math.max(floorRank, storedRank);

  // How high the MODEL may climb: to "negotiate" freely (talk-only phases), OR one notch above the PROVEN floor
  // (so a real hold ⇒ the model may reach book→deposit). when the desk allows autonomous holds
  // (allowAutoBook), lift the free cap to "book" so the AI can place a FIRST hold for a ready buyer (deposit still
  // needs a real recorded deposit — allowAutoBook only reaches book, never deposit). Clamped to the deposit end.
  const freeCap = allowAutoBookCap(opts.allowAutoBook, negotiateRank, bookRank);
  const floorCap = Math.min(Math.max(floorRank + 1, freeCap), depositRank);
  // The ceiling this turn: normally one notch above base (a measured climb browse→qualify→negotiate). BUT when the
  // desk allows autonomous holds AND a unit is already in focus (revealed / looked at), a ready buyer is genuinely
  // AT the booking step — the one-notch throttle would force 2–3 extra round-trips ("negotiate" the buyer never
  // asked for) before the hold can land (live-demo finding, D-: "why negotiate before booking?"). So
  // that case let the model reach `book` directly (floorCap, which allowAutoBook already caps at book). The model
  // must still DECLARE book (intent stays in the loop) and open_unit is still double-gated (availability +
  // canOpenUnit); deposit is unaffected (floorCap never exceeds book without a real recorded-deposit floor).
  const bookFastPath = !!opts.allowAutoBook && !!opts.state.focusedUnit;
  const ceilingRank = Math.min(bookFastPath ? floorCap : baseRank + 1, floorCap);

  // The model's wish, clamped to [baseRank, ceilingRank]. Absent ⇒ stay at base.
  const wishRank = opts.modelPhase ? phaseRank(opts.modelPhase) : baseRank;
  const resolvedRank = Math.max(baseRank, Math.min(wishRank, ceilingRank));
  return PHASE_ORDER[resolvedRank];
}
