// PAY-DEPOSIT — the ONE server-side money path for settling a direct-sale deposit in $VRX (Slice 4).
// SERVER-ONLY. Extracted so BOTH entry points run the identical business logic (the spine invariant —
// [[vrx-demo-vs-real-shared-path-audit]]): the buyer's held-unit CARD (/api/direct-deposits action:"pay-vrx")
// and the in-chat PAY chip (/api/desk-action buttonKind:"pay_deposit"). A button is a UI/transport seam; the
// executor is one path, so a fix lands once and applies to the real on-chain lane too.
//
// WHO GETS THE MONEY ("the buyer is paying the DEVELOPER, not the VRX treasury"): the deposit is
// money-layer #1 (buyer→dev reservation deposit, deductible from price — [[vrx-three-money-layers]]), so the
// $VRX moves buyer → the developer who recorded the deposit (`dep.by`, their own wallet). Treasury-as-sink was
// a demo shortcut that contradicted the demo→real one-path bet; on real rails the developer must hold the
// deposit, so the demo moves it the same way now. Fail-safe: if a developer has no distinct account to receive
// it, fall back to the treasury sink rather than refuse the buyer (honest degradation, never a lost payment).
//
// ── The authz seam (split, D- pt2) ───────────────────────────────────────────────────────────
// This function does NOT authorize — it assumes the CALLER already proved the payer is the deposit's buyer
// (both routes do this via requireCaller before calling here). That is deliberate: the authorization is the
// part that RELOCATES at V5. Today the money-move is an off-chain ledger `transfer` authorized by the proven
// session (send-from-your-own-wallet, the posture). At V5 the SAME move becomes a signed on-chain
// $VRX transfer — only the transport + the authz change (a signature replaces the session check); this
// orchestration (FX, sufficiency, idempotency, record, materialize) stays identical. Keep that seam clean:
// never fold a session/cookie check in here, and never move the recipient decision out — both are stable.
//
// IDEMPOTENT: a second call for an already-$VRX-paid deposit returns { alreadyPaid:true } with NO second debit
// (so the card and the chip can both be tapped safely — whichever fires first settles, the other no-ops).

import { getDeposit, markPaidVrx, type DirectDeposit } from "./direct-deposits";
import { deskDeveloperFor, directConversationId } from "./conversations-direct";
import { materializeDirectOffer } from "./direct-offer";
import { spend, transfer, balanceOf } from "./vrx-token";
import { logPayment } from "./payment-vault";
import { minorToUsd } from "./fx";
import { publish } from "./bus";
import { grantTopic } from "./grant-topic";
import { fundCustody, escrowCustodyActive } from "./escrow/deposit-custody";

export type PayDepositResult =
  | { ok: true; alreadyPaid: true; deposit: DirectDeposit }
  | { ok: true; alreadyPaid: false; deposit: DirectDeposit; amountVrx: number; balanceVrx: number; paidTo: string }
  | { ok: false; status: 404 | 409; error: string; balanceVrx?: number; amountVrx?: number };

/**
 * Settle buyer `account`'s deposit on (building, unit) in $VRX, paying the DEVELOPER. The CALLER must have
 * already proven `account` is the acting buyer (this function trusts that — see the authz-seam note above).
 * Returns a structured result the route maps to an HTTP status; never throws for an expected money condition
 * (missing deposit / unpayable amount / insufficient balance) — those are typed failures.
 */
export async function payDepositVrx(account: string, building: string, unit: string): Promise<PayDepositResult> {
  const dep = await getDeposit(account, building, unit);
  if (!dep) return { ok: false, status: 404, error: "no deposit to pay (the desk records it first)" };
  if (dep.paidVrx) {
    // Idempotent: already paid in $VRX → no second debit. Return the record so the UI settles cleanly.
    return { ok: true, alreadyPaid: true, deposit: dep };
  }

  // Convert the stored (amountMinor, currency) → whole USD (= $VRX, 1:1 display convention). Server-side FX
  // (never a client-sent figure for a money charge). A zero/garbage figure is refused rather than charged.
  const amountVrx = minorToUsd(dep.amountMinor, dep.currency);
  if (amountVrx <= 0) return { ok: false, status: 409, error: "deposit amount is not payable" };

  // Sufficiency pre-check for a clean result (the debit also throws on insufficient — belt-and-suspenders).
  const bal = await balanceOf(account);
  if (bal < amountVrx) {
    return { ok: false, status: 409, error: "insufficient $VRX balance", balanceVrx: bal, amountVrx };
  }

  // THE RECIPIENT: the developer who recorded the deposit (`dep.by`). Fail-safe to the treasury sink only if
  // there's no distinct developer account (shouldn't happen — a recorded deposit always has a desk `by`).
  const devAccount = typeof dep.by === "string" ? dep.by.trim() : "";
  const payToDev = Boolean(devAccount) && devAccount.toLowerCase() !== account.toLowerCase();
  const directPaidTo = payToDev ? devAccount : "vrx-treasury.vrx";

  // ESCROW SEAM (Slice 2, flag VRX_ESCROW_CUSTODY): when ON, the deposit does NOT land in the developer's
  // wallet at pay time — it moves buyer → the escrow CUSTODY account and is released to the developer later
  // (/api/escrow, dev self-release + buyer veto window). The FSM owns that one money move via the funding
  // adapter. "Funded = paid": everything AFTER this (markPaidVrx / logPayment / materialize /
  // publish) is UNCHANGED — the deposit is still paid, it just lives in custody until released. When OFF, the
  // original direct-to-dev path runs byte-for-byte (the split: prove on the flag, flip later).
  const escrowOn = escrowCustodyActive();
  let newBalance: number;
  let paidTo: string;
  try {
    if (escrowOn) {
      // THE DEBIT (escrow): buyer → the custody account, via the FSM (none → held). fundCustody drives the
      // adapter's transfer; it is idempotent (a re-pay through the custody path no-ops). We re-read the buyer's
      // balance after (the FSM returns the deposit, not the balance). The money is in custody, not the dev's.
      const fc = await fundCustody(account, building, unit, amountVrx);
      if (!fc.ok) {
        // insufficient balance / adapter failure — nothing charged (the adapter throws before any transfer).
        return { ok: false, status: fc.status, error: fc.error };
      }
      newBalance = await balanceOf(account);
      paidTo = "vrx-escrow.vrx"; // the custody account holds it (released to the dev later)
    } else {
      // THE DEBIT (direct, today): buyer → developer (or treasury fallback), the one real money movement. The
      // memo reads clearly in BOTH wallets' history ("deposit on unit …").
      paidTo = directPaidTo;
      if (payToDev) {
        const res = await transfer(account, devAccount, amountVrx, `deposit on unit ${unit}`);
        newBalance = res.fromBalance;
      } else {
        newBalance = await spend(account, amountVrx, `deposit on unit ${unit}`);
      }
    }
  } catch {
    // Lost a race on the balance (another debit drained it between the check and here) → nothing charged.
    return { ok: false, status: 409, error: "insufficient $VRX balance" };
  }

  // File the self-proving in_app payment record against the deal. rail "in_app" → payment-vault marks it
  // buyer-confirmed on create. method "other" with a $VRX note (PaymentMethod has no "vrx" value; the rail +
  // note carry the truth). Best-effort: the debit already happened; a vault hiccup must not swallow the charge.
  try {
    await logPayment({
      developer: dep.by,
      buildingId: building,
      unitId: unit,
      buyer: account,
      amountUsd: amountVrx,
      paidAt: Date.now(),
      method: "other",
      note: "paid in $VRX (in-app self-pay)",
      rail: "in_app",
    });
  } catch {
    /* the money-truth is recorded below; the vault record is best-effort evidence */
  }

  // Stamp the deposit as $VRX-settled (appended provenance; not the seal). Idempotent.
  const settled = await markPaidVrx(account, building, unit, amountVrx);

  // Paying the deposit is the moment the deal becomes BINDING (Step 6): auto-materialize the direct Offer
  // so the buyer's paid card can surface the AGREED S&P. Best-effort — a materialize hiccup must NOT undo the
  // real debit. Idempotent per (conversation, epoch): a re-pay is a no-op.
  try {
    const desk = await deskDeveloperFor(building);
    if (desk) {
      const conversationId = directConversationId(account, building);
      await materializeDirectOffer({ conversationId, buyer: account, building, unit, by: desk });
    }
  } catch {
    /* the paperwork can be opened later (desk `materialize` action); the payment itself is authoritative */
  }

  // Nudge the buyer's own surface so "✓ Deposit paid" + the new balance + the agreement link appear live.
  publish(grantTopic(account));
  return { ok: true, alreadyPaid: false, deposit: settled ?? dep, amountVrx, balanceVrx: newBalance, paidTo };
}
