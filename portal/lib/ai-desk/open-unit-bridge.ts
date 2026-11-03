// AI Sales Director — the HOLD → DIRECT-DEPOSIT BRIDGE (D-). SERVER-ONLY.
//
// THE GAP it closes (the live-demo finding): the AI desk and the buyer's PAY/CONTRACT rail were two
// SEPARATE lanes that never met. The AI's open_unit placed a SOFT-hold (lib/ai-desk/unit-holds) + the AI's
// record_deposit filed a payment-vault attestation — but NEITHER wrote a `direct-deposits` record. The buyer's
// "Pay deposit with $VRX" button, the `materialize` paperwork, and the S&P contract ALL read `direct-deposits`
// in `held` status, which only the human desk-operator UI (DirectEnquiries.tsx `action:"record"`+`"hold"`) ever
// wrote. So a buyer could chat the AI into a hold and still have NOTHING to pay against. the call (D-):
// BRIDGE them — when the AI holds a unit for a BUYER, mirror it into `direct-deposits` so the whole buyer-facing
// money + contract path lights up automatically after an AI hold, exactly as if a human desk had firm-held.
//
// ── Honest demo posture (+ D-) ───────────────────────────────────────────────────────────────────
// The AI hold is an OFF-CHAIN soft-hold (no key on the server). So the mirrored direct-deposit carries a
// `soft:<dealId>` holdTxHash marker (not a real grant_exclusive tx) — the SAME honesty the signing-seam stub
// uses. Money stays off-chain. The buyer later settles in $VRX (the in_app self-pay rail, D-), which
// is the real debit; this bridge only creates the payable record the hold implies.
//
// ── Gates (mirror the /api/direct-deposits `record` route exactly — never bypass the real locks) ─────────
//   • the buyer must be LIVE offer-eligible (profile ∧ kyc ∧ $VRX balance ≥ threshold) — re-checked here.
//   • the desk must have a house org registered (houseOrgFor) — the firm-hold grantee; fail closed if absent.
// BEST-EFFORT: a bridge failure NEVER fails the AI hold (the soft-hold is the source of truth). A gap just
// means the buyer sees the hold in chat but the pay button doesn't light yet — recoverable, not a broken hold.

import { directParties } from "../conversations-direct";
import { getDeveloper, houseOrgFor } from "../developers";
import { offerEligibility } from "../offer-eligibility";
import { getBuilding, effectiveTerms } from "../catalog";
import { recordDeposit, attachHold, getDeposit } from "../direct-deposits";
import { hashRef } from "../vrx";
import { getSidecar } from "./deal-sidecar";

// The opaque unit reference the on-chain unit_key hashes over. Inlined (not imported from ../catalog-client)
// because that module is CLIENT-only — importing it here threw "Attempted to call unitRef from the server"
// and silently failed the whole bridge (caught live). It's a trivial, stable string: `${building}/${unit}`.
const unitRef = (buildingId: string, unitId: string) => `${buildingId}/${unitId}`;

/** The outcome of a bridge attempt — purely informational (the caller logs it; it never changes the hold). */
export type BridgeResult =
  | { bridged: true; alreadyHeld: boolean }
  | { bridged: false; reason: "not_buyer" | "no_deal" | "no_building" | "not_eligible" | "no_house_org" | "no_deposit_amount" | "error" };

/** The reservation-deposit amount in MINOR units of USD (cents). The buyer rail stores minor units + a currency;
 *  minor = whole-USD × 100. 0 ⇒ no amount set. */
function depositMinorUsd(depositUsd: number | undefined): number {
  const usd = typeof depositUsd === "number" && isFinite(depositUsd) ? Math.max(0, Math.round(depositUsd)) : 0;
  return usd * 100;
}

/** The DEDUCTIBLE reservation deposit for the TEMPLATE path (no composed offer) — the model #1.
 *  The buyer pays a % of the UNIT PRICE (deductible from the price), NOT a flat fee. We take the LOWEST published
 *  deposit % option (the minimum a template buyer would put down) × the unit's price. Falls back to 0 if the unit
 *  or its terms can't be resolved (→ the caller's `amountMinor <= 0` guard fires = no_deposit_amount, a diagnosable
 *  gap, never the old flat-fee charge). Pure. */
function templateDepositUsd(building: import("../catalog").Building, unitId: string): number {
  const unit = building.inventory?.find((u) => u.id === unitId);
  if (!unit || !isFinite(unit.priceUsd) || unit.priceUsd <= 0) return 0;
  const terms = effectiveTerms(building, unit);
  const opts = terms?.depositPct?.filter((p) => typeof p === "number" && isFinite(p) && p > 0) ?? [];
  if (!opts.length) return 0;
  const minPct = Math.min(...opts);
  return Math.round((unit.priceUsd * minPct) / 100);
}

/**
 * Bridge an AI soft-hold into the buyer's direct-deposit rail. Called by open_unit AFTER a successful BUYER hold.
 * Resolves the deal's parties server-side, re-checks the real eligibility + house-org gates, computes the opaque
 * unitKey + the reservation-deposit amount, then records the deposit + attaches the (soft) hold so the buyer's
 * "Pay deposit with $VRX" + materialize + S&P contract path is live. Idempotent: if a held deposit already exists
 * for (buyer, building, unit) it reports alreadyHeld and does nothing. Pure of the LLM; reads catalog/registry +
 * writes the direct-deposits store. NEVER throws — returns a typed reason so the caller can log without breaking.
 */
export async function bridgeHoldToDirectDeposit(opts: {
  dealId: string;
  buildingId: string;
  unitId: string;
  /** The hold window end (ms epoch) — mirrors the soft-hold's releaseAt so the two rails expire together. */
  holdUntilMs: number;
  /** The persona of the party the AI is serving — only a BUYER gets a direct-deposit (agents don't self-buy). */
  persona: "buyer" | "agent" | "agency";
}): Promise<BridgeResult> {
  try {
    if (opts.persona !== "buyer") return { bridged: false, reason: "not_buyer" };

    // Resolve {buyer, building, developer} server-side from the deal (the buyer account never comes from the model).
    const parties = await directParties(opts.dealId);
    if (!parties) return { bridged: false, reason: "no_deal" };

    // Idempotent: a held deposit already backing this unit ⇒ nothing to do (don't double-record).
    const existing = await getDeposit(parties.buyer, opts.buildingId, opts.unitId);
    if (existing && existing.status === "held") return { bridged: true, alreadyHeld: true };

    // Gate A — the building + its deposit figure. if the buyer COMPOSED an offer in the review overlay
    // (agreedPlan on the deal sidecar), its depositUsd is the AGREED deposit → use THAT. Falls back to a
    // COMPUTED DEDUCTIBLE DEPOSIT when there's no composed offer (the template path).
    //  (the model #1): the buyer pays a reservation DEPOSIT (a % of the unit price, deductible from the
    // price) — NOT the flat reservationFee/bookingDeposit (that's VRX/developer-side economics, never a buyer
    // charge). So the no-plan fallback is `depositPct × unit price` (the lowest published deposit option — the
    // minimum a template buyer would put down), NOT building.bookingDepositUsd. A deposit of 0 in the agreed plan
    // is implausible for a reservation, so we still fall back if the agreed deposit rounds to 0.
    const building = await getBuilding(opts.buildingId);
    if (!building) return { bridged: false, reason: "no_building" };
    const sidecar = await getSidecar(opts.dealId);
    const agreedDepositUsd = sidecar?.agreedPlan?.depositUsd;
    const depositUsd =
      typeof agreedDepositUsd === "number" && isFinite(agreedDepositUsd) && agreedDepositUsd > 0
        ? agreedDepositUsd
        : templateDepositUsd(building, opts.unitId);
    const amountMinor = depositMinorUsd(depositUsd);
    if (amountMinor <= 0) return { bridged: false, reason: "no_deposit_amount" };

    // Gate B — the buyer must be LIVE offer-eligible (the same lock the operator `record` route enforces).
    const dev = await getDeveloper(parties.developer);
    const elig = await offerEligibility(parties.buyer, dev);
    if (!elig.eligible) return { bridged: false, reason: "not_eligible" };

    // Gate C — the desk must have a house org (the firm-hold grantee). Fail closed if the desk hasn't set one.
    const houseOrg = houseOrgFor(dev);
    if (!houseOrg) return { bridged: false, reason: "no_house_org" };

    // The opaque on-chain unit_key (same derivation the human firm-hold uses — hashRef(unitRef,"vrx-unit")).
    const unitKey = await hashRef(unitRef(opts.buildingId, opts.unitId), "vrx-unit");

    // Record the deposit (USD), then attach the SOFT hold so status → held (the buyer can now pay).
    const rec = await recordDeposit({
      buyer: parties.buyer,
      building: opts.buildingId,
      unit: opts.unitId,
      unitKey,
      by: parties.developer,
      amountMinor,
      currency: "USD",
    });
    if (!rec) return { bridged: false, reason: "error" };

    // holdUntil unit convention: the OPERATOR hold path (app/node) stores it in NANOSECONDS
    // (`Date.now*1e6 + windowNs`), and the buyer card reads it back as `holdUntil / 1e6 > Date.now`. The
    // bridge was writing MILLISECONDS, so the card's /1e6 made it tiny → the hold always read as expired → the
    // "✓ Reserved" badge + "Pay deposit with $VRX" button never appeared after an AI hold (caught live). Write
    // nanoseconds to match the operator convention so the card lights up uniformly regardless of who held it.
    const untilMs = Number.isFinite(opts.holdUntilMs) && opts.holdUntilMs > 0 ? Math.round(opts.holdUntilMs) : Date.now() + 2 * 60 * 60 * 1000;
    const until = untilMs * 1e6; // → nanoseconds (operator-path convention; the card divides by 1e6 to compare)
    const held = await attachHold(parties.buyer, opts.buildingId, opts.unitId, `soft:${opts.dealId}`, until);
    if (!held) return { bridged: false, reason: "error" };

    return { bridged: true, alreadyHeld: false };
  } catch (e) {
    // Best-effort: the hold stands regardless. Log the gap so a silent bridge failure (like the client-
    // import bug) is diagnosable instead of invisible — a buyer holding a unit with no payable deposit is a bug.
    console.warn("[vrx][bridge] failed to mirror hold → direct-deposit:", (e as Error)?.message ?? String(e));
    return { bridged: false, reason: "error" };
  }
}
