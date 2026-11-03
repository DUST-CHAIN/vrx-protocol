// OFFER-ELIGIBILITY — the BAR (§9 step 5 / §3). SERVER-ONLY. The single gate that answers "may this
// direct buyer make an offer / proceed to a deposit?". Three conditions, ALL required:
//
//   1. profileSaved  — the buyer has saved a direct-buyer profile at all.
//   2. kyc           — the KYC precondition (profile saved ∧ legalName ∧ nationality ∧ phone — lib/buyers-direct).
//   3. balance       — the buyer's live $VRX balance ≥ the per-developer threshold (§8-4), a "serious buyer"
//                      filter so the desk isn't flooded by tyre-kickers once units are opened.
//
// ── Why the balance read is -safe ───────────────────────────────────────────────────────────────
// The balance is the buyer's $VRX ledger balance (lib/vrx-token.balanceOf) — a pure in-process read, no
// signing, no key, no RPC. Only SIGNING (the deposit itself, step 9) is the deferred piece. A
// never-funded account reads as 0 → fails the condition CLOSED, never a spurious pass.
//
// ── Why $VRX, not NEAR (fix — THE booking-blocker) ───────────────────────────────────────────────
// $VRX is the in-system currency a buyer actually pays deposits/installments with — the airdrop/
// claim funds it, the wallet spends it. The old gate read the buyer's on-chain NEAR balance instead, which
// the faucet only tops to ~0.1 NEAR (gas) — so a buyer holding 75,000 $VRX still failed even the $1 bar and
// COULD NEVER BOOK. The bar now measures the money the deposit is actually paid in. $VRX is pegged 1:1 to USD
// for display (vrx-token.ts), so the integer $VRX balance IS the USD figure — no rate conversion needed.
//
// ── Structured reasons (not just a boolean) ──────────────────────────────────────────────────────────
// Returns WHICH conditions are met so the buyer UI can say "complete your profile" / "top up your wallet"
// and the desk can see exactly what's blocking a buyer. The funnel STATE label (lib/buyers-direct) is the
// operator's view; THIS is the live lock the deposit respects — a buyer the desk marked `offer_eligible`
// still can't deposit if their balance later dropped below the bar (re-checked here every time).

import { balanceOf } from "./vrx-token";
import { getBuyerDirect, kycPrecondition, readinessFor, type BuyerDirect } from "./buyers-direct";
import { getDeveloper, directSaleThresholdUsd, type Developer } from "./developers";
import { USD_PER_NEAR } from "./near-rate";

/** Static demo USD value of 1 NEAR — re-exported from the shared single-source lib/near-rate (audit:
 *  collapsed with lib/currency.ts's NEAR rate so the two can't drift). Kept exported here so existing callers
 *  (app/api/settlement/balance, the eligibility test) import it unchanged. The eligibility bar itself no
 * longer uses it (the gate now reads $VRX, which is already USD-denominated 1:1). */
export { USD_PER_NEAR };

export type EligibilityReasons = {
  /** The buyer has saved a profile at all. */
  profileSaved: boolean;
  /** The KYC precondition (profile + required fields). */
  kyc: boolean;
  /** Wallet balance ≥ the developer's threshold. Null = the balance could not be read (RPC outage / caller
   *  did not supply a developer to resolve a threshold) → treated as NOT met (fail closed). */
  balance: boolean;
};

export type Eligibility = {
  /** The bar: ALL of profileSaved ∧ kyc ∧ balance. The one thing the deposit gate checks. */
  eligible: boolean;
  reasons: EligibilityReasons;
  /** The threshold in USD that applied (the developer's or the default) — for display. */
  thresholdUsd: number;
  /** The buyer's available balance in USD at check time, or null if it couldn't be read. For display. */
  balanceUsd: number | null;
};

/**
 * Compute offer-eligibility for a buyer against a specific desk developer's threshold. `developer` scopes
 * WHICH threshold applies (§8-4, per-developer) — pass the building's desk developer account. If the
 * developer can't be resolved, the default threshold is used. A balance read failure (RPC outage, or an
 * absent/never-funded account) fails the balance condition CLOSED — never a false pass.
 */
export async function offerEligibility(account: string, developer: string | Developer | null): Promise<Eligibility> {
  const buyer = await getBuyerDirect(account);
  const dev =
    typeof developer === "string" ? await getDeveloper(developer) : developer ?? null;
  const thresholdUsd = directSaleThresholdUsd(dev);

  const profileSaved = !!buyer?.profileSaved;
  // Per-developer readiness: a developer may require more than the default set. Falls back to the
  // default fields when the developer sets no override, so this is a refinement of the old kycPrecondition.
  // The SEAL requirement is now folded in (Phase 2, the deferred step): an offer needs BOTH the
  // developer's required fields filled AND the profile SEALED (attested + locked). The buyer UI now lets a
  // buyer seal, so this no longer blocks the demo — an unsealed buyer is nudged to seal, not silently stuck.
  const kyc = !!buyer?.sealed && readinessFor(buyer, dev?.requiredProfileFields).met;

  // Balance read — the buyer's $VRX ledger balance. Pure in-process read (no RPC, no key). $VRX is
  // USD-denominated 1:1 (vrx-token.ts), so the integer balance IS the USD figure the threshold compares to.
  // A never-funded account reads 0 → fails the bar CLOSED.
  let balanceUsd: number | null = null;
  let balanceOk = false;
  if (account?.trim()) {
    try {
      balanceUsd = await balanceOf(account.trim());
      balanceOk = balanceUsd >= thresholdUsd;
    } catch {
      balanceUsd = null; // ledger read failed → unknown → fail closed
      balanceOk = false;
    }
  }

  const reasons: EligibilityReasons = { profileSaved, kyc, balance: balanceOk };
  return {
    eligible: profileSaved && kyc && balanceOk,
    reasons,
    thresholdUsd,
    balanceUsd,
  };
}

/** Pure overload for tests / callers that already hold the buyer + a known balance (no RPC). */
export function eligibilityFrom(
  buyer: BuyerDirect | null,
  thresholdUsd: number,
  balanceUsd: number | null
): Eligibility {
  const profileSaved = !!buyer?.profileSaved;
  // Mirrors the live gate: required fields met AND the profile SEALED (Phase 2). kycPrecondition checks
  // only the DEFAULT field set — the pure combiner uses the default (callers that need a per-developer set
  // use the live offerEligibility, which resolves the override).
  const kyc = !!buyer?.sealed && kycPrecondition(buyer);
  const balance = typeof balanceUsd === "number" && balanceUsd >= thresholdUsd;
  return {
    eligible: profileSaved && kyc && balance,
    reasons: { profileSaved, kyc, balance },
    thresholdUsd,
    balanceUsd,
  };
}
