// VRX PROTOCOL-FEE EARMARK + SETTLEMENT ROLLUP — SERVER-ONLY. The ACCRUAL layer: the
// twin of lib/commission.ts. Where commission.ts resolves the AGENCY's per-sale commission, this resolves
// the VRX PROTOCOL fee a developer owes VRX on a facilitated sale, and rolls BOTH streams up into a
// settlement view (who-owes-whom): developer→agency commission + developer→VRX protocol fee.
// ── EARMARK → TAKE, and why only EARMARK is built now ────────────────────────────────────────────
// its charge model is EARMARK→TAKE. EARMARK = "this fee is accrued/owed" — a pure, off-chain computation
// over the sealed sale records. TAKE = actually moving the money (the on-rail stablecoin settlement,
// computes the EARMARK honestly today; `settledUsd` is carried in the shape (always 0 for now) so the later
// settlement rail fills it without reshaping anything. The demo shows the money LOGIC without transacting.
// ── Fee basis (an honest, consistent number) ────────────────────────────────────────────────────────────
// names the fee basis as the PUBLISHED price snapshot (observable, ungameable). We use the SAME price
// commission.ts uses — `offer.seal.plan.priceUsd` (the sealed booked price) — so the protocol fee and the
// agency commission are computed on ONE number, never two contradictory figures. The published-snapshot
// refinement (join unit→catalog published price for anti-gaming) is a later hardening, noted not built.
// ── State mirrors commission (earned vs prospective) ────────────────────────────────────────────────────
// A fee is `earmarked` on a CONFIRMED sale (real, owed) and `prospective` on a not-yet-confirmed booking
// (previewed). Same confirmed/prospective split as commission, so the two surfaces stay consistent. A fee
// only accrues when a commission relationship exists for the sale (same resolution gate) — VRX facilitates
// the deal the agency makes; no facilitated sale, no fee. (A direct/house sale with no agency is out of scope
// for this slice — it has no agency-commission record to key off; handled when the house-org sale arc lands.)
// PRIVACY: SERVER-ONLY; reads the sealed off-chain records; produces USD figures that are B2B money and
// NEVER appear on a buyer's S&P (same rule as commission). Nothing on-chain.

import type { Offer } from "./offers";
import { allOffers, contractStage } from "./offers";
import { explainSaleCommission, type SaleCommission } from "./commission";
import type { CommissionReason } from "./commission-reason";
import { getDeveloper, protocolFeePct, vrxSettleWorkingDays } from "./developers";
import {
  resolvePayable,
  resolveVrxClock,
  type PayableReason,
  type VrxPayableReason,
} from "./payment-ledger";
import { paymentsForRequest, paidToDate } from "./payment-vault";
import { leftAvailableAt } from "./status-ledger";

/** The VRX protocol fee resolved for one sale. Parallels SaleCommission (the agency's cut). */
export type ProtocolFee = {
  /** The fee % applied (the developer's protocolFeePct or the default). */
  pct: number;
  /** The price the % is applied to (USD) — the sealed booked price, same basis as commission. */
  priceUsd: number;
  /** The fee owed to VRX (USD), rounded. */
  amountUsd: number;
  /** The developer who owes it. */
  developer: string;
};

/** The explained per-sale earmark: the fee (or null) + the SAME reason the commission resolver gave, so a
 * surface can explain a no-fee outcome consistently with the no-commission one. `confirmed` distinguishes an
 * EARMARKED (owed, real sale) fee from a PROSPECTIVE (previewed, not-yet-confirmed) one. */
export type EarmarkResult = {
  fee: ProtocolFee | null;
  reason: CommissionReason;
  confirmed: boolean;
  baselineAt?: number;
};

/**
 * Resolve the VRX protocol fee earmark for one booking. Keyed off the SAME gate as the agency commission
 * (explainSaleCommission): a fee accrues only where a commission would — a facilitated sale with a live
 * relationship, at-or-after the baseline. Returns the fee + why. Pure read; never mutates.
 */
export async function resolveEarmark(offer: Offer): Promise<EarmarkResult> {
  // Reuse the commission gate as the single source of "is this a facilitated, countable sale, and when".
  const c = await explainSaleCommission(offer);
  const confirmed = c.reason === "earned";
  if (!c.commission) {
    // No commission resolvable → no facilitated-sale fee to earmark. Carry the reason through verbatim.
    return { fee: null, reason: c.reason, confirmed, baselineAt: c.baselineAt };
  }

  const developer = offer.developer.trim();
  // H1: for a CONFIRMED sale prefer the FROZEN fee rate from the obligation snapshot (the rate that
  // was true at close), falling back to the live developer rate for a prospective booking or a legacy
  // snapshot-less confirmed offer. Keeps the VRX fee immune to a later rate change / agreement revoke, the
  // same way the commission is.
  const frozenFeePct = offer.confirmed && offer.obligation ? offer.obligation.feePct : undefined;
  const dev = await getDeveloper(developer);
  const pct = typeof frozenFeePct === "number" ? frozenFeePct : protocolFeePct(dev);
  const priceUsd = c.commission.priceUsd; // the exact basis commission used
  const fee: ProtocolFee = {
    pct,
    priceUsd,
    amountUsd: Math.round((priceUsd * pct) / 100),
    developer,
  };
  return { fee, reason: c.reason, confirmed, baselineAt: c.baselineAt };
}

// ── The settlement rollup (who-owes-whom) ───────────────────────────────────────────────────────────────

/** A running balance bucket. `accruedUsd` = EARMARKED on confirmed sales (really owed); `prospectiveUsd` =
 * previewed on not-yet-confirmed bookings; `settledUsd` = already paid (0 until the TAKE rail is built);
 * `outstandingUsd` = accrued − settled (what's still owed right now). `saleCount` = confirmed sales in it.
 *
 * step 4 — `payableUsd` is the SUBSET of `accruedUsd` that has ALSO passed the agency unlock gate
 * (`lib/payment-ledger.resolvePayable`): a signed S&P AND the customer has paid ≥ the unlock threshold. It
 * is an additive lens, not a re-split: `payableUsd ≤ accruedUsd` always, and nothing about accrued/
 * prospective/settled/outstanding changes meaning.
 *
 * §3b — the VRX protocol-fee line now ALSO carries `payableUsd`, but via its OWN gate: the 14-working-
 * day settlement CLOCK (`lib/payment-ledger.resolveVrxClock`), NOT the agency %-threshold. A VRX fee counts
 * toward `payableUsd` once the unit's settlement window has closed (or early-settle fired). Same additive-
 * lens rule (`payableUsd ≤ accruedUsd`). The §3c grace/suspension routine reads this same clock later. */
export type Balance = {
  accruedUsd: number;
  prospectiveUsd: number;
  payableUsd: number;
  settledUsd: number;
  outstandingUsd: number;
  saleCount: number;
};

function emptyBalance(): Balance {
  return { accruedUsd: 0, prospectiveUsd: 0, payableUsd: 0, settledUsd: 0, outstandingUsd: 0, saleCount: 0 };
}

/** One booking behind a settlement line — the per-deal audit detail (so a $6,720 total is traceable to the
 * exact sale: which unit, at what price, at what rate). `kind` mirrors the balance split (a confirmed sale is
 * earned/accrued; an unconfirmed booking is prospective). READABLE ids only (catalog slugs from `display`,
 * never on-chain hashes) — these surfaces are developer/agency-only so unit/building refs are fine. */
export type DealLine = {
  requestId: string;
  buildingId?: string;
  unitId?: string;
  priceUsd: number;
  pct: number;
  amountUsd: number;
  kind: "earned" | "prospective";
  /** The agency on the deal (carried so a VRX-fee line can still name who the facilitating agency was). */
  agency: string;
  at: number;
  /** — the on-chain booking-CLOSE receipt (confirm_claim tx hash) when the sale was closed through the
   * system. Absent for a prospective booking (not yet confirmed) or one confirmed outside the portal. Lets
   * the settlement row link straight to the explorer proof. (The DEPOSIT tx lives in the deposit rail keyed
   * by requestId — a later join; this is the one receipt the offer record itself holds.) */
  confirmTx?: string;
  /** step 4 — the agency UNLOCK state for a COMMISSION line (absent on a VRX-fee line, whose unlock is
   * the §3b clock). `payable` = both unlock legs met (signed S&P + paid ≥ threshold) so the developer owes
   * the agency now; `payableReason` explains WHY it is / isn't payable yet (enum). A prospective
   * (unconfirmed) deal is never payable — the gate only runs once the sale is confirmed. */
  payable?: boolean;
  payableReason?: PayableReason;
  /** % of the unit price the customer must have paid to meet the unlock's %-leg (the resolved threshold). */
  unlockPct?: number;
  /** USD the customer must have paid to meet the %-leg (price × unlockPct%). */
  thresholdUsd?: number;
  /** Σ of the customer's CONFIRMED payments to the developer for this deal (the gate's safe default basis). */
  paidToDateUsd?: number;
  /** §3b — the VRX-clock state for a VRX-FEE line (absent on an agency-commission line, whose unlock is
   * the §3 %-threshold gate above). `vrxPayable` = the 14-working-day settlement window has closed (or
   * early-settle fired) so the developer owes VRX now; `vrxPayableReason` explains WHY (enum).
   * Resolved only for a CONFIRMED sale (a prospective booking is never VRX-payable). */
  vrxPayable?: boolean;
  vrxPayableReason?: VrxPayableReason;
  /** ms epoch the VRX fee becomes due (exit + reversal window + working-day settlement window). Absent when
   * no exit is recorded for the unit. Lets a surface show "due in N working days" without recomputing. */
  vrxDueAt?: number;
};

/** One developer→agency commission line in the settlement view. `deals` = the bookings rolled into it. */
export type AgencyLine = { developer: string; agency: string; deals: DealLine[] } & Balance;
/** One developer→VRX protocol-fee line. `deals` carries the per-deal fee (amountUsd/pct = the FEE, not the
 * commission) so the VRX line is auditable the same way. */
export type VrxLine = { developer: string; deals: DealLine[] } & Balance;

export type Settlement = {
  /** developer→agency commission owed, one line per (developer, agency) pair. */
  byAgency: AgencyLine[];
  /** developer→VRX protocol fee owed, one line per developer. */
  byVrx: VrxLine[];
  /** Grand totals across every line (commission + VRX fee kept separate). */
  totals: {
    commission: Balance;
    vrxFee: Balance;
  };
};

/** Roll one deal's amount into a balance. `payable` ( step 4) = this confirmed deal has passed the agency
 * unlock gate, so its amount also counts toward `payableUsd` (a subset of accrued). Prospective deals are
 * never payable (no confirmed sale yet). Ignored for the VRX line (its gate is the §3b clock, not built). */
function addInto(b: Balance, confirmed: boolean, amountUsd: number, payable = false) {
  if (confirmed) {
    b.accruedUsd += amountUsd;
    b.saleCount += 1;
    if (payable) b.payableUsd += amountUsd;
  } else {
    b.prospectiveUsd += amountUsd;
  }
  // outstanding = accrued − settled (settled is 0 until the TAKE rail; kept in the arithmetic for when it isn't).
  b.outstandingUsd = b.accruedUsd - b.settledUsd;
}

/**
 * Roll every known booking up into the settlement view: developer→agency commission and developer→VRX
 * protocol fee, each split into accrued (confirmed) vs prospective (not-yet-confirmed). Pure read over
 * allOffers — the single rollup the developer + agency dashboards (next session) and the demo both consume.
 * Deterministic order (sorted keys) so output is stable/diffable.
 */
export async function settlementRollup(): Promise<Settlement> {
  const offers = await allOffers();
  const agencyMap = new Map<string, AgencyLine>(); // key `${developer}|${agency}`
  const vrxMap = new Map<string, VrxLine>(); // key developer
  const totalsCommission = emptyBalance();
  const totalsVrx = emptyBalance();

  for (const offer of offers) {
    const c = await explainSaleCommission(offer);
    const commission: SaleCommission | null = c.commission;
    if (!commission) continue; // no facilitated-sale money to settle for this booking
    const confirmed = c.reason === "earned";
    const developer = offer.developer.trim();

    const kind: DealLine["kind"] = confirmed ? "earned" : "prospective";
    const buildingId = offer.display?.buildingId;
    const unitId = offer.display?.unitId;

    // step 4 — resolve the AGENCY unlock gate for a CONFIRMED sale: has the customer paid enough AND is
    // the S&P signed? Only confirmed deals can be payable (a prospective booking isn't a sale yet). `signed`
    // = the deal's S&P stage reached "signed" (offers.ts stage machine). `paidToDate` counts CONFIRMED
    // payments only (the gate's safe default, §4b) — a disputed/unconfirmed slip doesn't unlock the payout.
    let payable = false;
    let payableReason: PayableReason | undefined;
    let unlockPct: number | undefined;
    let thresholdUsd: number | undefined;
    let paidToDateUsd: number | undefined;
    if (confirmed) {
      const payments = await paymentsForRequest(developer, offer.requestId);
      const paid = paidToDate(payments, true); // confirmedOnly — the agency-gate safe default
      const status = resolvePayable(
        commission,
        c.clause ?? {},
        c.plan ?? { priceUsd: commission.priceUsd },
        { paidToDateUsd: paid, signed: contractStage(offer) === "signed" }
      );
      payable = status.payable;
      payableReason = status.reason;
      unlockPct = status.unlockPct;
      thresholdUsd = status.thresholdUsd;
      paidToDateUsd = status.paidToDateUsd;
    }

    // developer→agency commission line
    const aKey = `${developer.toLowerCase()}|${commission.agency.toLowerCase()}`;
    let aLine = agencyMap.get(aKey);
    if (!aLine) {
      aLine = { developer, agency: commission.agency, deals: [], ...emptyBalance() };
      agencyMap.set(aKey, aLine);
    }
    addInto(aLine, confirmed, commission.amountUsd, payable);
    addInto(totalsCommission, confirmed, commission.amountUsd, payable);
    aLine.deals.push({
      requestId: offer.requestId,
      buildingId,
      unitId,
      priceUsd: commission.priceUsd,
      pct: commission.pct,
      amountUsd: commission.amountUsd,
      kind,
      agency: commission.agency,
      at: offer.at,
      confirmTx: offer.confirmed?.tx,
      payable,
      payableReason,
      unlockPct,
      thresholdUsd,
      paidToDateUsd,
    });

    // developer→VRX protocol-fee line (resolved via the same gate → reuse the resolved price).
    // H1: a CONFIRMED sale uses the FROZEN fee rate from its obligation snapshot (immune to a later
    // rate change / agreement revoke); prospective + legacy snapshot-less deals use the live rate.
    const frozenFeePct = offer.confirmed && offer.obligation ? offer.obligation.feePct : undefined;
    const dev = await getDeveloper(developer);
    const pct = typeof frozenFeePct === "number" ? frozenFeePct : protocolFeePct(dev);
    const feeUsd = Math.round((commission.priceUsd * pct) / 100);

    // §3b — the VRX unlock CLOCK (distinct from the agency %-gate): the fee graduates accrued → payable
    // 14 working days after the unit left `available` (per-developer window). Resolved only for a CONFIRMED
    // sale, and only when we know the unit (the clock anchor comes from the status-ledger, keyed by unit).
    // Best-effort per the ledger-seam limitation (a fast bounce can be invisible) — honest, documented there.
    let vrxPayable = false;
    let vrxPayableReason: VrxPayableReason | undefined;
    let vrxDueAt: number | undefined;
    if (confirmed && buildingId && unitId) {
      const leftAt = await leftAvailableAt(buildingId, unitId);
      const clock = resolveVrxClock({
        leftAvailableAt: leftAt,
        settleWorkingDays: vrxSettleWorkingDays(dev),
        // early-settle is a willingness we resolve conservatively here: deposit-in + signed S&P. The variance
        // engine's finer "one more payment" signal can refine this later; a signed-and-deposited deal is a
        // safe, honest early-settle trigger that never pays BEFORE money + signature are in.
        earlySettleReady: contractStage(offer) === "signed",
      });
      vrxPayable = clock.payable;
      vrxPayableReason = clock.reason;
      vrxDueAt = clock.dueAt;
    }

    const vKey = developer.toLowerCase();
    let vLine = vrxMap.get(vKey);
    if (!vLine) {
      vLine = { developer, deals: [], ...emptyBalance() };
      vrxMap.set(vKey, vLine);
    }
    addInto(vLine, confirmed, feeUsd, vrxPayable);
    addInto(totalsVrx, confirmed, feeUsd, vrxPayable);
    vLine.deals.push({
      requestId: offer.requestId,
      buildingId,
      unitId,
      priceUsd: commission.priceUsd,
      pct, // the FEE rate here (not the commission rate)
      amountUsd: feeUsd, // the FEE amount
      kind,
      agency: commission.agency,
      at: offer.at,
      confirmTx: offer.confirmed?.tx,
      vrxPayable,
      vrxPayableReason,
      vrxDueAt,
    });
  }

  // Deterministic deal order within each line: earned (closed sales) before prospective, then newest first —
  // so the audit list reads "what you've really earned" at the top, previews below. Diffable/stable.
  const sortDeals = (d: DealLine[]) =>
    d.sort((x, y) => (x.kind === y.kind ? y.at - x.at : x.kind === "earned" ? -1 : 1));
  const byAgency = [...agencyMap.values()].sort(
    (x, y) => x.developer.localeCompare(y.developer) || x.agency.localeCompare(y.agency)
  );
  const byVrx = [...vrxMap.values()].sort((x, y) => x.developer.localeCompare(y.developer));
  for (const l of byAgency) sortDeals(l.deals);
  for (const l of byVrx) sortDeals(l.deals);
  return { byAgency, byVrx, totals: { commission: totalsCommission, vrxFee: totalsVrx } };
}

// ── Per-account projection (the /api/settlement read surface's logic) ────────────────────────────────────
// Lives here (not in the route) because a Next.js route module may only export route handlers + its fixed
// config — a route can't export helpers/types. Keeping it beside settlementRollup also keeps the shapes in
// one place. Pure over a Settlement; unit-tested directly (settlement-projection.test).

/** The shape returned for a developer: everything this developer owes (agencies + VRX). */
export type DeveloperSettlement = {
  role: "developer";
  account: string;
  owesAgencies: AgencyLine[];
  owesVrx: VrxLine | null;
  totals: Settlement["totals"];
};
/** The shape returned for an agency: everything this agency is owed (commission only — no VRX fee). */
export type AgencySettlement = {
  role: "agency";
  account: string;
  owedBy: AgencyLine[];
  totals: { commission: Settlement["totals"]["commission"] };
};

/** Project the full rollup down to ONE account's slice. `role` decides which direction of the who-owes-whom
 * view the account sees (developer = what I owe; agency = what I'm owed). Case-insensitive account match. */
export function projectForAccount(
  rollup: Settlement,
  account: string,
  role: "developer" | "agency"
): DeveloperSettlement | AgencySettlement {
  const acct = account.trim().toLowerCase();
  if (role === "developer") {
    const owesAgencies = rollup.byAgency.filter((l) => l.developer.toLowerCase() === acct);
    const owesVrx = rollup.byVrx.find((l) => l.developer.toLowerCase() === acct) ?? null;
    // Totals are scoped to THIS developer's lines (not the grand totals, which span all developers).
    const totals = {
      commission: sumBalance(owesAgencies),
      vrxFee: owesVrx ? pickBalance(owesVrx) : emptyBalance(),
    };
    return { role, account, owesAgencies, owesVrx, totals };
  }
  const owedBy = rollup.byAgency.filter((l) => l.agency.toLowerCase() === acct);
  return { role, account, owedBy, totals: { commission: sumBalance(owedBy) } };
}

function pickBalance(l: Balance): Balance {
  return { accruedUsd: l.accruedUsd, prospectiveUsd: l.prospectiveUsd, payableUsd: l.payableUsd, settledUsd: l.settledUsd, outstandingUsd: l.outstandingUsd, saleCount: l.saleCount };
}
function sumBalance(lines: Balance[]): Balance {
  const t = emptyBalance();
  for (const l of lines) {
    t.accruedUsd += l.accruedUsd;
    t.prospectiveUsd += l.prospectiveUsd;
    t.payableUsd += l.payableUsd;
    t.settledUsd += l.settledUsd;
    t.saleCount += l.saleCount;
  }
  t.outstandingUsd = t.accruedUsd - t.settledUsd;
  return t;
}
