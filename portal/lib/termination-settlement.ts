// TERMINATION SETTLEMENT — PURE, SERVER-ONLY, no I/O, no money moved. Slice 5 of the cancellation arc.
// WHAT THIS IS: given a TERMINAL termination state + the deal's real money facts (monies paid to date, price,
// the dated schedule) + the resolved clause terms, it computes WHICH figure settles where — retained to the
// Seller (buyer default) or refunded to the Buyer (seller default) — plus an ADVISORY interest figure the
// Seller MAY claim on arrears. It is a DERIVATION, exactly like lib/payment-ledger's variance: computed on
// READ from the live ledger, never persisted and never folded into the sealed step trail (so the trail keeps
// its opacity — no price plaintext; the AMOUNT is always the ledger/vault's job, the trail only records
// that a lawful step happened). No money is moved here; VRX records, the vault holds, there is no transfer.
// WHY PURE + DERIVED (not stored): same discipline as payment-ledger (variance pure) and termination (the
// machine pure). The one place that answers "on this termination, what settles?" is fully unit-tested and
// deterministic — same ledger + same clause terms + same timestamps → the same figures, every time. There is
// settlement by typing a number; the figures come from the sealed plan + the recorded payments + the clause
// rate + the real elapsed time. The developer's only CHOICE is whether to CLAIM the advisory interest line —
// and that choice, when made, is itself a recorded/sealed step, so folding interest into an invoice
// is auditable, never a silent edit.
// MAPS TO THE CLAUSE (sale-contract.ts §Default and Termination, slice 4) + its real SPA:
// • terminated_retained (buyer default, Cl.14): the Seller retains ALL monies the Buyer paid, and MAY claim
// interest at the clause rate on OVERDUE amounts for the time they were overdue. Retained = paidToDate;
// refunded = 0; interest = advisory/claimable (NOT auto-added to retained — the clause says "may charge",
// decide whether to fold it into the invoice; compute it so it can't be abused.
// • terminated_refunded (seller default, Cl.5.5): the Seller REFUNDS all monies the Buyer paid. Refunded =
// • any NON-terminal state (none / *_default_served): there is nothing to settle yet (a cure clock may still
// run) → returns null. Honest: no settlement figure exists until the deal actually terminates.

import type { TerminationState } from "./termination";
import type { ExpectedLine } from "./payment-ledger";
import type { TerminationTerms } from "./termination-terms";

const DAY_MS = 86_400_000;

/** The advisory interest line the Seller MAY claim on a buyer-default termination. Never auto-added to the
 * retained total — a separate, clearly-claimable figure. */
export type TerminationInterest = {
  /** The clause rate used (interestPctPerAnnum from the resolved terms) — stated so the figure is explainable. */
  ratePctPerAnnum: number;
  /** The computed indicative interest on overdue amounts, in USD. 0 when nothing was datedly overdue (we never
   * invent arrears from an undated plan — the anti-abuse rule: no dated-overdue line → no interest). */
  amountUsd: number;
  /** TRUE when the figure is a non-zero amount the Seller may claim; FALSE when 0 (nothing overdue). Lets a UI
   * show the line only when it means something. */
  claimable: boolean;
};

/** The settlement outcome of a TERMINAL termination. One of retained/refunded is the monies-paid figure; the
 * other is 0. Interest is present only on a buyer-default (retained) outcome, always advisory. */
export type TerminationSettlement = {
  /** Which terminal outcome this settles. */
  outcome: "terminated_retained" | "terminated_refunded";
  /** Monies the Seller RETAINS (buyer default) — the sum the Buyer paid; 0 on a refund outcome. */
  retainedUsd: number;
  /** Monies REFUNDED to the Buyer (seller default) — the sum the Buyer paid; 0 on a retained outcome. */
  refundedUsd: number;
  /** The advisory interest the Seller MAY claim (buyer default only; null on a refund — Cl.5.5 adds nothing). */
  interest: TerminationInterest | null;
  /** The monies-paid figure the settlement is built on (= retainedUsd or refundedUsd) — surfaced once for a UI. */
  paidToDateUsd: number;
};

/**
 * Compute the indicative arrears interest the Seller MAY claim on a buyer default (Cl.5.4, 15% p.a. in the real
 * SPA). ANTI-ABUSE: interest accrues ONLY on dated schedule lines that are genuinely overdue, ONLY
 * for the days they were actually overdue as of `asOf`, at the clause rate — never a flat "rate × everything",
 * never on an undated plan (we don't invent arrears). The developer cannot inflate it: the overdue lines, their
 * amounts, and the elapsed days all come from the sealed plan + the real clock, not an operator input.
 *
 * simple interest per line = dueUsd × (ratePct/100) × (daysOverdue / 365).
 */
function arrearsInterest(
  schedule: ExpectedLine[],
  paidToDateUsd: number,
  ratePctPerAnnum: number,
  asOf: number
): number {
  if (ratePctPerAnnum <= 0 || paidToDateUsd < 0) return 0;
  // Walk the schedule in order; a line is "covered" by payments to date (FIFO), only the UNCOVERED portion of a
  // dated, past-due line is in arrears. This mirrors payment-ledger's cumulative-due walk so the two agree on
  // what is actually unpaid — no double counting, no interest on money already paid.
  let remainingPaid = paidToDateUsd;
  let interest = 0;
  for (const line of schedule) {
    const covered = Math.min(remainingPaid, line.dueUsd);
    remainingPaid -= covered;
    const unpaid = line.dueUsd - covered;
    if (unpaid <= 0) continue; // fully paid — no arrears on this line
    if (line.dueAt === undefined || line.dueAt >= asOf) continue; // undated or not yet due — never "late"
    const daysOverdue = Math.floor((asOf - line.dueAt) / DAY_MS);
    if (daysOverdue <= 0) continue;
    interest += unpaid * (ratePctPerAnnum / 100) * (daysOverdue / 365);
  }
  // Whole cents: settlement figures are money, not raw floats. Round to 2 dp.
  return Math.round(interest * 100) / 100;
}

/**
 * Compute the settlement for a termination state. Returns null for any non-terminal state (nothing settles
 * while a deal is live or a cure clock runs). PURE: no I/O, no money moved — it classifies and arithmetics.
 *
 * - terminated_retained → Seller retains monies paid; interest advisory (date-derived, capped, claimable).
 * - terminated_refunded → Buyer refunded monies paid; no interest, no added compensation.
 */
export function computeSettlement(opts: {
  state: TerminationState;
  paidToDateUsd: number;
  terms: TerminationTerms;
  /** The dated expected schedule (from payment-ledger) — drives the arrears-interest figure. Empty/undated →
   * no interest (honest: no dated arrears to charge on). */
  schedule?: ExpectedLine[];
  /** ms epoch to compute "as of" (injectable so tests + a real clock agree). Defaults to Date.now. */
  at?: number;
}): TerminationSettlement | null {
  const paid = opts.paidToDateUsd > 0 ? opts.paidToDateUsd : 0;
  const asOf = opts.at ?? Date.now();

  if (opts.state === "terminated_retained") {
    const amt = arrearsInterest(opts.schedule ?? [], paid, opts.terms.interestPctPerAnnum, asOf);
    return {
      outcome: "terminated_retained",
      retainedUsd: paid,
      refundedUsd: 0,
      interest: { ratePctPerAnnum: opts.terms.interestPctPerAnnum, amountUsd: amt, claimable: amt > 0 },
      paidToDateUsd: paid,
    };
  }

  if (opts.state === "terminated_refunded") {
    return {
      outcome: "terminated_refunded",
      retainedUsd: 0,
      refundedUsd: paid,
      interest: null, // Cl.5.5 is a plain refund — nothing added.
      paidToDateUsd: paid,
    };
  }

  // none / buyer_default_served / seller_default_served / cured — nothing settles yet.
  return null;
}
