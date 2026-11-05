// AI Sales Director — the SIGNING SEAM (slice 6, the design docs §5, D-D-).
// SERVER-ONLY. The SINGLE named swap-point between "the AI wants to hold/release a unit" and "how that hold is
// actually effected on-chain." Everything above this seam (open_unit, the deposit flow, the auto-release timers)
// is REAL and tested; only the BODY of these two functions changes as the signing posture matures.
//
// ── Why a seam (the whole point) ────────────────────────────────────────────────────────────────────────
// The real on-chain grant_exclusive is WALLET-SIGNED by a human desk operator client-side — the portal route
// "never holds a key" (api/direct-deposits). So an AUTONOMOUS AI hold cannot be on-chain without a desk key on
// the server, which breaks that model. Rather than bake a key into open_unit, we isolate the signing act
// behind this seam. THREE postures plug in at exactly this body, cheapest → strongest (D-):
//   (STUB, today) record an OFF-CHAIN sealed soft-hold (lib/ai-desk/unit-holds) — no key on the server at all.
//                 A human later signs the real grant_exclusive to make it firm (the unchanged human flow); the
//                 timers free a stalled soft-hold. This is the DEMO posture (honest, demoable end-to-end).
//   (demo key)    sign grant_exclusive on-chain with a server-held DEMO desk key — a one-line swap of the body.
//   (real vault)  a human-gated per-action signing vault (TG-OTP / one-time code list / 2-of-2 co-signer, scoped
//                 on-chain via a function-call access key) — the real autonomous build ([[ai-desk-autonomous-
//                 signing-vault-vision]]). Still a swap of THIS body; nothing above the seam changes.
//
// Keeping it one function means the "is the key on the server?" decision lives in ONE auditable place, and the
// slice-9 vault work is a contained swap, not a rewrite of the deal flow.

import { placeHold, releaseHold, type SoftHold } from "./unit-holds";
import { evaluateAuthorization, consumeAuthorization, type PresentedAuth } from "./signing-vault";
import type { AiDeskConfig } from "./types";

/** The L1 auto-release window (slice 7): a fresh hold auto-releases in 2h if the deal makes no progress. The
 *  signing seam stamps this as the hold's first releaseAt; the release-timer evaluator escalates it (L2 →
 *  final) from there. Exported so the timer + tests share the one constant. */
export const L1_HOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

/** What the caller (open_unit) hands the seam to effect a hold. The releaseAt is computed HERE (not by the
 *  caller) so the "how long is a fresh hold good for" policy lives with the signing act. */
export type GrantRequest = {
  dealId: string;
  /** The desk developer the hold is signed AS (the party a real grant_exclusive would be `by`). */
  desk: string;
  buildingId: string;
  unitId: string;
  /** Optional explicit "now" (test/replay hook) — defaults to Date.now. The L1 window is relative to it. */
  asOf?: number;
  /** The signing POSTURE (slice 9). Defaults to "soft_hold" (the stub) when omitted — so existing callers
   *  and all 291 prior tests are unchanged. "vault" requires `authorization` below. */
  posture?: AiDeskConfig["signingPosture"];
  /** The one-time human authorization presented to the vault (posture "vault" only). Its scope MUST match
   *  this grant's deal+building+unit or the vault denies `scope_mismatch`. */
  authorization?: PresentedAuth;
};

/** The seam's verdict. `kind` tells the caller which posture effected the hold (so the reply/sidecar can be
 *  honest — a demo soft-hold is phrased differently from a firm on-chain hold). `onChain` is false for the stub. */
export type GrantResult =
  | {
      ok: true;
      hold: SoftHold;
      /** Which signing posture effected this ("soft_hold" today; "on_chain" when the demo-key/V7 leg lands). */
      kind: "soft_hold" | "on_chain";
      onChain: boolean;
      releaseAt: number;
      /** True when a vault authorization was required AND approved (audit — a human authorized this hold). The
       *  plain stub posture leaves it false (no authorization step). */
      authorized: boolean;
    }
  | {
      ok: false;
      /** The vault refused the hold (posture "vault"): no/expired/used/mismatched/revoked authorization, or the
       *  posture required one and none was presented. The caller surfaces this honestly ("I need a one-time
       *  approval for this hold") and places NO hold. */
      reason: "needs_authorization" | "scope_mismatch" | "used" | "expired" | "revoked";
    };

/**
 * signGrantExclusive — effect a hold on a unit for a deal (the seam). STUB posture: record a sealed OFF-CHAIN
 * soft-hold with an L1 (2h) auto-release window. NO on-chain tx, NO desk key on the server. Returns the stored
 * hold + the posture so the caller can phrase the result honestly. Idempotent via placeHold (a re-grant of the
 * same deal+unit+window returns the existing hold; a different unit supersedes the prior hold for the deal).
 *
 * ⚠ SWAP POINT (D-D-): to make the demo hold REAL on-chain, replace the body with a grant_exclusive
 * call signed by the demo desk key (set kind:"on_chain", onChain:true, still record the soft-hold mirror for the
 * timers). For the real autonomous build, route the signature through the per-action vault
 * ([[ai-desk-autonomous-signing-vault-vision]]). Nothing ABOVE this function changes.
 */
export async function signGrantExclusive(req: GrantRequest): Promise<GrantResult> {
  const now = Number.isFinite(req.asOf) && (req.asOf as number) > 0 ? (req.asOf as number) : Date.now();
  const posture = req.posture ?? "soft_hold";

  // ── Posture "vault" (slice 9): a one-time human authorization gates the signature. ────────────────────
  // The vault is PURE (reads its store, no network, no on-chain). On approve we CONSUME the token and fall
  // through to place the soft-hold (the on-chain grant_exclusive call is the V7 leg — a body swap right HERE).
  // On deny we place NO hold and return the typed reason so the caller can ask for an approval honestly.
  let authorized = false;
  if (posture === "vault") {
    if (!req.authorization) return { ok: false, reason: "needs_authorization" };
    const verdict = await evaluateAuthorization(req.authorization, now);
    if (!verdict.ok) {
      // no_token ⇒ there is no valid authorization ⇒ the caller must obtain one ("needs_authorization").
      if (verdict.reason === "no_token") return { ok: false, reason: "needs_authorization" };
      return { ok: false, reason: verdict.reason }; // scope_mismatch | used | expired | revoked
    }
    await consumeAuthorization(verdict.recordId, req.dealId, now);
    authorized = true;
    // ⚠ V7 SWAP POINT: here, with the human authorization spent, sign the real on-chain grant_exclusive with the
    // scoped function-call access key, then set kind:"on_chain"/onChain:true below. Today it still records the
    // off-chain soft-hold (grant_exclusive is in the V7 contract batch, not on testnet — docs §9b).
  }

  const releaseAt = now + L1_HOLD_MS;
  const hold = await placeHold({
    dealId: req.dealId,
    desk: req.desk,
    buildingId: req.buildingId,
    unitId: req.unitId,
    heldAt: now,
    releaseAt,
  });
  return { ok: true, hold, kind: "soft_hold", onChain: false, releaseAt: hold.releaseAt, authorized };
}

/**
 * signReleaseExclusive — release a deal's hold (the seam's reverse). STUB posture: tombstone the off-chain
 * soft-hold. Returns the released record (or null if the deal had no active hold). `reason` is a short plain tag
 * the audit/timer records ("expired-final", "deal-closed", "moved"). SWAP POINT twin of signGrantExclusive:
 * the real version signs release_exclusive on-chain (via the same vault), then tombstones the mirror.
 */
export async function signReleaseExclusive(dealId: string, by: string, reason: string): Promise<SoftHold | null> {
  return releaseHold(dealId, by, reason);
}
