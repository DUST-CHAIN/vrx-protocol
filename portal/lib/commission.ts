// PER-SALE COMMISSION resolver — SERVER-ONLY. Computes the developer↔agency sales commission
// EARNED on a specific booking, from the live agreement's per-building rate × the booked price.
//
// This is the AGENCY's commission — the money the agency/agent earns for the sale. It is distinct
// from: (a) the on-chain per-call protocol FEE/toll, and (b) the VRX protocol sales commission 0.2–0.8%
// off the developer's account (not built). It is B2B money and must NEVER appear on the BUYER's
// S&P — the buyer pays the same price regardless. Surfaced only to the agent (what they earn), the
// developer inbox (what they'll owe), and the agency dashboard (rollup).
//
// Resolution chain: booking → seal.by (agent) → agencyOf(agent) → liveAgreementBetween(developer, agency)
// → the building's commissionPct snapshot → price × pct%. Any missing link = null (no agreement / no rate →
// no commission shown, honestly, rather than a fabricated figure).

import type { Offer, ObligationSnapshot } from "./offers";
import { agencyOf } from "./agents";
import { liveAgreementBetween, type AgreementBuilding } from "./agreements";
import { getBaseline } from "./sale-baseline";
import { getDeveloper, protocolFeePct } from "./developers";

export type SaleCommission = {
  /** The % applied (the building's snapshot in the live agreement). */
  pct: number;
  /** The booked price the % is applied to (USD). */
  priceUsd: number;
  /** The commission earned (USD), rounded. */
  amountUsd: number;
  /** The agency that earns it + the agent who sold. */
  agency: string;
  agent: string;
  /** The agreement id the rate came from (audit trail). */
  agreementId: string;
};

// The reason enum + plain-words copy live in the CLIENT-SAFE sibling (lib/commission-reason.ts) so the UI can
// import them without dragging this server-only module's fs-backed stores into the client bundle. Re-exported
// here for the server routes' convenience (single import site).
export { commissionReasonCopy } from "./commission-reason";
export type { CommissionReason } from "./commission-reason";
import type { CommissionReason } from "./commission-reason";

/** The full explained result: the value (or null) + WHY, plus the baseline date when the reason turns on it. */
export type CommissionResult = {
  commission: SaleCommission | null;
  reason: CommissionReason;
  /** ms epoch of the developer+building baseline, when the reason references it (`before_baseline`). For copy
   *  like "this sale closed before VRX began tracking this building on <date>". */
  baselineAt?: number;
  /**
 * step 4 — the resolved building CLAUSE this sale's commission came from (the same `AgreementBuilding`
   * `commissionPct` was read off). Carried so the payment-ledger unlock gate (`resolvePayable`) can read the
   * clause's `unlockPct`/`unlockOnSigning` WITHOUT re-resolving the agreement. Present only when a `commission`
   * resolved (same gate), absent otherwise. Additive — existing readers ignore it.
   */
  clause?: Pick<AgreementBuilding, "unlockPct" | "unlockOnSigning">;
  /**
 * step 4 — the sealed plan figures needed for the unlock gate's LEGACY deposit% fallback
   * (`resolveUnlockPct`): the booked price + deposit. Read defensively from `offer.seal.plan`. Present only
   * when a `commission` resolved. Additive.
   */
  plan?: { priceUsd?: number; depositUsd?: number };
};

/**
 * Resolve the per-sale commission for a booking, or null if it can't be computed (no agent, no agency, no live
 * agreement, no rate for this building, no price, or the sale falls OUTSIDE the commission BASELINE for this
 * developer+building). Pure read — never mutates. The caller decides WHO may see the result (agent/developer/
 * agency only; never the buyer).
 *
 * THE COMMISSION-CLOCK GATE (resolving the deferred wiring): a sale only earns commission if it
 * lands AT-OR-AFTER the developer+building's established baseline ("count from that day on"). The gate is
 * DATE-ONLY: it does NOT require the unit to have been in the baseline's `availableUnits` slate.
 * This is the DELIBERATE guarantee that **units a developer adds AFTER the baseline are never lost from our
 * commission view** — any sale on a newly-added unit still satisfies `saleAt >= baselineAt`, so its commission
 * counts automatically, with no re-baseline needed. (The slate is a record of what was open that day, not a
 * filter on what earns.) Fail-closed cases that yield null: no baseline established yet, or a sale dated BEFORE
 * the baseline.
 *
 * Sale time = `confirmed.at` (the on-chain booking confirmation = the moment it became a real sale). A booking
 * not yet confirmed has no sale time → it is PROSPECTIVE, not a closed sale, so the baseline gate does not apply
 * yet (we still surface the prospective commission so the agent/developer see what it WILL be); the gate bites
 * once the sale is confirmed.
 */
export async function resolveSaleCommission(offer: Offer): Promise<SaleCommission | null> {
  return (await explainSaleCommission(offer)).commission;
}

/**
 * The EXPLAINED resolve (H2 fix). Same gate logic as `resolveSaleCommission` — but instead of collapsing
 * every failure to a bare `null`, it returns the distinct REASON so a surface can say WHY ("sale predates the
 * VRX baseline of <date>", "no agreement", "no baseline yet") rather than a silent blank. `resolveSaleCommission`
 * is a thin wrapper over this (one source of truth for the gate).
 *
 * Reason precedence mirrors the resolution chain, so the reason names the FIRST missing link in order: basics →
 * baseline/date gate → agency → agreement → rate. (If both a baseline and an agreement were missing, we report
 * the baseline — it's the earlier link and the more fundamental "relationship hasn't started" signal.)
 */
export async function explainSaleCommission(offer: Offer): Promise<CommissionResult> {
  // H1 — a CONFIRMED sale with a FROZEN obligation snapshot is authoritative: the debt crystallised
  // close, so we read the snapshot and NEVER re-resolve the (mutable) live agreement. This is what stops a
  // later agreement revoke/expiry from erasing commission + VRX fee that was genuinely earned. A prospective
  // (unconfirmed) booking has no snapshot → falls through to live resolution (a preview of the CURRENT
  // relationship, correctly). A legacy confirmed offer with no snapshot also falls through (history unchanged).
  const frozen = offer.obligation;
  if (frozen && offer.confirmed) {
    return commissionResultFromSnapshot(offer, frozen);
  }

  const agent = offer.seal.by?.trim();
  const developer = offer.developer?.trim();
  const buildingId = offer.display.buildingId?.trim();
  // `seal.plan` is typed `unknown | null` (it's the verbatim hashed object); read figures defensively.
  const rawPlan = (offer.seal.plan && typeof offer.seal.plan === "object" ? offer.seal.plan : {}) as {
    priceUsd?: unknown;
    depositUsd?: unknown;
  };
  const priceUsd = typeof rawPlan.priceUsd === "number" ? rawPlan.priceUsd : 0;
  // The subset the payment-ledger unlock gate needs (price + deposit) — the legacy unlockPct fallback.
  const plan = {
    priceUsd,
    depositUsd: typeof rawPlan.depositUsd === "number" ? rawPlan.depositUsd : undefined,
  };
  if (!agent || !developer || !buildingId || priceUsd <= 0) return { commission: null, reason: "incomplete" };

  // COMMISSION-CLOCK GATE (date-only). A CONFIRMED sale must fall at-or-after the baseline, else no commission
  // is earned (the relationship's clock hadn't started). A not-yet-confirmed booking is prospective: skip the
  // date gate but still require a baseline to EXIST (no established relationship → nothing to earn against).
  const saleAt = typeof offer.confirmed?.at === "number" ? offer.confirmed.at : null;
  const baseline = await getBaseline(developer, buildingId);
  const confirmed = saleAt !== null;
  if (!baseline) return { commission: null, reason: "no_baseline" };
  if (confirmed && !(saleAt >= baseline.establishedAt)) {
    return { commission: null, reason: "before_baseline", baselineAt: baseline.establishedAt };
  }

  const agency = await agencyOf(agent);
  if (!agency) return { commission: null, reason: "no_agreement" };

  const agreement = await liveAgreementBetween(developer, agency);
  if (!agreement) return { commission: null, reason: "no_agreement" };

  const clause = agreement.seal.buildings.find((b) => b.buildingId === buildingId);
  if (!clause || !(clause.commissionPct > 0)) return { commission: null, reason: "no_rate" };

  const commission: SaleCommission = {
    pct: clause.commissionPct,
    priceUsd,
    amountUsd: Math.round((priceUsd * clause.commissionPct) / 100),
    agency,
    agent,
    agreementId: agreement.id,
  };
  // A resolvable figure: EARNED on a closed sale, PROSPECTIVE on a not-yet-confirmed booking. Carry the
  // clause + plan so the payment-ledger unlock gate (step 4) reads them without re-resolving the agreement.
  return {
    commission,
    reason: confirmed ? "earned" : "prospective",
    clause: { unlockPct: clause.unlockPct, unlockOnSigning: clause.unlockOnSigning },
    plan,
  };
}

// ── H1 — the obligation-snapshot seam ────────────────────────────────────────────────────────────

/**
 * Reconstruct a full CommissionResult from a FROZEN obligation snapshot (the authoritative read path for a
 * confirmed sale). Returns exactly the shape the live resolve returns for an `earned` deal — same `commission`
 * fields, `reason: "earned"`, and the `clause`/`plan` the payment-ledger unlock gate reads — but sourced from
 * the snapshot, so it is immune to any later agreement change. The amount is RE-DERIVED from the frozen
 * pct × frozen price (not stored) so one rounding rule governs both the live and frozen paths.
 */
function commissionResultFromSnapshot(offer: Offer, s: ObligationSnapshot): CommissionResult {
  const commission: SaleCommission = {
    pct: s.commissionPct,
    priceUsd: s.priceUsd,
    amountUsd: Math.round((s.priceUsd * s.commissionPct) / 100),
    agency: s.agency,
    agent: offer.seal.by?.trim() ?? "",
    agreementId: s.agreementId,
  };
  return {
    commission,
    reason: "earned",
    clause: { unlockPct: s.unlockPct, unlockOnSigning: s.unlockOnSigning },
    plan: { priceUsd: s.priceUsd, depositUsd: s.depositUsd },
  };
}

/**
 * Resolve the obligation snapshot to FREEZE onto an offer at confirmation (H1). Called by the confirm
 * path (and the seed harness) RIGHT BEFORE markConfirmed, while the agreement is still live. Runs the live
 * resolver once + reads the developer's current fee rate, and packages the crystallised debt. Returns
 * undefined when there is nothing to crystallise (no live agreement / no rate at close) — then the offer is
 * confirmed WITHOUT a snapshot and the resolver keeps resolving it live (honest: no facilitated-sale debt).
 *
 * Deliberately resolved from the LIVE agreement at close (not re-read later): this is the single moment the
 * obligation is allowed to be derived from current relationship state — after this it is frozen.
 */
export async function buildObligationSnapshot(offer: Offer): Promise<ObligationSnapshot | undefined> {
  const r = await explainSaleCommission(offer);
  if (!r.commission) return undefined; // nothing facilitated → nothing to crystallise
  const dev = await getDeveloper(offer.developer.trim());
  const feePct = protocolFeePct(dev);
  return {
    agreementId: r.commission.agreementId,
    agency: r.commission.agency,
    commissionPct: r.commission.pct,
    feePct,
    unlockPct: r.clause?.unlockPct,
    unlockOnSigning: r.clause?.unlockOnSigning,
    priceUsd: r.commission.priceUsd,
    depositUsd: r.plan?.depositUsd,
    at: offer.confirmed?.at ?? Date.now(),
  };
}
