// TERMINATION / CANCELLATION STATE MACHINE — PURE, SERVER-ONLY, no I/O, no clause copy, no UI.
//
// THE ARC (the "no fraud, no holes" north star): a LIVE/SIGNED reservation can return to the developer
// and be re-sold, but ONLY through the contract's lawful default process — never a silent off-chain freeze.
//  built the block/kill half of removal and explicitly logged THIS as the unbuilt follow-on: the
// recorded default -> notice -> cure -> terminate sequence for a signed unit. This module is the pure spine
// of that sequence. (scope: state machine + sealed step records FIRST; the S&P clause wording and
// any UI/route are deliberately LATER slices — the binding clause copy is owed from /legal, so this
// module commits to NO legal prose.)
//
// WHAT THE REAL SPA SAYS (read-only from drt/pdf/TEMPLATES/CONTRACT.html — the clauses this machine will
// one day enforce the STEPS of; it does NOT reproduce their wording):
//   • Cl.14 (buyer default): Purchaser fails to pay amounts totalling >= 12.5% of the price, OR breaches any
//     provision, AND fails to rectify within the time stated in the Seller's DEFAULT NOTICE -> Seller MAY
//     terminate, RETAIN all monies paid, claim interest/compensation, and re-sell. Purchaser waives claims.
//   • Cl.5.4 (missed instalment): a missed instalment / refused transfer IS a default -> 15% p.a. interest +
//     retained right to terminate. (The variance engine, lib/payment-ledger, already DETECTS this: a
//     `variance:"behind"` with `lateByDays`, or `pctOfPrice` short of the clause threshold.)
//   • Cl.5.5 (seller default, the REVERSE): if the SELLER cannot obtain the construction licence (EIA) ->
//     Seller REFUNDS all payments to the Purchaser. Termination cuts both ways; each side its own remedy.
//
// WHY PURE: same discipline as lib/payment-ledger (variance is pure; the store/route/UI are separate). The
// machine decides WHICH transitions are legal and stamps a tamper-evident SEAL per step; a thin store layer
// (status-ledger pattern: append-only, serialized `mutate`) and the surface land in later slices. Keeping the
// law pure means the one place that defines "is this a lawful step?" is fully unit-tested before anything
// calls it. NO monies are moved here and NO clause text is authored — this module records that a step was
// taken, lawfully, with its evidence sealed; the money arithmetic (retain vs refund amounts) is the
// payment-ledger/vault's job and is referenced, not duplicated.

import { sealRecord, type Seal } from "./seal";

/** The seal domain tag for termination step records (public namespace; the secret is the per-record salt). */
export const TERMINATION_SEAL_DOMAIN = "vrx-termination-step";

// ── States ────────────────────────────────────────────────────────────────────────────────────────────────
//
// A deal is in exactly ONE termination state. `none` is the home state (no default in progress). The machine
// is a small DAG, not a free-for-all: you can only reach `terminated*` THROUGH a served notice and an elapsed
// cure window — that is the whole anti-fraud point (no skipping the process).
export type TerminationState =
  /** No default process in progress — the normal live/signed deal. The home state. */
  | "none"
  /** A BUYER default notice has been served (Cl.14/5.4). The cure clock is running. */
  | "buyer_default_served"
  /** A SELLER default notice has been served (Cl.5.5, the reverse — e.g. EIA licence cannot be obtained). */
  | "seller_default_served"
  /** The defaulting party RECTIFIED within the cure window, so the deal resumes as LIVE. Note the overlay
   *  state is set to `cured` (not back to `none`) and `cured` is terminal to THIS machine — `isTerminal`
   *  returns true, so no further termination step is legal from it. Status consumers must therefore treat
   *  `cured` as live explicitly (see `classifyDealStatus` in the income bucketer, which maps `cured`→live
   *  precisely because `isTerminal` is true here) rather than lumping it with the real closed states. */
  | "cured"
  /** Buyer default uncured -> terminated. Monies are RETAINED per the clause (amount is the ledger's figure). */
  | "terminated_retained"
  /** Seller default -> terminated. Monies are REFUNDED to the buyer per the clause. */
  | "terminated_refunded";

/** Terminal states for the TERMINATION MACHINE — no further termination step is legal from here. Note this
 *  is NOT the same as "the deal is dead": `terminated_*` do close the deal, but `cured` is a resumed-LIVE deal
 *  (see the `cured` doc above) — it's terminal only in that the default process is over. Callers that mean
 *  "is the deal closed/dead?" must NOT reuse this; classify `cured` as live (`classifyDealStatus`). */
export function isTerminal(s: TerminationState): boolean {
  return s === "terminated_retained" || s === "terminated_refunded" || s === "cured";
}

// ── Steps (the verbs that move the state) ────────────────────────────────────────────────────────────────
//
// Each step is an operator/party ACTION that the machine validates against the current state. A step is only
// legal from the right state (the guard); an illegal step throws and nothing is recorded — the store layer
// catches the throw so a bad attempt never reaches disk (same contract as channels.mutate's append-only guard).
export type TerminationStep =
  /** Serve a buyer default notice. Legal only from `none`. Starts the cure clock. */
  | "serve_buyer_default"
  /** Serve a seller default notice (EIA). Legal only from `none`. Starts the cure clock. */
  | "serve_seller_default"
  /** Record that the defaulting party rectified within the window. Legal only from a *_default_served state. */
  | "record_cure"
  /** Terminate after an UNCURED buyer default. Legal only from `buyer_default_served` AND once the cure
   *  window has elapsed (the machine enforces BOTH — a notice served and the clock run out). */
  | "terminate_buyer_default"
  /** Terminate a seller default (refund). Legal only from `seller_default_served` once the window elapsed. */
  | "terminate_seller_default";

// ── The record of one lawful step ────────────────────────────────────────────────────────────────────────
//
// Append-only, sealed. This is what the (later) store persists — one row per step, forming the auditable
// default-process trail requires ("the system's job = enforce that the steps were followed + hold the
// tamper-proof record"). PRIVACY: holds only the deal ref + step + timestamps + who + an optional free
// reason NOTE (the note is often the story) + the sealed figure REFERENCE. No PII, no price plaintext.
export type TerminationStepRecord = {
  /** The deal this step belongs to — the offer/booking requestId (join key, same as offers/channels). */
  requestId: string;
  /** The verb taken. */
  step: TerminationStep;
  /** The state BEFORE the step (for an unambiguous replayable trail). */
  from: TerminationState;
  /** The state AFTER the step. */
  to: TerminationState;
  /** ms epoch the step was taken. */
  at: number;
  /** The account that took the step (operator/developer for notices+terminate; system for an auto-advance). */
  by: string;
  /** — the free-text reason/remark. Often THE story the structured fields miss. Optional. */
  note?: string;
  /** For a SERVE step: the ms epoch the cure window ENDS. Null for cure/terminate steps (no new clock). The
   *  window length is a CLAUSE PARAMETER supplied by the caller — this module never invents a number of days
   *  (the clause copy + its stated cure period are owed from legal; the machine only arithmetic's the deadline). */
  cureEndsAt?: number;
  /** Tamper-evident seal over the step's own facts (requestId|step|from|to|at|by|note|cureEndsAt). Lets any
 * holder prove the recorded step is unaltered (lib/seal ✓ Vetted), like every other attested record. */
  seal: Seal;
};

/** The deal-level termination overlay the store/offer carries — current state + the last step's deadline, so
 *  a reader knows "is a cure clock running, and until when?" without replaying the whole trail. Off-seal, like
 *  the offer's `unlock`/`confirmed`/`contract` overlays (offers.ts) — this is the `termination` overlay the
 *  stage-machine note at offers.ts already anticipated ("an undo is an explicit void in the cancellation arc"). */
export type TerminationOverlay = {
  state: TerminationState;
  /** The running cure window's end (present only while a *_default_served state is active). */
  cureEndsAt?: number;
  /** ms epoch of the most recent step (freshness / ordering). */
  updatedAt: number;
};

// ── The transition table (the LAW — the single source of "which step is legal from which state") ───────────
//
// Keyed by step; each entry says the legal `from` state and the resulting `to`. A step attempted from any
// other state is unlawful. `terminate_*` additionally require the cure window to have elapsed (checked in
// `advance`, since it needs the clock, not just the state).
const TABLE: Record<TerminationStep, { from: TerminationState; to: TerminationState }> = {
  serve_buyer_default: { from: "none", to: "buyer_default_served" },
  serve_seller_default: { from: "none", to: "seller_default_served" },
  // record_cure is legal from EITHER served state; handled specially in `advance` (two legal `from`s).
  record_cure: { from: "buyer_default_served", to: "cured" },
  terminate_buyer_default: { from: "buyer_default_served", to: "terminated_retained" },
  terminate_seller_default: { from: "seller_default_served", to: "terminated_refunded" },
};

/** Thrown when a step is not lawful from the current state (or its cure clock has not elapsed). The store
 * layer catches this so a bad attempt never persists — the process cannot be skipped. */
export class TerminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminationError";
  }
}

/** The inputs a caller supplies to take a step. */
export type AdvanceInput = {
  step: TerminationStep;
  by: string;
  /** ms epoch the step is taken (injectable so tests + a real clock agree). Defaults to Date.now. */
  at?: number;
  note?: string;
  /** For a SERVE step ONLY: how long the cure window lasts, in ms. The CLAUSE PARAMETER — the machine refuses
   *  to serve a default without one (a default notice with no stated cure period is not a lawful notice). */
  cureWindowMs?: number;
};

/**
 * Attempt ONE lawful step from `current`. Returns the new overlay + the sealed step record to append, or
 * throws TerminationError if the step is unlawful. PURE: no I/O, no money moved, no clause copy — it decides
 * legality, computes the cure deadline from the supplied parameter, and seals the step's own facts.
 *
 * The guards, in order:
 *   1. The current state must not be terminal (a closed deal takes no more steps).
 *   2. The step must be legal from the current state (the TABLE; record_cure allows either served state).
 *   3. A SERVE step requires a positive `cureWindowMs` (a notice with no cure period is not a lawful notice).
 *   4. A TERMINATE step requires the cure window to have ELAPSED (`at >= cureEndsAt`) — the anti-fraud core:
 *      you cannot terminate before the cure clock you yourself started has run out.
 */
export function advance(
  overlay: TerminationOverlay,
  input: AdvanceInput
): { overlay: TerminationOverlay; record: TerminationStepRecord } {
  const at = input.at ?? Date.now();
  const from = overlay.state;

  // Guard 1 — terminal is closed.
  if (isTerminal(from)) {
    throw new TerminationError(`cannot take step "${input.step}" from terminal state "${from}"`);
  }

  // Guard 2 — legal step for this state.
  let to: TerminationState;
  if (input.step === "record_cure") {
    // A cure is legal from EITHER served state (buyer or seller rectified within the window).
    if (from !== "buyer_default_served" && from !== "seller_default_served") {
      throw new TerminationError(`cannot record a cure from "${from}" — no default notice is in progress`);
    }
    to = "cured";
  } else {
    const entry = TABLE[input.step];
    if (!entry || entry.from !== from) {
      throw new TerminationError(`step "${input.step}" is not lawful from state "${from}"`);
    }
    to = entry.to;
  }

  // Guard 3 — a SERVE step must carry a cure window (clause parameter); compute the deadline.
  const isServe = input.step === "serve_buyer_default" || input.step === "serve_seller_default";
  let cureEndsAt: number | undefined;
  if (isServe) {
    if (!input.cureWindowMs || input.cureWindowMs <= 0) {
      throw new TerminationError(`serving a default notice requires a positive cure window (clause parameter)`);
    }
    cureEndsAt = at + input.cureWindowMs;
  }

  // Guard 4 — a TERMINATE step requires the running cure window to have elapsed.
  const isTerminate =
    input.step === "terminate_buyer_default" || input.step === "terminate_seller_default";
  if (isTerminate) {
    if (overlay.cureEndsAt === undefined) {
      // Should be unreachable given guard 2 (terminate only from a *_served state, which always set a window),
      // but fail closed rather than silently allow an un-clocked termination.
      throw new TerminationError(`cannot terminate — no cure window is recorded for "${from}"`);
    }
    if (at < overlay.cureEndsAt) {
      throw new TerminationError(
        `cannot terminate before the cure window elapses (ends ${overlay.cureEndsAt}, now ${at})`
      );
    }
  }

  const nextOverlay: TerminationOverlay = {
    state: to,
    // A new window only on a serve; cleared once we cure/terminate (no clock in a terminal/none state).
    cureEndsAt: isServe ? cureEndsAt : undefined,
    updatedAt: at,
  };

  // Seal the step's own facts. requestId is folded in by the store (recordStep) which owns the deal ref;
  // the pure machine seals everything it knows so the store only has to add the join key + persist.
  const facts = { step: input.step, from, to, at, by: input.by, note: input.note ?? "", cureEndsAt: cureEndsAt ?? null };
  const seal = sealRecord(facts, TERMINATION_SEAL_DOMAIN);

  const record: TerminationStepRecord = {
    requestId: "", // the store stamps the real requestId (it owns the deal binding); see recordStep.
    step: input.step,
    from,
    to,
    at,
    by: input.by,
    note: input.note,
    cureEndsAt,
    seal,
  };

  return { overlay: nextOverlay, record };
}

/** The home overlay for a deal with no default process in progress. */
export function initialOverlay(at: number = Date.now()): TerminationOverlay {
  return { state: "none", updatedAt: at };
}

/** Is a buyer default ELIGIBLE to be served, given the payment-ledger's variance verdict? This is the bridge
 *  to lib/payment-ledger: a buyer default (Cl.14/5.4) exists when the buyer is behind on a dated obligation
 *  (`lateByDays` present) OR has paid less than the clause threshold of the price. PURE and advisory — it
 * tells a caller a default MAY be served; serving is still an explicit operator step (never automatic —:
 *  the process must be followed, with a served notice, not an auto-terminate). `thresholdPct` is the clause
 *  parameter (the real SPA uses 12.5%); the caller supplies it, this module hard-codes no legal number. */
export function buyerDefaultEligible(opts: {
  lateByDays?: number;
  paidToDateUsd: number;
  priceUsd: number;
  thresholdPct: number;
}): boolean {
  if (opts.lateByDays !== undefined && opts.lateByDays > 0) return true;
  if (opts.priceUsd <= 0) return false;
  const paidPct = (opts.paidToDateUsd / opts.priceUsd) * 100;
  return paidPct < opts.thresholdPct;
}
