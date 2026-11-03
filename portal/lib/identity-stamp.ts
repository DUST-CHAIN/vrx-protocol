// IDENTITY STAMP EMITTER (D- OTS_ARC_PLAN_S383 "first emitter = batched identity stamping"). SERVER-ONLY.
// The THIRD OTS emitter (after the S&P seal and the deposit evidence pack): seals a HASH-ONLY "VRX-vetted as of T"
// descriptor for a vetted account and ANCHORS it via the one OTS queue (lib/ots-anchor), so the fact "VRX vetted this
// identity at time T" becomes independently verifiable on Bitcoin (free, permanent, reveals nothing).
//
// ── WHY ("reusable everywhere"; OTS_ARC_PLAN §first-emitter) ──────────────────────────────────────
// VRX vets every participant (developer / agency / agent / buyer). Today that vetting is an in-system fact. Anchoring
// a hash of "account A was VRX-vetted at tier X as of T" to Bitcoin turns it into a durable, outsider-checkable
// provenance claim — the "VRX-vetted as of T" badge the roadmap calls for. ONE queue, MANY emitters: this adds the
// identity emitter beside sp_document + evidence_pack, all draining the same paced worker.
//
// ── ⚠ THE FRESHNESS / REVOCATION TRAP (OPEN_ITEMS: "a stamp proves issuance-at-T, not still-valid") ───────────
// A Bitcoin stamp is a POINT-IN-TIME proof: it proves "VRX asserted this vetting at T", NOT "this account is vetted
// NOW". Vetting can later be REVOKED (fraud found, licence lapsed). So:
//   (1) the descriptor carries an explicit `vettedAt` — the anchored claim is always "...as of T", never "currently".
//   (2) the reader label is "VRX-vetted as of <date>" (asOfLabel) — it must never read as a live/current guarantee.
//   (3) NOTHING may GATE an action on an identity anchor (same UX invariant as the whole queue). Current-validity is
//       a SEPARATE live lookup (the in-system vetting record / a future revocation list); the anchor is added
//       provenance, not an authorization. A revocation layer (a "vetted-UNTIL" / revocation-stamp emitter) is the
//       flagged follow-on — see OPEN_ITEMS. This module deliberately only makes the ISSUANCE claim durable.
//
// ── PRIVACY — HASH-ONLY ─────────────────────────────────────────────────────────────────────────────────
// We anchor only the SALTED SEAL of a descriptor that contains: the account HANDLE (already a public identity handle
// in this system — it appears in channels/conversations/offers), a neutral vetting TIER label, and `vettedAt`. No
// legal name, no KYC payload, no document — those live in the KYC vault off-chain; their hash is never even in this
// descriptor. The seal's salt stays with us (never on-chain), so WE can re-prove a specific issuance later while an
// outside observer sees only "some VRX identity attestation existed at T". The `ref` is the account handle so a
// reader finds an account's badge by its existing id (anchorsForRef) — no new parallel id ([[vrx-deal-uid-is-requestId]]).
//
// ── BATCHING ─────────────────────────────────────────────────────────────────────────────────────────────────
// `anchorIdentityBatch` accepts MANY identities in one call (the "batched" in the roadmap item): each is sealed +
// anchored independently and the one OTS worker PACES them (OTS_TICK_MS between phase advances), so a bulk onboarding
// wave becomes a steady drain, not a thundering herd. (True Merkle-aggregation of thousands into a SINGLE Bitcoin tx
// is a provider-level optimization flagged for later in ots-anchor.ts; at this layer "batch" = many queued anchors.)

import { sealRecord, type Seal } from "./seal";
import { anchor, anchorsForRef, type OtsView } from "./ots-anchor";
import { now as vrxNow } from "./clock";
import { localDateStamp } from "./format-time";
import { readNearWitness, witnessStamp, type WitnessStamp } from "./near-witness";

/** The seal domain for identity stamps — EXPORTED so an external tool can re-derive/verify a stamp years later
 *  (the salt lives with us; the domain is the public namespace). Distinct from vrx-sp-scan / vrx-deposit-evidence. */
export const IDENTITY_SEAL_DOMAIN = "vrx-identity-stamp";

/** The vetting tiers VRX issues — neutral role labels, NOT a trust score and NOT PII. Open-ish: the known roles plus
 *  a catch-all so a new participant kind doesn't need a type change here. */
export type VettingTier = "developer" | "agency" | "agent" | "buyer" | "operator" | "other";

/** The HASH-ONLY descriptor that gets sealed. Carries NO PII beyond the account handle (already public in-system),
 *  NO KYC payload, NO document. `vettedAt` is load-bearing: the anchored claim is ALWAYS "vetted as of this T", never
 *  "currently vetted" (see the freshness trap above). `v` versions the shape for future additive fields. */
export type IdentityDescriptor = {
  v: 1;
  kind: "identity_vetting";
  account: string;
  tier: VettingTier;
  vettedAt: number; // ms epoch — the moment VRX asserts this vetting. The whole claim is relative to THIS.
  /** OPTIONAL NEAR-block time witness: the chain height + public block time when the seal was created,
   *  binding the asserted `vettedAt` to a trustless, operator-unforgeable chain time. Present only when the witness
   *  flag is on AND the chain was reachable (best-effort); absent = asserted-time-only (the honest offline case). */
  witness?: WitnessStamp;
};

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

const isTier = (t: unknown): t is VettingTier =>
  t === "developer" || t === "agency" || t === "agent" || t === "buyer" || t === "operator" || t === "other";

function descriptor(account: string, tier: VettingTier, vettedAt: number, witness?: WitnessStamp): IdentityDescriptor {
  // The NEAR-block witness (height + public block time) is folded into the sealed descriptor when present, so the
  // seal itself is BOUND to a trustless chain time (the adversarial-half hardening). Omitted when there's no
  // witness (offline / flag off) → a seal with {nearHeight:0} is the honest "asserted-time-only" case.
  return { v: 1, kind: "identity_vetting", account, tier, vettedAt, ...(witness && witness.nearHeight > 0 ? { witness } : {}) };
}

/** The result of one identity anchor: the account, the sealed hash that was anchored, and the seal (salt+hash — the
 *  salt is what WE keep to re-prove this exact issuance later). `null` hash means the emit was skipped (bad input) —
 *  never thrown, mirroring the fire-and-forget evidence-pack contract. */
export type IdentityStampResult = { account: string; hash: string | null; seal?: Seal };

/**
 * Seal + anchor ONE account's vetting. Returns the sealed hash it anchored (or null on a swallowed bad-input skip) —
 * NEVER throws (an onboarding wave must not fail because one handle was blank). Idempotency: the SEAL is salted, so
 * two calls for the same (account, tier, vettedAt) would seal to two different hashes → two anchors. We therefore
 * key the DELIBERATE idempotency on vettedAt: a caller stamping "the current vetting" passes a STABLE vettedAt (e.g.
 * the vetting record's own createdAt), so a replay reseals to... still a different hash (salt differs). To make a
 * re-stamp a genuine no-op, the caller checks `identityStampsForAccount` first (has this account been stamped?) — the
 * queue is first-writer-wins PER HASH, but distinct salts defeat that, so dedup is the caller's choice via vettedAt +
 * the "already stamped?" read. For the common path (stamp each newly-vetted user ONCE), that's a single clean anchor.
 */
export async function anchorIdentityStamp(args: {
  account: string;
  tier: VettingTier;
  vettedAt?: number;
  now?: number;
  /** Explicitly supply a witness (tests / a caller that already read one). If omitted AND VRX_NEAR_WITNESS=1, this
   *  reads one best-effort. If omitted and the flag is off, the seal is asserted-time-only (the default). */
  witness?: WitnessStamp;
}): Promise<IdentityStampResult> {
  try {
    const account = clean(args.account);
    if (!account) return { account: "", hash: null };
    const tier: VettingTier = isTier(args.tier) ? args.tier : "other";
    // vettedAt defaults to now, but a caller SHOULD pass the vetting record's own stable timestamp so the anchored
    // "as of T" matches the real vetting moment (not the stamping moment). Both are honest; the record's T is truer.
    const vettedAt = Number.isFinite(args.vettedAt) ? Number(args.vettedAt) : (args.now ?? vrxNow());
    // NEAR-block witness: bind the seal to a trustless chain time when VRX_NEAR_WITNESS=1 (else off, so
    // the default path stays offline/deterministic). BEST-EFFORT — a failed read → no witness, the seal still stands.
    let witness = args.witness;
    if (!witness && process.env.VRX_NEAR_WITNESS === "1") {
      witness = witnessStamp(await readNearWitness());
    }
    const seal = sealRecord(descriptor(account, tier, vettedAt, witness), IDENTITY_SEAL_DOMAIN);
    // ANCHOR the seal hash, kind=identity, keyed on the account handle so a reader finds the badge by the existing id.
    await anchor(seal.hash, "identity", account);
    return { account, hash: seal.hash, seal };
  } catch {
    // Swallowed by contract — an in-system vetting fact still stands; only the OTS assurance was skipped.
    return { account: clean(args.account), hash: null };
  }
}

/**
 * BATCHED — seal + anchor MANY accounts' vettings in one call (the roadmap's "batched identity stamping"). Each is
 * anchored independently; the one OTS worker PACES them, so a bulk onboarding wave drains steadily rather than
 * hammering the calendar. Returns a result per input (preserving order), with a null hash for any skipped/blank input.
 * Never throws — a single bad entry can't sink the batch.
 */
export async function anchorIdentityBatch(
  entries: Array<{ account: string; tier: VettingTier; vettedAt?: number }>,
  now?: number
): Promise<IdentityStampResult[]> {
  if (!Array.isArray(entries)) return [];
  const stampedAt = now ?? vrxNow();
  const out: IdentityStampResult[] = [];
  // Sequential (not Promise.all) so the serialized OTS store writes don't contend — the queue's mutate chain
  // serializes anyway, but issuing them in order keeps the anchors' submittedAt monotonic for a stable batch view.
  for (const e of entries) {
    out.push(await anchorIdentityStamp({ account: e.account, tier: e.tier, vettedAt: e.vettedAt, now: stampedAt }));
  }
  return out;
}

/**
 * FIRE-AND-FORGET — kick off a batch WITHOUT the caller awaiting (for a request hot path, e.g. an onboarding route
 * that shouldn't wait on seals/anchors). Errors are already swallowed inside anchorIdentityStamp; the .catch guards
 * against an unhandled rejection on the detached promise. Use the awaitable fns in tests to assert the anchor landed.
 */
export function emitIdentityBatch(entries: Array<{ account: string; tier: VettingTier; vettedAt?: number }>): void {
  void anchorIdentityBatch(entries).catch(() => {
    /* detached + already-swallowed; the in-system vetting fact already stands */
  });
}

/** A reader-facing label for an identity anchor — ALWAYS "as of <date>", never a current-validity claim. `vettedAt`
 *  is the descriptor time the caller stamped; the anchor's own status (pending/proven) comes from the OtsView.label.
 * `tz` is the VIEWER's timezone (so the date respects their day boundary, not UTC); omit for the
 *  project default (Asia/Bangkok). */
export function asOfLabel(view: Pick<OtsView, "status">, vettedAt: number, tz?: string): string {
  const when = vettedAt > 0 ? localDateStamp(vettedAt, tz) : "an earlier date";
  const seal = view.status === "proven" ? "Bitcoin-anchored" : view.status === "failed" ? "anchoring unavailable" : "Bitcoin confirmation pending";
  return `VRX-vetted as of ${when} (${seal})`;
}

/** All identity anchors for an account (newest first) — a reader surface renders their pending/proven status.
 *  Filtered to kind=identity so an account's OTHER anchors (if any ever share the handle as a ref) don't leak in. */
export async function identityStampsForAccount(account: string): Promise<OtsView[]> {
  const a = clean(account);
  if (!a) return [];
  return (await anchorsForRef(a)).filter((v) => v.kind === "identity");
}
