// VRX PAYMENT LEDGER — the AGENCY-commission UNLOCK GATE — SERVER-ONLY, PURE.
// Design: the design docs §3. This is the FIRST piece of the payment-ledger arc: the pure
// computation that graduates an agency's commission from `earned` → `payable`. It deliberately takes its
// inputs (is-the-S&P-signed? how-much-has-the-customer-paid?) as PARAMETERS — it does NOT yet read a
// payment store, because the payment-vault + variance engine (§4/§5 of the design, later passes) don't
// exist. When they land they feed this gate real numbers; nothing here changes. One gate, fed later.
//
// ── The two-condition AGENCY unlock (distinct from the VRX 14-working-day clock, §3b) ─────────
// An agency's commission becomes PAYABLE only when BOTH hold:
//   (1) a signed S&P exists for the deal          (unlockOnSigning — default-on for the agency), AND
//   (2) paidToDate >= price × unlockPct%          (the developer-set threshold on the agency agreement).
// Until both hold it is EARNED-but-not-payable. VRX's OWN commission uses a different unlock (the working-
// day clock, §3b) — NOT this gate. This module is the AGENCY side only.
//
// ── Legacy default (§3, §9) ──────────────────────────────────────────────────────────────────────────
// An agreement sealed before has no `unlockPct` on its building clause. the chosen fallback is
// `unlockPct = the plan's deposit%` — i.e. the %-leg is met once the customer's deposit is in. So an old
// agreement never silently BLOCKS a payable commission, and never silently PAYS one before any money arrived.
// `unlockOnSigning` absent → treated as true (signing required) — the safe default.
//
// PRIVACY: server-only; produces B2B facts (payable yes/no + the threshold), never the customer's raw
// payment amounts to any agency surface, NEVER on a buyer's S&P, nothing on-chain.

import type { AgreementBuilding } from "./agreements";
import type { SaleCommission } from "./commission";
import type { SalePlan } from "./sale-contract";
import { instalmentDueDate } from "./sale-contract";

/** The payment-progress facts the gate reads. Supplied by the caller today (the variance engine fills them
 *  from logged payments later, §4). All USD. `signed` = a signed S&P exists for this deal. */
export type PaymentProgress = {
  /** Σ of the customer's logged payments to the developer for this unit (USD). 0 when nothing logged. */
  paidToDateUsd: number;
  /** True iff a signed S&P exists for the deal (the unlockOnSigning leg). */
  signed: boolean;
};

/** Why a commission is / isn't payable yet — client-safe enum (no amounts). Drives copy. */
export type PayableReason =
  | "payable" // both legs met → the developer owes the agency now
  | "awaiting_signing" // %-leg may be met but no signed S&P yet
  | "awaiting_payment" // signed, but paidToDate below the unlock threshold
  | "awaiting_both"; // neither leg met yet

export type PayableStatus = {
  /** The graduated state: true only when BOTH legs are met. */
  payable: boolean;
  reason: PayableReason;
  /** The threshold % actually applied (resolved clause value or the legacy deposit% fallback). */
  unlockPct: number;
  /** The USD the customer must have paid to meet the %-leg = price × unlockPct% (rounded). Lets a surface
   *  say "deposit X of Y received" without recomputing. */
  thresholdUsd: number;
  /** Echo of paidToDate so the surface shows progress against the threshold without a second source. */
  paidToDateUsd: number;
  /** Whether the signing leg is required for THIS clause (unlockOnSigning, default true). */
  signingRequired: boolean;
};

/**
 * Resolve the effective unlock threshold % for a building clause. A clause that carries an explicit
 * `unlockPct` (developer-set at proposal) wins. A legacy clause with none falls back to the plan's
 * DEPOSIT as a % of price — so "commission payable once the deposit is in" (the chosen default, §9).
 * When neither an unlockPct nor a derivable deposit% exists, falls back to 0 (payable on signing alone) —
 * an honest floor, never a fabricated threshold. `priceUsd`/`depositUsd` come from the sealed S&P plan.
 */
export function resolveUnlockPct(
  clause: Pick<AgreementBuilding, "unlockPct">,
  plan: { priceUsd?: number; depositUsd?: number }
): number {
  if (typeof clause.unlockPct === "number" && Number.isFinite(clause.unlockPct) && clause.unlockPct >= 0) {
    return clause.unlockPct;
  }
  // Legacy fallback = deposit as a % of price. Guard the divide; a plan with no price/deposit → 0.
  const price = typeof plan.priceUsd === "number" && plan.priceUsd > 0 ? plan.priceUsd : 0;
  const deposit = typeof plan.depositUsd === "number" && plan.depositUsd > 0 ? plan.depositUsd : 0;
  if (!price || !deposit) return 0;
  return (deposit / price) * 100;
}

/**
 * The AGENCY unlock gate. Given a resolved commission (carries the sealed price + the clause the rate came
 * from), the building clause (for its unlock fields), the sealed plan (for the legacy deposit% fallback),
 * and the payment progress, decide whether the agency's commission is PAYABLE and why.
 *
 * `unlockOnSigning` absent → true (signing required — the safe default). A clause may set it false to mean
 * "the %-threshold alone suffices" without a schema change.
 */
export function resolvePayable(
  commission: Pick<SaleCommission, "priceUsd">,
  clause: Pick<AgreementBuilding, "unlockPct" | "unlockOnSigning">,
  plan: { priceUsd?: number; depositUsd?: number },
  progress: PaymentProgress
): PayableStatus {
  const unlockPct = resolveUnlockPct(clause, plan);
  const thresholdUsd = Math.round((commission.priceUsd * unlockPct) / 100);
  const signingRequired = clause.unlockOnSigning !== false; // absent/true → required
  const paidLegMet = progress.paidToDateUsd >= thresholdUsd;
  const signLegMet = !signingRequired || progress.signed;

  let reason: PayableReason;
  if (paidLegMet && signLegMet) reason = "payable";
  else if (!paidLegMet && !signLegMet) reason = "awaiting_both";
  else if (!signLegMet) reason = "awaiting_signing";
  else reason = "awaiting_payment";

  return {
    payable: paidLegMet && signLegMet,
    reason,
    unlockPct,
    thresholdUsd,
    paidToDateUsd: progress.paidToDateUsd,
    signingRequired,
  };
}

/** plain-words copy for each payable reason (B2B surface; never leaks amounts/contract-speak). */
export const payableReasonCopy: Record<PayableReason, string> = {
  payable: "Commission payable — the developer can release it now.",
  awaiting_signing: "Earned — awaiting the signed sale & purchase agreement.",
  awaiting_payment: "Earned — awaiting enough of the customer's payment to unlock.",
  awaiting_both: "Earned — awaiting the signed agreement and the customer's payment.",
};

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE VARIANCE ENGINE (step 3) — the design docs §4. SERVER-ONLY, PURE.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// The S&P `SalePlan` defines the EXPECTED payment schedule (deposit → on-contract → instalments → on-key, or
// an explicit `schedule[]` when the plan carries one — it wins). This engine logs nothing; it is a PURE
// computation over (the sealed plan) + (the customer's logged payments summed to `paidToDate`) that yields a
// `UnitLedgerStatus`: how much is expected-to-date vs actually paid, the resulting variance, the next due
// line, a late flag, and `pctOfPrice` — the ONE number the agency-unlock gate (§3, above) reads. One figure
// feeds both surfaces; it is never recomputed two contradictory ways.
//
// Real-world messy BY DESIGN: customers underpay, overpay, pay early/late — tracking that mess is the point,
// not a happy-path tick-box. The engine classifies the mess; it does not smooth it over.
//
// ── Honesty discipline (§4, same as `agreementExpiry`) ─────────────────────────────────────────────
// `dueAt` is honestly ABSENT when the plan doesn't state timing — we NEVER guess a date. A plan with no
// `frequencyDays` and no milestone ties yields dated-less lines, and the engine then reports variance on
// AMOUNT alone (expectedToDate = the whole schedule, since nothing is "not yet due"), never a fabricated
// lateness. `lateByDays` only fires against a line that HAS a real `dueAt`.
//
// ── Late FEE is DEFERRED (fork 2, §1-2) ─────────────────────────────────────────────────────────────────
// `lateByDays` is FLAGGED only. The fee AMOUNT waits on a structured late-fee clause `{ rate, graceDays }`
// that doesn't exist on `SalePlan` yet. We surface the lateness; we do NOT auto-accrue a fee against an
// unspecified policy. (Named on the design docs so it isn't forgotten.)

/** One line of the EXPECTED schedule derived from the sealed plan. `dueAt` absent = the plan states no timing
 *  for this line (never guessed). `kind` keeps the line's origin legible for surfaces + late-fee scoping later. */
export type ExpectedLine = {
  label: string;
  dueUsd: number;
  /** ms epoch this line is due, when the plan states timing (booking date + frequency / milestone). Absent =
   *  undated (honest — not guessed). An undated line is treated as "due" for amount variance, never "late". */
  dueAt?: number;
  kind: "deposit" | "on_contract" | "instalment" | "on_key" | "booking_fee" | "furniture" | "schedule";
};

/** The variance classification against the schedule. `on_track` = paid matches expected-to-date within the
 *  rounding tolerance; `behind`/`ahead` compare to what's DUE SO FAR (timing); `under`/`over` compare to the
 *  WHOLE schedule total (amount, when the plan is undated so "to-date" is the whole plan). */
export type PaymentVariance = "on_track" | "under" | "over" | "ahead" | "behind";

export type UnitLedgerStatus = {
  /** The unit's total price from the sealed plan (0 when the plan carries none — then pctOfPrice is 0). */
  priceUsd: number;
  /** Σ of logged payments fed in (the caller sums via payment-vault `paidToDate`; confirmedOnly is its call). */
  paidToDateUsd: number;
  /** Σ of schedule lines due on/before `asOf` (dated lines only); undated lines ALL count (no timing to defer). */
  expectedToDateUsd: number;
  /** Σ of the entire expected schedule — the full obligation (independent of timing). */
  scheduledTotalUsd: number;
  variance: PaymentVariance;
  /** The next unpaid schedule line (first line whose cumulative due exceeds paidToDate), when one remains. */
  nextDue?: ExpectedLine;
  /** Days a DATED line is unpaid past its `dueAt` as-of now (max over overdue lines). Absent = nothing dated
   *  is overdue (or the plan is undated). Fee is NOT accrued here (fork 2) — this is a flag only. */
  lateByDays?: number;
  /** paidToDate / price — the SINGLE number the §3 unlock gate reads. 0 when price is unknown. 0..(>1 if over). */
  pctOfPrice: number;
  /** The derived expected schedule, in order — so a surface can render schedule-vs-actual without re-deriving. */
  schedule: ExpectedLine[];
};

const DAY_MS = 86_400_000;
/** Rounding tolerance for "on_track" — plan figures are whole USD; allow $1 of accumulated rounding slack. */
const TOLERANCE_USD = 1;

/**
 * Derive the EXPECTED payment schedule from a sealed `SalePlan`. An explicit `plan.schedule[]` WINS (it's the
 * attested per-line plan — doc §4); otherwise we synthesise the conventional order deposit → on-contract →
 * instalments → on-key from the structured figures. `bookingAt` (the booking/offer date) seeds dated lines
 * when the plan carries `frequencyDays`; without it (or without a frequency) lines are honestly UNDATED.
 *
 * `instalmentMilestones` (display ties) are NOT dates — they're milestone labels with free-text `when`
 * ("Q3 2027"), which we cannot turn into a reliable ms epoch. So a milestone-tied plan is treated as undated
 * (amount variance only), the same honesty rule: never fabricate a due date from un-parseable text.
 */
export function deriveSchedule(
  plan: SalePlan | null | undefined,
  bookingAt?: number,
  // per-instalment DUE-DATE overrides (ordinal → ms epoch), threaded from the offer so the
  // ledger dates a line EXACTLY as the S&P does (one rule: instalmentDueDate). Absent → auto-interval only.
  dueDateOverrides?: Record<string, number>
): ExpectedLine[] {
  if (!plan) return [];
  const lines: ExpectedLine[] = [];

  // Explicit per-line schedule wins — it's the attested plan. a line now carries its own `dueAt` when
  // the plan states one (e.g. a materialized direct offer or a dated template), so the ledger dates it too;
  // a line without a `dueAt` stays honestly undated (unchanged).
  if (Array.isArray(plan.schedule) && plan.schedule.length > 0) {
    let instOrd = 0;
    for (const s of plan.schedule) {
      if (typeof s.amountUsd === "number" && s.amountUsd > 0) {
        const isInst = /instal/i.test(s.label);
        if (isInst) instOrd++;
        // Priority matches the S&P renderer: line `dueAt` → override → auto-interval (instalments only).
        const dueAt = isInst
          ? instalmentDueDate(instOrd, {
              anchorAt: bookingAt,
              freqDays: plan.frequencyDays,
              override: dueDateOverrides?.[String(instOrd)],
              lineDueAt: s.dueAt,
            })
          : s.dueAt;
        lines.push({ label: s.label, dueUsd: s.amountUsd, kind: "schedule", dueAt });
      }
    }
    return lines;
  }

  // Synthesised order. Deposit + on-contract are the up-front legs (undated — due "on reservation / signing",
  // no clock); instalments carry the frequency clock; on-key is the final transfer leg (undated — tied to
  // handover, which the plan doesn't date here).
  const push = (label: string, dueUsd: unknown, kind: ExpectedLine["kind"], dueAt?: number) => {
    if (typeof dueUsd === "number" && dueUsd > 0) lines.push({ label, dueUsd, kind, dueAt });
  };

  push("Booking fee", plan.bookingFeeUsd, "booking_fee");
  push("Deposit", plan.depositUsd, "deposit");
  push("On signing", plan.onContractUsd, "on_contract");

  const count = typeof plan.instalmentCount === "number" ? Math.max(0, Math.floor(plan.instalmentCount)) : 0;
  const each = typeof plan.instalmentUsd === "number" && plan.instalmentUsd > 0 ? plan.instalmentUsd : 0;
  if (count > 0 && each > 0) {
    // single dating rule (instalmentDueDate, shared with the S&P renderer): a per-ordinal override
    // wins, else the auto-interval bookingAt + n×frequencyDays, else honestly undated (no anchor / no freq).
    for (let n = 1; n <= count; n++) {
      const dueAt = instalmentDueDate(n, {
        anchorAt: bookingAt,
        freqDays: plan.frequencyDays,
        override: dueDateOverrides?.[String(n)],
      });
      push(`Instalment ${n} of ${count}`, each, "instalment", dueAt);
    }
  }

  push("Furniture package", plan.furnitureUsd, "furniture");
  push("On transfer / keys", plan.onKeyUsd, "on_key");
  return lines;
}

/**
 * Compute the full variance status for a unit: EXPECTED schedule (from the plan) vs ACTUAL `paidToDateUsd`
 * (summed by the caller from payment-vault records). Pure — `asOf` is the clock (defaults to now at call,
 * passed by tests for determinism). `priceUsd` is read from the plan; pass it explicitly only when the plan
 * omits it (e.g. the commission's sealed price) — the explicit arg wins so the gate's one price is honoured.
 */
export function computeLedgerStatus(
  plan: SalePlan | null | undefined,
  paidToDateUsd: number,
  opts?: { asOf?: number; bookingAt?: number; priceUsd?: number; dueDateOverrides?: Record<string, number> }
): UnitLedgerStatus {
  const asOf = opts?.asOf ?? Date.now();
  const schedule = deriveSchedule(plan, opts?.bookingAt, opts?.dueDateOverrides);
  const scheduledTotalUsd = schedule.reduce((s, l) => s + l.dueUsd, 0);

  // Expected-to-date: walk the schedule IN ORDER. A dated line counts once its `dueAt` has passed. An undated
  // line counts only while no earlier dated line is still in the FUTURE — i.e. undated up-front legs (deposit,
  // on-contract) count immediately, but an undated TERMINAL leg (on-key / on-transfer) that sits after a
  // not-yet-due instalment does NOT inflate expected-to-date. Once we reach a dated line that's still future,
  // every later line (dated or not) is "not yet due". This keeps a mid-plan buyer from looking "behind" just
  // because a handover payment has no date (honesty — an undated future leg is not a present obligation).
  let expectedToDateUsd = 0;
  let reachedFuture = false;
  for (const l of schedule) {
    if (l.dueAt !== undefined) {
      if (l.dueAt <= asOf && !reachedFuture) expectedToDateUsd += l.dueUsd;
      else reachedFuture = true;
    } else if (!reachedFuture) {
      expectedToDateUsd += l.dueUsd;
    }
  }

  const paid = Math.max(0, paidToDateUsd);

  // Next due = the first schedule line whose cumulative obligation exceeds what's been paid.
  let cum = 0;
  let nextDue: ExpectedLine | undefined;
  for (const l of schedule) {
    cum += l.dueUsd;
    if (cum > paid + TOLERANCE_USD) {
      nextDue = l;
      break;
    }
  }

  // Late: the max days past-due over DATED lines whose cumulative obligation isn't yet covered by `paid`.
  // Only dated lines can be late (honesty); undated lines never produce a lateness.
  let cumL = 0;
  let lateByDays: number | undefined;
  for (const l of schedule) {
    cumL += l.dueUsd;
    const covered = paid + TOLERANCE_USD >= cumL;
    if (!covered && l.dueAt !== undefined && l.dueAt < asOf) {
      const days = Math.floor((asOf - l.dueAt) / DAY_MS);
      if (days > 0 && (lateByDays === undefined || days > lateByDays)) lateByDays = days;
    }
  }

  // Variance classification. Compare paid to expected-to-date (timing) first; then to the whole schedule
  // (amount). `behind`/`ahead` are the TIMING verdicts; `under`/`over` the final-amount verdicts.
  let variance: PaymentVariance;
  if (lateByDays !== undefined || paid + TOLERANCE_USD < expectedToDateUsd) {
    variance = "behind";
  } else if (paid > scheduledTotalUsd + TOLERANCE_USD) {
    variance = "over";
  } else if (scheduledTotalUsd > 0 && paid + TOLERANCE_USD >= scheduledTotalUsd) {
    variance = "on_track"; // fully paid up — on track (complete)
  } else if (paid > expectedToDateUsd + TOLERANCE_USD) {
    variance = "ahead"; // paid more than is due so far, but not the whole plan
  } else if (Math.abs(paid - expectedToDateUsd) <= TOLERANCE_USD) {
    variance = "on_track";
  } else {
    variance = "under"; // paid less than the whole schedule and we're at/after the end (no dated line overdue)
  }

  const priceUsd =
    typeof opts?.priceUsd === "number" && opts.priceUsd > 0
      ? opts.priceUsd
      : typeof plan?.priceUsd === "number" && plan.priceUsd > 0
      ? plan.priceUsd
      : 0;
  const pctOfPrice = priceUsd > 0 ? (paid / priceUsd) * 100 : 0;

  return {
    priceUsd,
    paidToDateUsd: paid,
    expectedToDateUsd,
    scheduledTotalUsd,
    variance,
    nextDue,
    lateByDays,
    pctOfPrice,
    schedule,
  };
}

/** plain-words copy for each variance (B2B/developer surface; no field-names, no contract-speak). */
export const varianceCopy: Record<PaymentVariance, string> = {
  on_track: "On track — payments match the plan.",
  under: "Under — less has been paid than the plan calls for.",
  over: "Overpaid — more has been received than the plan total.",
  ahead: "Ahead — paid more than is due so far.",
  behind: "Behind — a payment is overdue against the plan.",
};

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE VRX UNLOCK — the 14-WORKING-DAY CLOCK (§3b) — SERVER-ONLY, PURE.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// VRX's OWN protocol commission does NOT use the agency's `unlockPct` %-threshold (that's the agency gate,
// §3 above). VRX's cut is a TIME-based clock:
//   • EARNED trigger — a unit LEAVES `available` into any other status and is NOT reversed back within a
//  short reversal window. "Any exit" (held / reserved / sold / blocked — the literal call). The
//     reversal window exists so a momentary flip-and-undo (admin slip, a released soft hold) does not start
//     the clock. The exit MOMENT (the clock anchor) comes from lib/status-ledger.leftAvailableAt — the
//  already-built spine; this module does not re-derive it, it CONSUMES it.
//   • DUE date — `settleWorkingDays` WORKING days (default 14, per-developer on the VRX↔developer agreement,
//     lib/developers.vrxSettleWorkingDays) after that exit. Weekends are skipped.
//   • EARLY-SETTLE — if the deposit is in AND the S&P is signed AND one more payment completed BEFORE the
//     window closes, VRX would LIKE to be paid at that point (a willingness, not a hard gate — the hard gate
//     is the window closing). The caller passes `earlySettleReady` when those conditions hold.
//
// ── Honesty discipline (named gaps, NOT invented — same rule as `agreementExpiry`/`dueAt`) ──────────────────
//   (a) WORKING-DAY math is weekends-only. A HOLIDAY CALENDAR is a named later refinement — we do NOT invent
//       a holiday table (it would be wrong for every region). Documented, not faked.
//   (b) REVERSAL WINDOW — a short grace after the exit before the clock is treated as "really started",
//       guarding a fast flip-and-undo. Its precise length is a named open item (§9); the gate takes it as a
//       param (default 1 working day) so it's explicit, never hard-coded-silent. Note the ledger-seam's own
//       documented limitation: a 0→X→0 bounce entirely between two status reads is invisible to the seam, so
//  "not reversed" is best-effort ("no return RECORDED"), not proof — the indexer feed closes that
//       later without changing this gate's contract (lib/status-ledger top-comment).
//
// PRIVACY: pure + server-only; produces a B2B fact (VRX payable yes/no + the due date), no amounts leak
// to any non-party surface, nothing on-chain. The clock is off-chain and survives a future V7 contract
// defrost unchanged (it reads the status HISTORY, not contract state).

/** Why VRX's protocol fee is / isn't payable yet on a unit — client-safe enum (no amounts). Drives copy. */
export type VrxPayableReason =
  | "payable" // the working-day window has closed (or early-settle fired) → the developer owes VRX now
  | "clock_running" // the unit has left available & cleared the reversal window, but the window hasn't closed
  | "in_reversal_window" // the unit just left available; still within the reversal window (clock not started)
  | "no_exit"; // the unit is still available / no recorded departure → nothing owed yet

export type VrxClockStatus = {
  /** True only when the window has closed (or early-settle fired) → the fee is payable now. */
  payable: boolean;
  reason: VrxPayableReason;
  /** The exit moment the clock is anchored to (ms epoch), echoed from leftAvailableAt. Absent = no exit. */
  leftAvailableAt?: number;
  /** ms epoch the fee becomes due (exit + reversalWindow + settleWorkingDays, counted in working days).
   *  Absent when there's no exit to anchor to. */
  dueAt?: number;
  /** The working-day window actually applied (the developer's value or the default). */
  settleWorkingDays: number;
  /** Working days remaining until `dueAt` as-of now (0 when due/overdue). Absent when there's no clock. */
  workingDaysRemaining?: number;
  /** True iff the payable verdict came from EARLY-SETTLE (deposit+signed+one-more-payment before the window
   *  closed) rather than the window closing. Informational — lets a surface say "settled early". */
  earlySettled: boolean;
};

const DAY_MS_VRX = 86_400_000;

/** True iff `ms` falls on a Saturday or Sunday (UTC). Weekend = not a working day. (A regional holiday
 *  calendar is a named later refinement — §3b — not applied here; this is weekends-only by design.) */
function isWeekendUtc(ms: number): boolean {
  const d = new Date(ms).getUTCDay(); // 0 = Sunday, 6 = Saturday
  return d === 0 || d === 6;
}

/**
 * Add `n` WORKING days to `from` (ms epoch), skipping weekends. Returns the ms epoch of the resulting day
 * (same time-of-day as `from`). `n` is clamped to ≥ 0; n === 0 returns `from` unchanged. Deterministic and
 * pure — UTC throughout so it never shifts with the server's local zone. Weekends-only (no holiday table —
 * the named §3b refinement). Used to compute the VRX clock's due date from the exit moment.
 */
export function addWorkingDays(from: number, n: number): number {
  const steps = Math.max(0, Math.floor(n));
  let at = from;
  let added = 0;
  while (added < steps) {
    at += DAY_MS_VRX;
    if (!isWeekendUtc(at)) added += 1;
  }
  return at;
}

/**
 * Count WORKING days from `from` to `to` (how many business days have elapsed), skipping weekends. 0 when
 * `to <= from`. Pure/UTC. The inverse lens of addWorkingDays — used to report working-days-remaining. We
 * count each midnight-to-next crossing that lands on a weekday, matching addWorkingDays' stepping so the two
 * are consistent (addWorkingDays(from, businessDaysBetween(from, to)) ≈ to, modulo intra-day remainder).
 */
export function businessDaysBetween(from: number, to: number): number {
  if (to <= from) return 0;
  let at = from;
  let count = 0;
  while (at + DAY_MS_VRX <= to) {
    at += DAY_MS_VRX;
    if (!isWeekendUtc(at)) count += 1;
  }
  return count;
}

/**
 * The VRX CLOCK gate (§3b). Given WHEN a unit left `available` (from lib/status-ledger.leftAvailableAt — null
 * if it's still available / no recorded departure), the developer's working-day window, and the clock (`asOf`,
 * injectable for tests), decide whether VRX's protocol fee is PAYABLE on this unit and why.
 *
 * Sequence from the exit moment:
 *   1. exit at T                                   → `in_reversal_window` for the first `reversalWindowDays`
 *      working days (guards a fast flip-and-undo; the clock isn't treated as "really started" yet).
 *   2. after the reversal window, before due       → `clock_running` (dueAt in the future).
 *   3. at/after dueAt (= T + reversalWindow + settleWorkingDays, all in working days) → `payable`.
 *   • EARLY-SETTLE override: if `earlySettleReady` (deposit+signed+one-more-payment, resolved by the caller)
 *     holds, the fee is `payable` immediately regardless of the window — VRX's willingness to be paid early.
 *
 * No exit recorded → `no_exit` (nothing owed). Pure; never reads a store — the caller supplies leftAt.
 */
export function resolveVrxClock(args: {
  /** The exit moment from lib/status-ledger.leftAvailableAt (ms epoch), or null if still available. */
  leftAvailableAt: number | null;
  /** The developer's working-day window (lib/developers.vrxSettleWorkingDays). */
  settleWorkingDays: number;
  /** Short grace (working days) after the exit before the clock is treated as started — guards a flip-and-undo.
   *  Default 1 working day (§3b open item — the precise length is still to spec; passed explicitly, not hidden). */
  reversalWindowDays?: number;
  /** True iff deposit-in + signed-S&P + one-more-payment all landed before the window closed (caller resolves
   *  from the variance engine + contract stage) → VRX's early-settle willingness fires. Default false. */
  earlySettleReady?: boolean;
  /** The clock. Defaults to now; tests pass a fixed value for determinism. */
  asOf?: number;
}): VrxClockStatus {
  const settleWorkingDays = Math.max(0, Math.floor(args.settleWorkingDays));
  const reversalWindowDays = Math.max(0, Math.floor(args.reversalWindowDays ?? 1));
  const asOf = args.asOf ?? Date.now();
  const earlySettleReady = args.earlySettleReady === true;

  // No recorded departure from available → nothing owed. (leftAvailableAt returns null when the unit is
  // currently available or has bounced back since its last departure — so this also covers "reversed".)
  if (args.leftAvailableAt == null) {
    return { payable: false, reason: "no_exit", settleWorkingDays, earlySettled: false };
  }

  const leftAt = args.leftAvailableAt;
  // The clock "really starts" only after the reversal window clears; the due date is measured from the exit.
  const reversalClearsAt = addWorkingDays(leftAt, reversalWindowDays);
  const dueAt = addWorkingDays(leftAt, reversalWindowDays + settleWorkingDays);
  const windowClosed = asOf >= dueAt;

  // Early-settle: VRX's willingness to be paid before the window closes, when the deal is far enough along.
  if (earlySettleReady && !windowClosed) {
    return {
      payable: true,
      reason: "payable",
      leftAvailableAt: leftAt,
      dueAt,
      settleWorkingDays,
      workingDaysRemaining: businessDaysBetween(asOf, dueAt),
      earlySettled: true,
    };
  }

  if (windowClosed) {
    return {
      payable: true,
      reason: "payable",
      leftAvailableAt: leftAt,
      dueAt,
      settleWorkingDays,
      workingDaysRemaining: 0,
      earlySettled: false,
    };
  }

  // Not yet due. Distinguish the reversal grace (clock not started) from the running window (clock ticking).
  const inReversal = asOf < reversalClearsAt;
  return {
    payable: false,
    reason: inReversal ? "in_reversal_window" : "clock_running",
    leftAvailableAt: leftAt,
    dueAt,
    settleWorkingDays,
    workingDaysRemaining: businessDaysBetween(asOf, dueAt),
    earlySettled: false,
  };
}

/** plain-words copy for each VRX-clock reason (B2B/developer surface; no field-names/contract-speak). */
export const vrxPayableReasonCopy: Record<VrxPayableReason, string> = {
  payable: "Protocol fee payable — the settlement window has passed.",
  clock_running: "Accrued — within the settlement window; the fee becomes due when it closes.",
  in_reversal_window: "Just reserved — a short grace before the settlement window begins.",
  no_exit: "Not yet accrued — the unit is still available.",
};
