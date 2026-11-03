// AI DESK — grant_exclusive ON-CHAIN LEG (V7-WISHLIST #4). SERVER-ONLY.
//
// This is the on-chain leg for the AI-desk SIGNING SEAM (lib/ai-desk/signing-seam.ts). The seam has two named
// `⚠ V7 SWAP POINT`s: on an APPROVED one-time vault authorization (slice 9), the seam should fire the REAL
// on-chain firm-hold `grant_exclusive(unit_key, org_id, window_ns)` (contract/src/lib.rs:1402 — NODE-signed by
// the desk developer). This module is that leg. It is the AI-desk twin of booking-tokens-onchain.ts and
// follows its proven shape EXACTLY: a pure PLANNER + a pluggable TRANSPORT that DEFAULTS to a dry-run recorder.
//
// ── ANTI-WASTE: DRY-RUN BY DEFAULT (the whole point of the slice's shape) ───────────────────────────────────
// `grant_exclusive` already exists in the contract SOURCE but is NOT on testnet — the live V6 contract on
// calculating-hand.testnet predates the whole V7 batch, which rides ONE future `migrate7` hop (the gated
// click). AND there is no server-side NODE signing key the route could use (dev-signer.ts is localnet+browser
// only; the whole vault design exists precisely because "the route never holds a key"). Wiring a real signed
// call now would fire against a contract that is on no network, with a key that does not exist — exactly "pinned
// to a foundation still planned to move." So this module PROVES the mapping via a pure PLANNER (`planGrant` /
// `planRelease`) + a pluggable TRANSPORT defaulting to a DRY-RUN recorder (records the intended call, touches no
// chain). The live near-api-js transport is a one-line `setTransport` swap at V7 deploy — the cheap/real split.
//
// ── WHAT SIGNS WHAT (boundary) ───────────────────────────────────────────────────────────────────────────
// grant_exclusive is NODE-signed: the predecessor the contract asserts is the DESK DEVELOPER (`caller` in nodes).
// The beneficiary `org_id` is the desk's HOUSE ORG (lib/developers.houseOrgFor) — the party the exclusive is
// granted TO. `unit_key` is the opaque firm-hold key (no PII, no plaintext terms). `window_ns` is the hold
// window as a raw u64 (daysToWindowNs caps it at 100 days; a JS number is exact to ~104 days). The deposit, the
// buyer PII, the money leg — all off-chain only, never in these args.

import { getDeveloper, houseOrgFor } from "../developers";

// ── The planned on-chain call (what the transport sends, or the dry-run records) ────────────────────────────

/** A single on-chain call: the contract method, its args, who signs it, and the attached deposit. `signer` is the
 *  account the contract asserts as predecessor (grant_exclusive/release_exclusive are both NODE-signed → the desk
 *  developer). `deposit` = yoctoNEAR (string, near-api-js convention) — these verbs are `#[payable]` and also pay
 *  storage, so a live transport attaches the full storage-covering deposit; the dry-run uses "0". Pure data. */
export type ExclusiveCall = {
  method: "grant_exclusive" | "release_exclusive";
  args: Record<string, unknown>;
  signer: string; // the desk developer (node) the contract asserts as predecessor
  deposit: string; // yoctoNEAR (string). "0" in dry-run; a live transport supplies the real storage deposit.
};

/** The result of planning the on-chain leg: EITHER a concrete call, OR a typed GAP the seam records honestly and
 *  places NO on-chain leg for. `no_house_org` = the desk has no registered house org (grant_exclusive has no
 *  beneficiary — the human path fails closed here too, DirectEnquiries "No house org configured for this desk").
 *  `bad_window`/`bad_unit_key` guard malformed input. Pure + testable. */
export type ExclusivePlan =
  | { kind: "call"; call: ExclusiveCall }
  | { kind: "gap"; reason: "no_house_org" | "bad_unit_key" | "bad_window" };

/** Plan a grant_exclusive on-chain leg. PURE — the caller resolves `orgId` (via houseOrgForDesk) and passes it in,
 *  so this stays a pure mapping with no fs/network. `unitKey` is the opaque firm-hold key; `windowNs` the hold
 *  window (must be a finite positive integer ns — daysToWindowNs produces one). The signer is the desk developer. */
export function planGrant(desk: string, unitKey: string, orgId: string | null, windowNs: number): ExclusivePlan {
  if (!orgId) return { kind: "gap", reason: "no_house_org" };
  if (!unitKey.trim()) return { kind: "gap", reason: "bad_unit_key" };
  if (!Number.isInteger(windowNs) || windowNs <= 0) return { kind: "gap", reason: "bad_window" };
  return {
    kind: "call",
    call: {
      method: "grant_exclusive",
      // window_ns is a RAW u64 on the contract (JSON NUMBER only — a quoted string panics). daysToWindowNs caps
      // at 100 days so the value stays an exact JS number (2^53 ns ≈ 104 days). Mirrors vrx.grantExclusiveArgs.
      args: { unit_key: unitKey, org_id: orgId, window_ns: windowNs },
      signer: desk,
      deposit: "0",
    },
  };
}

/** Plan the reverse — release_exclusive(unit_key). NODE-signed by the SAME desk developer (the contract asserts
 *  the exclusive's `by` == caller). No org/window needed. The off-chain soft-hold tombstone is the seam's job;
 *  this is only the chain leg. */
export function planRelease(desk: string, unitKey: string): ExclusivePlan {
  if (!unitKey.trim()) return { kind: "gap", reason: "bad_unit_key" };
  return {
    kind: "call",
    call: { method: "release_exclusive", args: { unit_key: unitKey }, signer: desk, deposit: "0" },
  };
}

/** Resolve a desk developer's house org (the exclusive's beneficiary) — the SAME derivation the human path uses
 *  (api/direct-deposits → houseOrgFor). null ⇒ the desk has no house org ⇒ planGrant returns a `no_house_org`
 *  gap (fail-closed, matching the human UI). Kept out of the pure planner so the planner needs no fs. */
export async function houseOrgForDesk(desk: string): Promise<string | null> {
  const dev = await getDeveloper(desk);
  return houseOrgFor(dev);
}

// ── The TRANSPORT seam (dry-run by default; live near-api-js swapped in at V7 deploy) ───────────────────────
//
// A transport takes a planned ExclusiveCall and SENDS it, returning the on-chain tx hash. The DEFAULT transport
// is a DRY-RUN recorder: it records the call and returns a synthetic tx WITHOUT touching any chain — so the whole
// pipeline (seam → plan → send) is exercised + tested against the undeployed contract with zero waste. The live
// transport (near-api-js functionCall signed by the desk NODE key, via the per-action vault's scoped function-
// call access key) is registered via `setTransport` when V7 is on testnet — a one-line swap, nothing above
// changes. This mirrors booking-tokens-onchain.ts so both on-chain legs swap the same way at V7.

export type ExclusiveResult = { txHash: string; dryRun: boolean };
export type ExclusiveTransport = (call: ExclusiveCall) => Promise<ExclusiveResult>;

/** The dry-run recorder: logs every intended call to an in-memory ledger, returns a synthetic tx, touches NO
 *  chain. A test inspects `.calls` to assert the planner produced the right verb+args+signer. */
export class DryRunTransport {
  readonly calls: ExclusiveCall[] = [];
  send: ExclusiveTransport = async (call: ExclusiveCall): Promise<ExclusiveResult> => {
    this.calls.push(call);
    return { txHash: `dryrun-exclusive-${this.calls.length}`, dryRun: true };
  };
}

// Module-level active transport. Defaults to a shared dry-run recorder (: no live calls until V7).
let activeTransport: ExclusiveTransport = new DryRunTransport().send;

/** Is a LIVE (non-dry-run) transport registered? The seam flips kind:"on_chain"/onChain:true ONLY when this is
 *  true AND the call actually succeeded — otherwise an operator reading "on-chain" would be lied to. */
let live = false;

/** Swap the active transport. At V7 deploy, register a live near-api-js transport (`live:true`) that signs each
 *  call AS `call.signer` with the scoped node function-call access key. The dry-run default stays `live:false`.
 *  ⚠ OBFUSCATION (V7-WISHLIST #6): the deploy wasm renames its method exports to opaque names, so the live
 *  transport MUST send `onchainMethod(call.method)` as the functionCall `methodName`, NOT `call.method` directly
 *  (identity unless `VRX_ONCHAIN_OBFUSCATED=1`). See ../onchain-name-map.ts + contract/obfuscation/README.md. */
export function setTransport(t: ExclusiveTransport, isLive = true): void {
  activeTransport = t;
  live = isLive;
}

/** Is the leg wired to a real chain right now? (false under the dry-run default — the seam stays off-chain.) */
export function isLive(): boolean {
  return live;
}

/** Reset to a FRESH dry-run transport (returns it so a test can inspect `.calls`). Clears `live`. */
export function resetToDryRun(): DryRunTransport {
  const t = new DryRunTransport();
  activeTransport = t.send;
  live = false;
  return t;
}

/** Send a planned call through the active transport. A `gap` plan sends nothing (returns null — the seam records
 *  the gap and places no on-chain leg). */
export async function sendExclusive(plan: ExclusivePlan): Promise<ExclusiveResult | null> {
  if (plan.kind !== "call") return null;
  return activeTransport(plan.call);
}
