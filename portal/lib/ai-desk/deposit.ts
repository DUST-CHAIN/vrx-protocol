// AI Sales Director — the DEPOSIT / RECEIPT flow (slice 6, the design docs §5). SERVER-ONLY.
// The money half of a deal the AI runs end-to-end. The memo's rule (DON'T INVENT): "the customer pays $VRX → the
// agent validates the deposit RECEIPT + files it." So this mirrors the REAL customer→developer payment seam
// (lib/payment-vault.logPayment / paidToDate) exactly — it does NOT fake a confirmation. The AI FILES the
// developer-side "received" attestation against the deal, then READS BACK the two-sided state so it can tell the
// customer honestly where the deposit stands.
//
// ── Why payment-vault, not a new store (the scan-for-the-pattern rule) ──────────────────────────────────
// payment-vault.ts is the one genuinely-new store the payment ledger needed; everything else is computation over
// it. A deposit the AI files is the Nth consumer of that same spine — developer-owned, unit-keyed, sealed,
// two-rail. We reuse it verbatim. The $VRX in-app settlement rail is frozen (payment-vault rail "in_app" is
// design-now/build-later), so a demo deposit rides the OFFLINE rail — identical to what the human desk does today
// (api/direct-deposits records off-chain + attaches the signed hold tx). No parallel ledger.
//
// ── Gating ──────────────────────────────────────────────────────────────────────────────────────────────
// The matrix gates the `deposit` category (deny until the deposit phase). A deposit presupposes a HELD unit (you
// don't take a reservation deposit on a unit you haven't held), so the tool requires the deal to have an active
// soft-hold. The amount is validated (positive, finite) — never seal a nonsense figure.
//
// PRIVACY: server-only. The amount is a B2B developer↔customer figure (off-chain, sealed, never on-chain,
// never on the buyer's S&P copy). The tool returns to the model only the plain STATE (recorded / confirmed /
// none), never the raw amount back out — the AI confirms "your deposit is recorded", it doesn't re-quote figures.

import { logPayment, paymentsForRequest, paidToDate, isValidAmount, type PaymentMethod } from "../payment-vault";
import { can } from "./permissions";
import { activeHoldForDeal } from "./unit-holds";
import { upsertSidecar } from "./deal-sidecar";
import { deskDeveloperFor } from "../conversations-direct";
import type { ActionScope } from "./open-unit";

/** What the model supplies to file a deposit. The unit is taken from the deal's active hold (the model can't
 *  deposit against a unit the deal isn't holding); the amount is the reservation deposit figure. */
export type DepositArgs = {
  amountUsd: number;
  method?: PaymentMethod;
  /** Optional buyer account (for the buyer-scoped confirm surface) — the loop passes it from the deal context. */
  buyer?: string;
};

export type DepositOutcome =
  | { ok: true; outcome: "recorded"; unitId: string; confirmed: boolean }
  | { ok: false; outcome: "denied"; reason: "matrix" | "no_hold" | "bad_amount" | "no_desk" };

/**
 * File a reservation-deposit attestation for a deal (the developer-side "received" record), then read back
 * whether the deal's deposit is confirmed. Mirrors logPayment + paidToDate — the honest real seam, not a faked
 * confirmation. Gates: the matrix `deposit` category (deny before the deposit phase) + a live hold must exist
 * (the unit comes from it) + a valid amount. Advances the sidecar to the deposit phase. Returns the plain state.
 *
 * `confirmed` reflects the REAL rule: an offline-rail deposit is "pending" until the buyer confirms it
 * (payment-vault Rail B), so a freshly-filed deposit is recorded-but-not-yet-confirmed — the AI tells the
 * customer "recorded, we'll confirm once settled," never "paid ✓" prematurely. (A future in-app $VRX rail would
 * be self-proving → confirmed on create; the seam is ready for it.)
 */
export async function recordDeposit(scope: ActionScope, args: DepositArgs): Promise<DepositOutcome> {
  // Gate 1 — the matrix (deposit category; deny before the deposit phase).
  if (can(scope.persona, scope.phase, "deposit") !== "allow") {
    return { ok: false, outcome: "denied", reason: "matrix" };
  }

  // Gate 2 — a valid amount.
  if (!isValidAmount(args.amountUsd)) return { ok: false, outcome: "denied", reason: "bad_amount" };

  // Gate 3 — the deal must be holding a unit (you deposit on a held unit, not a phantom).
  const hold = await activeHoldForDeal(scope.dealId);
  if (!hold) return { ok: false, outcome: "denied", reason: "no_hold" };

  const desk = await deskDeveloperFor(scope.buildingId);
  if (!desk) return { ok: false, outcome: "denied", reason: "no_desk" };

  // File the developer-side "received" attestation over the real payment-vault spine (offline rail — the demo
  // $VRX in-app rail is frozen). Keyed to the deal via requestId = the dealId (the deal's conversation id), so
  // paymentsForRequest can read it back. No evidence slip in the AI path (the desk attaches one in the human UI).
  await logPayment({
    developer: desk,
    buildingId: scope.buildingId,
    unitId: hold.unitId,
    requestId: scope.dealId,
    buyer: args.buyer?.trim() || undefined,
    amountUsd: args.amountUsd,
    paidAt: Date.now(),
    method: args.method ?? "other",
    rail: "offline", // the demo rail; in_app ($VRX self-proving) is frozen (payment-vault design-now/build-later)
  });

  // Read back the deal's confirmed state (offline → pending until the buyer confirms; never claim "paid" early).
  const records = await paymentsForRequest(desk, scope.dealId);
  const confirmedUsd = paidToDate(records, true); // confirmedOnly: buyer-confirmed + self-proving
  const confirmed = confirmedUsd > 0;

  // Advance the sidecar to the deposit phase (the deal moved forward). The hold fields stay as open_unit set them.
  const counterparty: "buyer" | "agent" = scope.persona === "agent" ? "agent" : "buyer";
  await upsertSidecar(scope.dealId, scope.buildingId, counterparty, { phase: "deposit" });

  return { ok: true, outcome: "recorded", unitId: hold.unitId, confirmed };
}
