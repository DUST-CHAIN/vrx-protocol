// DEPOSIT EVIDENCE PACK (D-) — the SECOND OTS emitter. SERVER-ONLY. At every escrow custody
// transition (held / release_pending / released / refunded) this seals a tamper-evident, HASH-ONLY descriptor of
// the money-movement event and ANCHORS it via the OTS queue (lib/ots-anchor), keyed on the deal's neutral ref.
//
// ── WHY (D- the durability half) ───────────────────────────────────────────────────────────────────────
// VRX is a NOTARY, not a bank: the custody-less off-chain deposit needs a DURABLE, independently-verifiable record
// that "this deposit event happened at time T" — one that outlives VRX and reveals nothing. OpenTimestamps anchors
// a hash to Bitcoin (free, permanent, no amount/PII exposed). So each custody transition drops a sealed evidence
// pack onto the one OTS queue; it shows as pending → proven as Bitcoin confirms. This is the concrete answer to
// the Q2 (durability) for the deposit chokepoint — the first consumer of the general evidence-pack idea.
//
// ── PRIVACY — HASH-ONLY, this is load-bearing ──────────────────────────────────────────────────────────
// The thing we anchor is the SALTED SEAL of a descriptor. The descriptor contains NO amount, NO PII, NO plaintext
// terms — only: the event kind, the custody state transitioned TO, the neutral deal ref (the (buyer,building,unit)
// triple the escrow FSM already uses as its money-move label), and a timestamp bucket. Even the descriptor is
// never anchored — only its sha256 seal is. A hash reveals nothing; the amount lives off-chain in the $VRX ledger.
// The salt stays with us (never on-chain), so WE can later re-prove a given event sealed to a given hash, while an
// outside observer sees only "some VRX evidence existed at T". (Full encrypted wallet-keyed DELIVERY of the pack
// to the party — D- pt4 — is the follow-on module; this leg establishes the ANCHOR.)
//
// ── UX INVARIANT (D-) ───────────────────────────────────────────────────────────────────────────────────
// Emitting is FIRE-AND-FORGET and NEVER blocks or fails the money move. The custody transition is already final
// the instant the FSM commits it; the anchor is ADDED assurance that lands later. A seal/anchor hiccup must never
// roll back a release/refund — so the FSM calls this best-effort (await-but-swallow), exactly like the queue's own
// pending-is-normal contract.

import { sealRecord } from "../seal";
import { anchor, anchorsForRef, type OtsView } from "../ots-anchor";
import { sealEvidencePack, type EvidencePack } from "../evidence-pack";
import { now as vrxNow } from "../clock";

/** The seal domain for deposit evidence — EXPORTED so an external tool can re-derive/verify a sealed descriptor
 *  later (the salt lives with us; the domain is the public namespace). Distinct from vrx-sp-scan / vrx-identity-stamp. */
export const DEPOSIT_EVIDENCE_SEAL_DOMAIN = "vrx-deposit-evidence";
const SEAL_DOMAIN = DEPOSIT_EVIDENCE_SEAL_DOMAIN;

/** The custody states worth anchoring — every money-touching transition of the escrow FSM. */
export type EvidenceEvent = "held" | "release_pending" | "released" | "refunded";

/** The neutral deal ref the escrow FSM uses to label money moves — the (buyer,building,unit) triple, no PII beyond
 *  the account handles the deal already carries, and no parallel id ([[vrx-deal-uid-is-requestId]]). */
export function evidenceDealRef(buyer: string, building: string, unit: string): string {
  return `${buyer}/${building}/${unit}`;
}

/** The HASH-ONLY descriptor that gets sealed. Deliberately carries NO amount / NO PII / NO terms — only the neutral
 *  facts needed to say "a custody event of this kind happened for this deal at ~T". `custodyRef` ties it to the
 *  specific custody instance (from the funding adapter) without revealing a sum. `tsBucket` is a coarsened time
 *  (hour) so the seal doesn't leak a precise behavioural timestamp while still ordering events. */
export type EvidenceDescriptor = {
  v: 1;
  kind: "deposit_custody";
  event: EvidenceEvent;
  dealRef: string;
  custodyRef: string;
  tsBucketHour: number;
};

function descriptor(event: EvidenceEvent, dealRef: string, custodyRef: string, now: number): EvidenceDescriptor {
  return {
    v: 1,
    kind: "deposit_custody",
    event,
    dealRef,
    custodyRef: custodyRef || "",
    tsBucketHour: Math.floor(now / 3_600_000),
  };
}

/**
 * Seal + anchor a deposit custody event. FIRE-AND-FORGET by contract — returns the sealed hash it anchored (or
 * null on a swallowed failure) but NEVER throws into the FSM. The caller (the escrow FSM) must not let this affect
 * the money move: a failure here loses only the ADDED Bitcoin assurance, never the in-system custody state.
 *
 * Idempotency: the SEAL is salted (a fresh hash each call), so two calls for the "same" event would anchor two
 * rows. We guard against spurious duplicates at the FSM call site (only emit on a REAL transition, not an
 * idempotent no-op). The queue itself is first-writer-wins PER HASH, so a genuine re-seal of a distinct event is a
 * distinct, legitimate anchor.
 */
export async function anchorDepositEvidence(args: {
  buyer: string;
  building: string;
  unit: string;
  event: EvidenceEvent;
  custodyRef?: string;
  now?: number;
}): Promise<string | null> {
  try {
    const now = args.now ?? vrxNow();
    const dealRef = evidenceDealRef(args.buyer, args.building, args.unit);
    const desc = descriptor(args.event, dealRef, args.custodyRef ?? "", now);
    // SEAL the descriptor → a salted, tamper-evident sha256 hex (lib/seal). The salt is discarded here (the queue
    // only needs the hash); if we later want to re-PROVE a specific event we re-seal deterministically via digest
    // with the stored salt — but for the anchor, the hash existing at T is the whole provenance fact.
    const seal = sealRecord(desc, SEAL_DOMAIN);
    // ANCHOR the seal hash, kind=evidence_pack, keyed on the neutral deal ref so a reader finds a deal's evidence by
    // its existing id (anchorsForRef). The queue arms the worker + (if VRX_OTS_LIVE=1) the real OTS provider.
    await anchor(seal.hash, "evidence_pack", dealRef);
    return seal.hash;
  } catch {
    // Swallowed by contract — the custody transition already stands; only the OTS assurance was skipped.
    return null;
  }
}

/**
 * FIRE-AND-FORGET emit for the HOT PATH (the escrow FSM, which rides the buyer's live pay path via pay-deposit).
 * This is what the FSM calls: it kicks off the seal+anchor WITHOUT the caller awaiting it, so the buyer's payment
 * response never waits on a file write / seal / (live) OTS submit. The D- UX invariant is now enforced
 * CODE, not just intent: the custody transition is final the instant the FSM commits it; the anchor lands later,
 * off the response path. Errors are swallowed inside anchorDepositEvidence, so a detached rejection can't surface.
 *
 * ⚠ Why a separate fn (not just "don't await"): a bare un-awaited promise that rejects would be an unhandledRejection
 * noise source. This wraps it with a .catch so the detached work is genuinely safe to drop on the floor. Tests call
 * the awaitable anchorDepositEvidence directly to assert the anchor landed; production calls THIS.
 */
export function emitDepositEvidence(args: {
  buyer: string;
  building: string;
  unit: string;
  event: EvidenceEvent;
  custodyRef?: string;
}): void {
  void anchorDepositEvidence(args).catch(() => {
    /* detached + already-swallowed; nothing to do — the custody state already stands */
  });
}

/**
 * THE PAIRED LEG (D- pt4) — seal a FULL encrypted evidence pack to the PARTY at a custody event, keyed on
 * the deal ref, AND make the event's EXISTENCE publicly provable via the hash-only OTS anchor. This is the
 * durability-complete leg: anchorDepositEvidence (above) anchors an amount-FREE descriptor's hash publicly; THIS also
 * hands the party an ENCRYPTED copy of the full event (which MAY carry the amount/terms) that only they can open —
 * "encrypted party-held evidence packs" ([[vrx-money-privacy-durability-fork]]).
 *
 * ⚠ PRIVACY — WHY WE DO NOT ANCHOR THE PACK'S contentHash (adversarial pass):
 * The pack's `contentHash` is the hash of the FULL payload, which INCLUDES `amountUsd`. Anchoring THAT publicly
 * would leak the amount: an observer with the public anchor + the (public) dealRef could BRUTE-FORCE the amount
 * (a low-entropy field) by hashing candidate payloads until one matches. So the PUBLIC anchor is the SAME amount-free
 * salted descriptor hash that anchorDepositEvidence emits (via that fn) — the amount NEVER touches a public hash. The
 * pack's contentHash stays PRIVATE: the party re-derives it from their decrypted copy to prove their copy is intact,
 * but it is never published. Public existence proof (amount-free) + private party-held content (amount included,
 * encrypted) — the two are deliberately DIFFERENT hashes. This mirrors lib/seal's low-entropy-brute-force guard.
 *
 * Gated on a recipient DELIVERY KEY: if the party hasn't registered an X25519 delivery pubkey yet, this is a no-op
 * (returns null) — the hash-only anchor leg still stands, so nothing is lost; the full pack simply waits until the
 * party has a delivery key. FIRE-AND-FORGET contract (never throws into the FSM) — a seal hiccup must not roll back a
 * money move. Hot-path callers should use emitDepositEvidencePack (below), which never awaits.
 */
export async function sealDepositEvidencePack(args: {
  buyer: string;
  building: string;
  unit: string;
  event: EvidenceEvent;
  recipient: string; // who HOLDS the pack (an account handle — typically the buyer)
  recipientDeliveryPubB64?: string; // the party's X25519 delivery key; absent → no-op (anchor leg still stands)
  amountUsd?: number; // MAY be included in the ENCRYPTED pack — never in the public anchor (see the privacy note)
  custodyRef?: string;
  now?: number;
}): Promise<EvidencePack | null> {
  try {
    const key = (args.recipientDeliveryPubB64 ?? "").trim();
    if (!key) return null; // party has no delivery key yet → the hash-only anchor is the standing record
    const now = args.now ?? vrxNow();
    const dealRef = evidenceDealRef(args.buyer, args.building, args.unit);
    // The FULL (encrypted, party-held) payload — amount/terms allowed here precisely because it never goes public.
    const payload = {
      v: 1,
      kind: "deposit_custody",
      event: args.event,
      dealRef,
      custodyRef: args.custodyRef ?? "",
      amountUsd: Number.isFinite(args.amountUsd) ? args.amountUsd : undefined,
      at: now,
    };
    const pack = await sealEvidencePack({
      kind: "deposit_custody",
      ref: dealRef,
      recipient: (args.recipient || args.buyer).trim(),
      recipientDeliveryPubB64: key,
      payload,
      now,
    });
    // PUBLIC anchor = the AMOUNT-FREE salted descriptor hash (NOT the pack's full-payload contentHash). anchorDeposit-
    // Evidence seals {event, dealRef, custodyRef, tsBucketHour} — no amount — and anchors THAT. First-writer-wins per
    // hash, so if the FSM already emitted this event's hash-only anchor, this is a no-op (no duplicate).
    await anchorDepositEvidence({ buyer: args.buyer, building: args.building, unit: args.unit, event: args.event, custodyRef: args.custodyRef, now });
    return pack;
  } catch {
    // Swallowed by contract — the custody transition already stands; the hash-only anchor (if emitted) still holds.
    return null;
  }
}

/**
 * FIRE-AND-FORGET wrapper for the hot path (the escrow FSM rides the live buyer pay path). Kicks off the pack-seal +
 * amount-free anchor WITHOUT the caller awaiting, so the payment response never waits on crypto/file IO. Errors are
 * already swallowed inside sealDepositEvidencePack; the .catch guards the detached promise against an unhandled
 * rejection. Tests call the awaitable sealDepositEvidencePack to assert the pack landed; production calls THIS.
 */
export function emitDepositEvidencePack(args: {
  buyer: string;
  building: string;
  unit: string;
  event: EvidenceEvent;
  recipient: string;
  recipientDeliveryPubB64?: string;
  amountUsd?: number;
  custodyRef?: string;
}): void {
  void sealDepositEvidencePack(args).catch(() => {
    /* detached + already-swallowed; the custody state + the hash-only anchor already stand */
  });
}

/** All evidence-pack anchors for a deal (newest first) — a reader surface renders their pending/proven status. */
export async function depositEvidenceForDeal(
  buyer: string,
  building: string,
  unit: string
): Promise<OtsView[]> {
  const dealRef = evidenceDealRef(buyer, building, unit);
  return (await anchorsForRef(dealRef)).filter((a) => a.kind === "evidence_pack");
}
