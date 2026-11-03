// FUNDING ADAPTER — the swappable seam between the deposit-custody FSM and the actual money rail.
// SERVER-ONLY. Ported in SHAPE from IdeaForge's `EscrowProvider` (apps/web/src/modules/escrow/types.ts),
// adapted to VRX: the FSM never moves money itself — it asks this adapter to `fund` (payer → custody),
// `release` (custody → developer), or `refund` (custody → buyer). That single discipline is what lets a NEW
// money rail (NEAR Intents, a card gateway) slot in LATER as a new impl, not a rewrite of the FSM.
// Design + the "know ahead" rationale: the design docs.
//
// ── Why a seam and not a direct transfer (the scan-for-the-pattern call) ─────────────────────────────────────
// Today the only rail is the $VRX ledger (instant, ours → every move is `settled: true`). But wants NEAR
// Intents / card ahead of time: those are EXTERNAL rails where money arrives/leaves ASYNC. The ONE accommodation
// the FSM needs for that future is the `settled` boolean on every result — a `false` tells the FSM "the rail
// accepted the request but the money isn't there yet; stay in the pending sub-state until a webhook confirms."
// Adding that now is cheap; retrofitting it into a synchronous-assuming FSM later is expensive. So the $VRX impl
// returns `settled: true` always, and the interface is already shaped for the async rails.
//
// ── The custody account ──────────────────────────────────────────────────────────────────────────────────────
// For the $VRX rail, "custody" is a reserved ledger account `vrx-escrow.vrx` (same `.vrx` convention as
// TREASURY_ACCOUNT). The deposit sits there between pay and release — NOT in the developer's wallet (that was the
// D- shortcut this escrow model corrects). The account is created lazily by the first transfer into it.
//
// ── Authz (unchanged invariant) ──────────────────────────────────────────────────────────────────────────────
// This adapter does NOT authorize. The ROUTE proves the caller (developer-for-release, buyer-for-veto) via
// requireCaller before the FSM calls in. Authz is the V5-relocatable part — never fold a session check in here.

import { transfer, balanceOf } from "../vrx-token";

/** The reserved $VRX ledger account that holds deposits in custody between pay and release. */
export const ESCROW_CUSTODY_ACCOUNT = "vrx-escrow.vrx";

/** A move request into/out of custody. `dealRef` = the deal UID (buyer,building,unit) for the memo/audit. */
export type FundInput = { payer: string; amountVrx: number; dealRef: string };
export type ReleaseInput = { developer: string; amountVrx: number; dealRef: string; custodyRef: string };
export type RefundInput = { buyer: string; amountVrx: number; dealRef: string; custodyRef: string };

/**
 * The result of any custody money move. `settled` is the whole future-proofing: true = the money is where it
 * should be NOW (the $VRX rail); false = the rail accepted the request but settlement is async (a future
 * Intents/card rail) → the FSM keeps the deposit in its pending sub-state until a confirmation flips it.
 * `custodyRef` identifies the custody position (for $VRX it's just the custody account); `externalTx` carries
 * an external rail's tx id when there is one.
 */
export type FundingResult = { settled: boolean; custodyRef: string; externalTx?: string };

export interface FundingAdapter {
  /** Move the deposit from `payer` INTO custody. */
  fund(input: FundInput): Promise<FundingResult>;
  /** Release from custody → the developer (the deal proceeded). */
  release(input: ReleaseInput): Promise<FundingResult>;
  /** Refund from custody → the buyer (the deal fell through / was vetoed). */
  refund(input: RefundInput): Promise<FundingResult>;
}

/**
 * The $VRX ledger funding adapter — the live rail today (and the demo↔real one path, [[vrx-demo-vs-real-shared-path-audit]]).
 * Every move is a synchronous ledger transfer (`settled: true`). This is NOT a mock (unlike IdeaForge's stub):
 * the $VRX ledger is real money movement in the demo's sense; the same code becomes a signed on-chain $VRX
 * transfer at V5 by swapping only the transport under `transfer`, not this orchestration.
 */
export const vrxFundingAdapter: FundingAdapter = {
  async fund({ payer, amountVrx, dealRef }) {
    if (amountVrx <= 0) throw new Error("fund amount must be positive");
    const bal = await balanceOf(payer);
    if (bal < amountVrx) throw new Error("insufficient $VRX balance");
    await transfer(payer, ESCROW_CUSTODY_ACCOUNT, amountVrx, `deposit into escrow (${dealRef})`);
    return { settled: true, custodyRef: ESCROW_CUSTODY_ACCOUNT };
  },

  async release({ developer, amountVrx, dealRef }) {
    if (amountVrx <= 0) throw new Error("release amount must be positive");
    // Custody → developer. The custody account was funded by `fund`; a short balance here means a double-release
    // or an un-funded release — throw rather than mint money.
    const bal = await balanceOf(ESCROW_CUSTODY_ACCOUNT);
    if (bal < amountVrx) throw new Error("escrow custody underfunded for release");
    await transfer(ESCROW_CUSTODY_ACCOUNT, developer, amountVrx, `deposit released to developer (${dealRef})`);
    return { settled: true, custodyRef: ESCROW_CUSTODY_ACCOUNT };
  },

  async refund({ buyer, amountVrx, dealRef }) {
    if (amountVrx <= 0) throw new Error("refund amount must be positive");
    const bal = await balanceOf(ESCROW_CUSTODY_ACCOUNT);
    if (bal < amountVrx) throw new Error("escrow custody underfunded for refund");
    await transfer(ESCROW_CUSTODY_ACCOUNT, buyer, amountVrx, `deposit refunded to buyer (${dealRef})`);
    return { settled: true, custodyRef: ESCROW_CUSTODY_ACCOUNT };
  },
};

/**
 * The active funding adapter. Env-driven, same shape as IdeaForge's `getEscrowProvider`. Today ALWAYS the $VRX
 * ledger. NEAR Intents / card adapters slot in here behind an env flag when their impls exist — zero change to
 * the FSM or callers. (The seam is ready; the impls are future slices — see the port map's build order.)
 */
export function getFundingAdapter(): FundingAdapter {
  return vrxFundingAdapter;
}
