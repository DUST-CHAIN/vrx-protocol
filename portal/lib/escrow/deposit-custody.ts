// DEPOSIT CUSTODY FSM — the escrow state machine over a direct-sale deposit (the IdeaForge port).
// SERVER-ONLY. Ported from IdeaForge's `modules/escrow/index.ts` orchestration + lifecycle guards, adapted to
// VRX's resolved forks: custody stays OFF-CHAIN (the $VRX ledger, via the funding adapter — NOT on-chain
// USDC), and release authority is DEVELOPER SELF-RELEASE + a BUYER TIME-LOCK VETO window (IdeaForge punted this;
// we decided it + enforce it IN THE MODULE, not just the UI). Design: the design docs.
//
// ── The state machine (orthogonal to DirectDeposit.status, the on-chain HOLD lifecycle) ──────────────────────
//  none → held fundCustody buyer paid → $VRX sits in the custody account, NOT the dev's.
//  held → release_pending requestRelease developer asks to take the deposit → starts the veto clock.
//  release_pending → released finalizeRelease window elapsed (or both consent) → custody → developer.
//  release_pending → refunded vetoRelease buyer vetoes within the window → custody → buyer.
//  held → refunded refundCustody deal called off before any release request → custody → buyer.
// Every transition is GUARDED (illegal source state → a typed failure, never a silent no-op that loses money),
// IDEMPOTENT on the terminal states (re-finalize an already-released deposit → ok no-op), and drives the funding
// adapter for the real move. Money only moves inside a legal transition.
//
// ── Authz (unchanged invariant) ──────────────────────────────────────────────────────────────────────────────
// This module does NOT authorize. The route proves the caller before calling in (developer for request/finalize,
// buyer for veto). Authz is the V5-relocatable seam — never fold a session check here.

import { getDeposit, setCustody, type DirectDeposit } from "../direct-deposits";
import { getFundingAdapter } from "./funding-adapter";
import { demoRoleUxArmed } from "../dev-signer-fence";
import { emitDepositEvidence, emitDepositEvidencePack } from "./deposit-evidence";
import { resolveDeliveryKey } from "../evidence-delivery-key";

/**
 * — seal a FULL encrypted evidence pack to the receiving party at a custody transition (the paired leg of the
 * hash-only anchor). FIRE-AND-FORGET: resolves the recipient's registered X25519 delivery key then kicks off the
 * seal WITHOUT awaiting (this rides the buyer's live pay path via pay-deposit — the payment response must not wait
 * on crypto/file IO). NO-OP when the party has no delivery key registered (resolveDeliveryKey → null → the seal is
 * skipped; the hash-only anchor already stands). Additive + inert until a party opts in by registering a key.
 *   held            → the BUYER holds proof they paid into custody.
 *   release_pending → the BUYER holds proof the release clock started (they have the veto right).
 *   released        → the DEVELOPER holds proof they received the deposit.
 *   refunded        → the BUYER holds proof the deposit came back.
 * The amount MAY ride the ENCRYPTED pack (party-held, never public — see deposit-evidence's privacy note).
 */
function emitPackTo(
  recipient: string,
  buyer: string,
  building: string,
  unit: string,
  event: "held" | "release_pending" | "released" | "refunded",
  amountVrx: number | undefined,
  custodyRef: string | undefined
): void {
  // Resolve the key off the response path, then emit (itself fire-and-forget). The whole chain is detached +
  // swallowed; a missing key / lookup hiccup simply means no pack this time (the anchor leg is unaffected).
  void resolveDeliveryKey(recipient)
    .then((key) => {
      if (!key) return; // party has no delivery key yet → hash-only anchor is the standing record
      emitDepositEvidencePack({
        buyer,
        building,
        unit,
        event,
        recipient,
        recipientDeliveryPubB64: key,
        amountUsd: amountVrx, // $VRX ≈ USD; carried only in the ENCRYPTED pack, never the public anchor
        custodyRef,
      });
    })
    .catch(() => {
      /* detached + swallowed — the custody state + the hash-only anchor already stand */
    });
}

/** Default buyer veto window: 48h from the developer's release request. Config-overridable; snapshotted onto the
 *  deposit at request time so a later config change can't shorten an already-open window. */
export const DEFAULT_VETO_WINDOW_MS = Number(process.env.VRX_ESCROW_VETO_WINDOW_MS ?? 48 * 60 * 60 * 1000);

/**
 * Is deposit custody (escrow) ACTIVE for this process? — the ONE predicate the pay path reads (D- phase a).
 *
 * Escrow is the VRX-LEVEL GUARANTEE, not a developer-elective toggle: every direct deposit routes through custody
 * as a platform promise. The posture per environment:
 *   - DEMO (NEXT_PUBLIC_VRX_DEMO=1 / localnet god-mode) → ALWAYS ON. The demo is play-money ($VRX ledger), so the
 *     VRX-always guarantee is free to show here — this is what makes the "escrow-protected ✓" badge honest in the
 * demo. (This replaced the old global VRX_ESCROW_CUSTODY flag as the demo trigger —, model #1.)
 *   - REAL money → the explicit VRX_ESCROW_CUSTODY=1 gate, deliberately still OFF until Track-B custody hardening +
 * re-sign land (D-). Turning escrow on for REAL deposits is NOT just a switch; it pulls in the
 *     deferred real-money arc. So the explicit flag stays the real-money seam; demo gets it for free.
 * Read at call time (not module load) so a test/drive can toggle the env per-process — note demoRoleUxArmed's
 * DEMO_MODE_FLAG is itself a module-load constant, so we ALSO read NEXT_PUBLIC_VRX_DEMO directly here (belt) to stay
 * genuinely call-time. FAIL-SAFE by construction: if NEITHER condition holds, the direct-to-developer path (D-)
 * runs byte-for-byte unchanged.
 */
export function escrowCustodyActive(): boolean {
  return (
    process.env.NEXT_PUBLIC_VRX_DEMO === "1" ||
    demoRoleUxArmed() ||
    process.env.VRX_ESCROW_CUSTODY === "1"
  );
}

export type CustodyState = NonNullable<DirectDeposit["custody"]>["state"];

export type CustodyResult =
  | { ok: true; deposit: DirectDeposit; noop?: boolean }
  | { ok: false; status: 404 | 409; error: string };

/** The deal UID for memos/audit — the existing (buyer,building,unit) triple, no parallel id ([[vrx-deal-uid-is-requestId]]). */
const dealRef = (buyer: string, building: string, unit: string) => `${buyer}/${building}/${unit}`;

/** Read the custody state of a deposit, defaulting a legacy/absent block to `none`. */
export function custodyStateOf(d: DirectDeposit): CustodyState {
  return d.custody?.state ?? "none";
}

/**
 * Whether the buyer's veto window is currently OPEN (deposit is release_pending and the clock hasn't elapsed).
 * PURE — the route/UI reads this to show the buyer a live "veto" control + countdown. `now` injectable for tests.
 */
export function vetoWindowOpen(d: DirectDeposit, now: number = Date.now()): boolean {
  const c = d.custody;
  if (!c || c.state !== "release_pending" || !c.releaseRequestedAt || !c.vetoWindowMs) return false;
  return now < c.releaseRequestedAt + c.vetoWindowMs;
}

/** ms remaining in the veto window (0 when closed/not pending). PURE. */
export function vetoMsLeft(d: DirectDeposit, now: number = Date.now()): number {
  const c = d.custody;
  if (!c || c.state !== "release_pending" || !c.releaseRequestedAt || !c.vetoWindowMs) return 0;
  return Math.max(0, c.releaseRequestedAt + c.vetoWindowMs - now);
}

/**
 * none → held. The buyer paid their deposit INTO custody (the escrow account), not the developer's wallet.
 * `amountVrx` is the whole-unit $VRX figure (≈ USD). Drives the funding adapter's `fund` (payer → custody).
 * Idempotent: a deposit already in custody (held or beyond) is a no-op (the caller may double-fire the pay path).
 * The CALLER must have already debited nothing itself — this owns the money move via the adapter.
 */
export async function fundCustody(
  buyer: string,
  building: string,
  unit: string,
  amountVrx: number
): Promise<CustodyResult> {
  const dep = await getDeposit(buyer, building, unit);
  if (!dep) return { ok: false, status: 404, error: "no deposit to fund" };
  const state = custodyStateOf(dep);
  if (state !== "none") {
    // Already in (or past) custody → idempotent no-op (whichever pay path fired first funded it).
    return { ok: true, deposit: dep, noop: true };
  }
  if (!(amountVrx > 0)) return { ok: false, status: 409, error: "fund amount must be positive" };

  let res;
  try {
    res = await getFundingAdapter().fund({ payer: buyer, amountVrx, dealRef: dealRef(buyer, building, unit) });
  } catch (e) {
    return { ok: false, status: 409, error: e instanceof Error ? e.message : "funding failed" };
  }

  const updated = await setCustody(buyer, building, unit, {
    state: "held",
    amountVrx,
    fundedAt: Date.now(),
    custodyRef: res.custodyRef,
  });
  if (updated) {
    // Real transition none→held → seal + OTS-anchor a hash-only evidence pack (D-). FIRE-AND-FORGET: this is
    // the buyer's live pay path (via pay-deposit), so the anchor must NOT be awaited — the payment response can't
    // wait on a file write / seal / (live) OTS submit. The custody state already stands; the anchor lands later.
    emitDepositEvidence({ buyer, building, unit, event: "held", custodyRef: res.custodyRef });
    //  paired leg — the buyer holds their own encrypted proof-of-payment pack (no-op until they register a key).
    emitPackTo(buyer, buyer, building, unit, "held", amountVrx, res.custodyRef);
    return { ok: true, deposit: updated };
  }
  return { ok: false, status: 404, error: "no deposit to fund" };
}

/**
 * held → release_pending. The DEVELOPER requests release of the held deposit → starts the buyer's veto clock.
 * No money moves yet (the veto window must pass first). Idempotent: already release_pending → no-op.
 * `vetoWindowMs` defaults to DEFAULT_VETO_WINDOW_MS; snapshotted onto the deposit so the window is fixed once open.
 */
export async function requestRelease(
  buyer: string,
  building: string,
  unit: string,
  vetoWindowMs: number = DEFAULT_VETO_WINDOW_MS
): Promise<CustodyResult> {
  const dep = await getDeposit(buyer, building, unit);
  if (!dep) return { ok: false, status: 404, error: "no deposit" };
  const state = custodyStateOf(dep);
  if (state === "release_pending") return { ok: true, deposit: dep, noop: true };
  if (state !== "held") {
    return { ok: false, status: 409, error: `cannot request release from custody state "${state}"` };
  }
  const updated = await setCustody(buyer, building, unit, {
    state: "release_pending",
    releaseRequestedAt: Date.now(),
    vetoWindowMs: vetoWindowMs > 0 ? vetoWindowMs : DEFAULT_VETO_WINDOW_MS,
  });
  if (updated) {
    emitDepositEvidence({ buyer, building, unit, event: "release_pending", custodyRef: dep.custody?.custodyRef });
    //  paired leg — the buyer holds proof the release clock started (they hold the veto right).
    emitPackTo(buyer, buyer, building, unit, "release_pending", dep.custody?.amountVrx, dep.custody?.custodyRef);
    return { ok: true, deposit: updated };
  }
  return { ok: false, status: 404, error: "no deposit" };
}

/**
 * release_pending → released. Move the deposit custody → developer. Guarded by the veto window: refuses while
 * the window is still OPEN unless `force` is set (the "both parties consent early" path — the caller proves both
 * consents; this module only knows the developer's identity). Normal call = the auto-release after the window
 * elapses. Idempotent: already released → no-op. Drives the adapter's `release` (custody → developer).
 */
export async function finalizeRelease(
  buyer: string,
  building: string,
  unit: string,
  developer: string,
  opts: { force?: boolean; now?: number } = {}
): Promise<CustodyResult> {
  const dep = await getDeposit(buyer, building, unit);
  if (!dep) return { ok: false, status: 404, error: "no deposit" };
  const state = custodyStateOf(dep);
  if (state === "released") return { ok: true, deposit: dep, noop: true };
  if (state !== "release_pending") {
    return { ok: false, status: 409, error: `cannot finalize release from custody state "${state}"` };
  }
  if (!opts.force && vetoWindowOpen(dep, opts.now ?? Date.now())) {
    return { ok: false, status: 409, error: "buyer veto window still open" };
  }
  const amountVrx = dep.custody?.amountVrx ?? 0;
  if (!(amountVrx > 0)) return { ok: false, status: 409, error: "nothing in custody to release" };

  let res;
  try {
    res = await getFundingAdapter().release({
      developer,
      amountVrx,
      dealRef: dealRef(buyer, building, unit),
      custodyRef: dep.custody?.custodyRef ?? "",
    });
  } catch (e) {
    return { ok: false, status: 409, error: e instanceof Error ? e.message : "release failed" };
  }
  // settled:false (a future async rail) would keep it release_pending until a webhook confirms — the $VRX rail is
  // always settled:true, so we terminalize here. (Seam ready for Intents/card; see the port map.)
  const updated = await setCustody(buyer, building, unit, {
    state: res.settled ? "released" : "release_pending",
    settledAt: res.settled ? Date.now() : undefined,
  });
  if (updated) {
    // Anchor only when it actually terminalized to released (settled:true). A settled:false async rail stays
    // release_pending → no NEW transition to seal yet (the webhook that settles it will emit).
    if (res.settled) {
      emitDepositEvidence({ buyer, building, unit, event: "released", custodyRef: dep.custody?.custodyRef });
      //  paired leg — the DEVELOPER holds proof they received the deposit (recipient = developer here).
      emitPackTo(developer, buyer, building, unit, "released", amountVrx, dep.custody?.custodyRef);
    }
    return { ok: true, deposit: updated };
  }
  return { ok: false, status: 404, error: "no deposit" };
}

/**
 * release_pending → released, EARLY, by BUYER CONSENT (the waive — D-). The buyer trusts the deal and wants a
 * FAST CLOSE: they voluntarily give up the rest of their veto window, releasing the deposit to the developer NOW
 * instead of waiting for it to elapse. This is the buyer-side twin of finalizeRelease's `force` branch (there the
 * developer finalizes after the window; here the BUYER finalizes before it) — same terminal (custody → developer),
 * different authority. The route proves it's the BUYER before calling in. Guarded (must be release_pending; a held
 * deposit has no pending release to waive), idempotent (already released → no-op). Needs the developer's account to
 * pay out — the route resolves it from the deal parties, never the client.
 */
export async function waiveVeto(
  buyer: string,
  building: string,
  unit: string,
  developer: string
): Promise<CustodyResult> {
  const dep = await getDeposit(buyer, building, unit);
  if (!dep) return { ok: false, status: 404, error: "no deposit" };
  const state = custodyStateOf(dep);
  if (state === "released") return { ok: true, deposit: dep, noop: true };
  if (state !== "release_pending") {
    return { ok: false, status: 409, error: `cannot waive the veto from custody state "${state}"` };
  }
  // force:true = release despite the window still being open — the buyer is the one consenting, so this is
  // legitimate (unlike a developer forcing it, which would need both consents). Same money move as finalizeRelease.
  return finalizeRelease(buyer, building, unit, developer, { force: true });
}

/**
 * {held | release_pending} → refunded. Return the deposit custody → buyer. Two entry reasons:
 *   - the BUYER vetoes within the release window (release_pending → refunded), or
 *   - the deal is called off before any release request (held → refunded).
 * Guarded: refuses from a terminal/none state. Idempotent: already refunded → no-op. Drives `refund` (custody → buyer).
 */
export async function refundCustody(
  buyer: string,
  building: string,
  unit: string
): Promise<CustodyResult> {
  const dep = await getDeposit(buyer, building, unit);
  if (!dep) return { ok: false, status: 404, error: "no deposit" };
  const state = custodyStateOf(dep);
  if (state === "refunded") return { ok: true, deposit: dep, noop: true };
  if (state !== "held" && state !== "release_pending") {
    return { ok: false, status: 409, error: `cannot refund from custody state "${state}"` };
  }
  const amountVrx = dep.custody?.amountVrx ?? 0;
  if (!(amountVrx > 0)) return { ok: false, status: 409, error: "nothing in custody to refund" };

  let res;
  try {
    res = await getFundingAdapter().refund({
      buyer,
      amountVrx,
      dealRef: dealRef(buyer, building, unit),
      custodyRef: dep.custody?.custodyRef ?? "",
    });
  } catch (e) {
    return { ok: false, status: 409, error: e instanceof Error ? e.message : "refund failed" };
  }
  const updated = await setCustody(buyer, building, unit, {
    state: res.settled ? "refunded" : "release_pending",
    settledAt: res.settled ? Date.now() : undefined,
  });
  if (updated) {
    if (res.settled) {
      emitDepositEvidence({ buyer, building, unit, event: "refunded", custodyRef: dep.custody?.custodyRef });
      //  paired leg — the buyer holds proof the deposit came back.
      emitPackTo(buyer, buyer, building, unit, "refunded", amountVrx, dep.custody?.custodyRef);
    }
    return { ok: true, deposit: updated };
  }
  return { ok: false, status: 404, error: "no deposit" };
}
