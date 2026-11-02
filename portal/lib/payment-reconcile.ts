// reconciliation"). This is the matching engine that pairs the DEVELOPER's "received" records against the
// BUYER's independent "sent" attestations (both now live in lib/payment-vault.ts with a `side` discriminator)
// and classifies the gap as a STRUCTURED discrepancy — amount / date / method — never free-text.
// ── Why this exists (the gap it closes) ─────────────────────────────────────────────────────────────────
// The one-record confirm/dispute surface (§4b, built) already lets the buyer CONFIRM or DISPUTE each
// developer-logged payment. But a dispute there is a free-text note ("that's not right"). §5b is the richer
// engine reconciles the two ledgers so the mismatch is a precise, machine-legible fact: "the developer
// recorded $19,500 received on the 3rd; you recorded $20,000 sent on the 1st — short by $500, 2 days apart."
// ── The authority rule ( — VRX facilitates + seals, does NOT adjudicate) ─────────────────────────────
// This engine RECORDS the variance as a structured fact; it NEVER decides whose number is "true" and NEVER
// moves money or `paidToDate`. The developer's "received" figure remains the cashflow + unlock basis
// (lib/payment-vault.paidToDate already excludes "sent" records). A discrepancy is surfaced to BOTH parties
// (and routed to the deal chat / dispute flow by the caller) for THEM to resolve — VRX states the facts.
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// Pure + server-only. It computes over amounts/dates/methods that are already B2B developer↔buyer PII; it
// produces no NEW exposure (the authorizing route decides who may read a reconciliation — developer, buyer,
// or, in a shared dispute, VRX-root). Nothing on-chain.: the copy speaks plain words, no contract-speak.

/** The minimal per-record facts the engine reconciles. The caller supplies these from vault records (both
 * sides) — the engine reads no store. `side` MUST be set ("received" = developer, "sent" = buyer). */
export type ReconcileInput = {
  id: string;
  side: "received" | "sent";
  amountUsd: number;
  /** ms epoch: the developer's received-date, or the buyer's sent-date. */
  paidAt: number;
  method: "cash" | "bank_slip" | "qr_slip" | "other";
  /** A flagged (bad_evidence/bad_actor) record is excluded from pairing — it's untrusted. */
  flagged?: boolean;
};

/** How a pairing (or an unpaired record) is classified. STRUCTURED, not free-text. */
export type ReconcileKind =
  | "matched" // amount within tolerance AND date within the window AND same method
  | "short" // PAIRED, but the developer received LESS than the buyer says they sent (money short)
  | "over" // PAIRED, but the developer received MORE than the buyer claims to have sent
  | "date_drift" // PAIRED, amounts agree, but the dates differ beyond the window
  | "method_drift" // PAIRED, amount + date agree, but the recorded method differs
  | "unpaired_sent" // the buyer attested a payment with NO matching developer record (not yet logged/seen)
  | "unpaired_received"; // the developer logged a payment the buyer has NOT independently attested

/** One reconciliation line — a pairing of a received + a sent record, OR a lone unpaired record. */
export type ReconcileLine = {
  kind: ReconcileKind;
  /** The developer's "received" record id, when this line involves one. */
  receivedId?: string;
  /** The buyer's "sent" record id, when this line involves one. */
  sentId?: string;
  /** Developer-recorded amount (USD), when a received record is involved. */
  receivedUsd?: number;
  /** Buyer-attested amount (USD), when a sent record is involved. */
  sentUsd?: number;
  /** received − sent (USD) for a PAIRED line: negative = short (dev got less than buyer sent), positive =
   * over. Absent for an unpaired line (nothing to subtract). */
  amountDeltaUsd?: number;
  /** |received.paidAt − sent.paidAt| in whole days for a paired line. Absent for unpaired. */
  dateDeltaDays?: number;
  /** True when a paired line's two records name different methods (informational — not itself a dispute). */
  methodDiffers?: boolean;
  /** Plain-words one-line description of this line — safe for either party's surface. */
  copy: string;
};

export type ReconcileSummary = {
  lines: ReconcileLine[];
  /** Σ of the developer's "received" records (trusted figure — matches paidToDate's basis). */
  totalReceivedUsd: number;
  /** Σ of the buyer's "sent" attestations. */
  totalSentUsd: number;
  /** totalReceived − totalSent. 0 (within tolerance) = the two ledgers agree in aggregate. */
  netDeltaUsd: number;
  /** True iff EVERY line is "matched" (both ledgers fully agree, record-by-record). */
  reconciled: boolean;
  /** How many lines are a genuine discrepancy (anything but "matched"). */
  discrepancyCount: number;
  /** A plain-words headline for the whole deal. */
  headline: string;
};

const DAY_MS = 86_400_000;
/** Amount tolerance (USD) — plan/payment figures are whole USD; allow $1 of rounding slack before "short"/"over". */
const AMOUNT_TOLERANCE_USD = 1;
/** Date window (days) within which a received/sent pair is considered the SAME payment on timing. A bank
 * transfer commonly clears 1–3 days after it is sent; beyond this the pair is flagged `date_drift`. Passed as
 * a param-with-default so it is explicit, never hidden (same discipline as the ledger's reversal window). */
const DEFAULT_DATE_WINDOW_DAYS = 3;

/** Whole-day gap between two ms epochs. */
function dayGap(a: number, b: number): number {
  return Math.floor(Math.abs(a - b) / DAY_MS);
}

/**
 * Pair the buyer's "sent" attestations against the developer's "received" records for ONE deal and classify
 * every pairing + every leftover as a structured discrepancy. PURE — the caller supplies both sides (e.g. from
 * vault.paymentsForDeal); no store, no clock dependence (dates come from the records themselves).
 *
 * Pairing is greedy + deterministic: each "sent" record claims the best-available still-unpaired "received"
 * record — closest date first, then closest amount (ties broken by record id for stability). This matches the
 * real question ("which deposit does this slip correspond to?") without a global optimiser we can't explain to
 * a party. Flagged records (untrusted) are excluded from pairing and reported separately as unpaired.
 */
export function reconcileDeal(
  records: ReconcileInput[],
  opts?: { dateWindowDays?: number }
): ReconcileSummary {
  const dateWindowDays = Math.max(0, Math.floor(opts?.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS));

  // Partition by side, dropping flagged (untrusted) records from pairing. A flagged record is reported as a
  // lone unpaired line so it's visible, but it can never form a "matched" pair that hides a bad slip.
  const trusted = records.filter((r) => !r.flagged);
  const received = trusted.filter((r) => r.side === "received");
  const sent = trusted.filter((r) => r.side === "sent");

  // Totals reflect the TRUSTED ledger only — a flagged (untrusted) record is excluded here, the same rule as
  // lib/payment-vault.paidToDate (a bogus slip must not inflate "total received"). Flagged records stay VISIBLE
  // as their own set-aside lines below, so nothing is hidden; they just don't count toward the trusted figure.
  const totalReceivedUsd = received.reduce((s, r) => s + r.amountUsd, 0);
  const totalSentUsd = sent.reduce((s, r) => s + r.amountUsd, 0);

  const lines: ReconcileLine[] = [];
  const usedReceived = new Set<string>();

  // Each SENT record claims its best available RECEIVED record. Sent records are processed oldest-first so the
  // earliest claim gets first pick (deterministic; mirrors chronological settlement).
  const sentOrdered = [...sent].sort((a, b) => a.paidAt - b.paidAt || a.id.localeCompare(b.id));
  for (const s of sentOrdered) {
    let best: ReconcileInput | undefined;
    let bestGap = Infinity;
    let bestAmtGap = Infinity;
    for (const r of received) {
      if (usedReceived.has(r.id)) continue;
      const gap = dayGap(r.paidAt, s.paidAt);
      const amtGap = Math.abs(r.amountUsd - s.amountUsd);
      // Closest date wins; ties broken by closest amount, then id for a stable choice.
      if (
        gap < bestGap ||
        (gap === bestGap && amtGap < bestAmtGap) ||
        (gap === bestGap && amtGap === bestAmtGap && (!best || r.id.localeCompare(best.id) < 0))
      ) {
        best = r;
        bestGap = gap;
        bestAmtGap = amtGap;
      }
    }

    if (!best) {
      // No developer record to pair with — the buyer attested a payment the developer hasn't logged (or seen).
      lines.push({
        kind: "unpaired_sent",
        sentId: s.id,
        sentUsd: s.amountUsd,
        copy: "You recorded a payment the developer has not logged yet — awaiting their record.",
      });
      continue;
    }

    usedReceived.add(best.id);
    const amountDeltaUsd = best.amountUsd - s.amountUsd; // received − sent
    const dateDeltaDays = dayGap(best.paidAt, s.paidAt);
    const methodDiffers = best.method !== s.method;

    let kind: ReconcileKind;
    let copy: string;
    if (amountDeltaUsd < -AMOUNT_TOLERANCE_USD) {
      kind = "short";
      copy = `Short by $${Math.abs(amountDeltaUsd).toLocaleString()} — the developer recorded less received than you recorded sent.`;
    } else if (amountDeltaUsd > AMOUNT_TOLERANCE_USD) {
      kind = "over";
      copy = `Over by $${amountDeltaUsd.toLocaleString()} — the developer recorded more received than you recorded sent.`;
    } else if (dateDeltaDays > dateWindowDays) {
      kind = "date_drift";
      copy = `Amounts agree, but the dates are ${dateDeltaDays} days apart — please check which is correct.`;
    } else if (methodDiffers) {
      kind = "method_drift";
      copy = "Amount and date agree, but the payment method recorded differs on each side.";
    } else {
      kind = "matched";
      copy = "Matched — both sides agree on amount, date, and method.";
    }

    lines.push({
      kind,
      receivedId: best.id,
      sentId: s.id,
      receivedUsd: best.amountUsd,
      sentUsd: s.amountUsd,
      amountDeltaUsd,
      dateDeltaDays,
      methodDiffers,
      copy,
    });
  }

  // Any RECEIVED record the buyer never independently attested → unpaired_received.
  for (const r of received) {
    if (usedReceived.has(r.id)) continue;
    lines.push({
      kind: "unpaired_received",
      receivedId: r.id,
      receivedUsd: r.amountUsd,
      copy: "The developer recorded a payment you have not independently confirmed with your own record.",
    });
  }

  // Report flagged records (excluded from pairing) so they stay visible — as whichever unpaired kind fits.
  for (const f of records.filter((r) => r.flagged)) {
    lines.push({
      kind: f.side === "sent" ? "unpaired_sent" : "unpaired_received",
      receivedId: f.side === "received" ? f.id : undefined,
      sentId: f.side === "sent" ? f.id : undefined,
      receivedUsd: f.side === "received" ? f.amountUsd : undefined,
      sentUsd: f.side === "sent" ? f.amountUsd : undefined,
      copy: "Flagged record — set aside from reconciliation until the flag is resolved.",
    });
  }

  const netDeltaUsd = totalReceivedUsd - totalSentUsd;
  const discrepancyCount = lines.filter((l) => l.kind !== "matched").length;
  // "reconciled" = there was something to reconcile AND every line matched. An empty deal (no records either
  // side) is NOT "reconciled" — there's nothing attested yet; the headline says so.
  const reconciled = lines.length > 0 && discrepancyCount === 0;

  let headline: string;
  if (lines.length === 0) {
    headline = "No payments recorded on either side yet.";
  } else if (reconciled) {
    headline = "Both ledgers agree — every recorded payment matches.";
  } else {
    headline = `${discrepancyCount} item${discrepancyCount === 1 ? "" : "s"} to reconcile between the two ledgers.`;
  }

  return {
    lines,
    totalReceivedUsd,
    totalSentUsd,
    netDeltaUsd,
    reconciled,
    discrepancyCount,
    headline,
  };
}

/** plain-words labels for each reconcile kind — for a surface that groups/badges lines by kind. */
export const reconcileKindCopy: Record<ReconcileKind, string> = {
  matched: "Matched",
  short: "Short — developer recorded less than you sent",
  over: "Over — developer recorded more than you sent",
  date_drift: "Dates differ",
  method_drift: "Method differs",
  unpaired_sent: "Awaiting the developer's record",
  unpaired_received: "Awaiting your confirmation",
};
