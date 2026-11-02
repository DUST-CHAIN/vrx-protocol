// OFFER-ELIGIBILITY — the BAR ( §9 step 5 / §3). SERVER-ONLY. The single gate that answers "may this
// direct buyer make an offer / proceed to a deposit?". Three conditions, ALL required:
// 1. profileSaved — the buyer has saved a direct-buyer profile at all.
// 2. kyc — the KYC precondition (profile saved ∧ legalName ∧ nationality ∧ phone — lib/buyers-direct).
// 3. balance — the buyer's live wallet balance ≥ the per-developer threshold (§8-4), a "serious buyer"
// filter so the desk isn't flooded by tyre-kickers once units are opened.
// Reading a balance is a `view_account` RPC call — NO signing, no key, no transaction. Only SIGNING (the
// chain but never touches it. Uses lib/balance-server.getBalance, which fails over across endpoints and
// THROWS (rather than returning a false 0) on an RPC outage — so an outage fails the gate CLOSED, it never
// spuriously passes a buyer with 0 balance.
// ── Structured reasons (not just a boolean) ──────────────────────────────────────────────────────────
// Returns WHICH conditions are met so the buyer UI can say "complete your profile" / "top up your wallet"
// and the desk can see exactly what's blocking a buyer. The funnel STATE label (lib/buyers-direct) is the
// operator's view; THIS is the live lock the deposit respects — a buyer the desk marked `offer_eligible`
// still can't deposit if their balance later dropped below the bar (re-checked here every time).
// ── USD↔NEAR ─────────────────────────────────────────────────────────────────────────────────────────
// The threshold is a USD figure; balances are in NEAR. We convert with a STATIC demo rate consistent with
// lib/currency.ts (NEAR listed at 0.2 per USD → 1 NEAR = $5). A static rate keeps the bar stable + auditable
// during a walkthrough (same rationale as the display-currency layer); a live feed can slot in later behind
// this one function without changing the gate.

import { getBalance } from "./balance-server";
import { getBuyerDirect, kycPrecondition, readinessFor, type BuyerDirect } from "./buyers-direct";
import { getDeveloper, directSaleThresholdUsd, type Developer } from "./developers";
import { USD_PER_NEAR } from "./near-rate";

/** Static demo USD value of 1 NEAR — re-exported from the shared single-source lib/near-rate (audit:
 * collapsed with lib/currency.ts's NEAR rate so the two can't drift). Kept exported here so existing callers
 * (app/api/settlement/balance, the eligibility test) import it unchanged. */
export { USD_PER_NEAR };

export type EligibilityReasons = {
  /** The buyer has saved a profile at all. */
  profileSaved: boolean;
  /** The KYC precondition (profile + required fields). */
  kyc: boolean;
  /** Wallet balance ≥ the developer's threshold. Null = the balance could not be read (RPC outage / caller
   * did not supply a developer to resolve a threshold) → treated as NOT met (fail closed). */
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

  // THROWS on an RPC outage; both fail the condition closed.
  let balanceUsd: number | null = null;
  let balanceOk = false;
  if (account?.trim()) {
    try {
      const bal = await getBalance(account.trim());
      if (bal) {
        balanceUsd = bal.availableNear * USD_PER_NEAR;
        balanceOk = balanceUsd >= thresholdUsd;
      } else {
        balanceUsd = 0; // account doesn't exist / never funded → $0, below any positive bar
      }
    } catch {
      balanceUsd = null; // RPC outage → unknown → fail closed
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
