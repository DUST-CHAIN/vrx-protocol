// BOOKING TOKENS — ON-CHAIN MIRROR ADAPTER (slice d). SERVER-ONLY.
//
// This is the seam that was DESIGNED IN from slice 1 (booking-tokens.ts header: "built so the later on-chain
// swap (V7+) is a seam change, not a rewrite", design §"On-chain timing"). The off-chain `booking-tokens.ts`
// stays the system of record for the MONEY + evidence half (amounts/cash/evidence NEVER on-chain). The
// on-chain registry (contract/src/lib.rs token verbs, built) owns EXISTENCE + CUSTODY + SCARCITY.
// This module is the bridge: it translates an off-chain mutation into the exact on-chain call that mirrors it.
//
// ── ANTI-WASTE: DRY-RUN BY DEFAULT (the whole point of slice d's shape) ─────────────────────────────────────
// The on-chain token verbs are NOT deployed — the V6 contract is live on calculating-hand.testnet; the whole V7
// batch (these verbs + paused + attestations) rides ONE future `migrate7` hop (the gated click). Wiring
// REAL signed calls now would fire against a contract that isn't on any network AND need server-side node/VRX
// signing keys that don't exist (dev-signer.ts is localnet+browser only). That is exactly "pinned to a
// foundation still planned to move". So this adapter PROVES the mapping is correct via a pure PLANNER
// (`planMirror`) + a pluggable TRANSPORT that DEFAULTS to a dry-run recorder (captures the intended calls, touches
// no chain). Swapping in the live near-api-js transport when V7 deploys is a one-line change at `setTransport` —
// the cheap/real split the design asked for (§"confirm the off-chain seam is swap-ready before V7 schema lock").
//
// ── WHAT MIRRORS, WHAT DOESN'T (boundary) ────────────────────────────────────────────────────────────────
// The contract has 6 states: 0 issued · 1 with_agency · 2 with_agent · 3 committed · 4 recycled · 5 frozen.
// The off-chain lib has 9: those same 6 PLUS 3 MONEY states — cash_taken / reconciling / settled. The money
// states DO NOT MIRROR (they collapse to on-chain `committed` 3 — the token is still committed on-chain; the
// cash leg is off-chain only). So recordCash / confirmCash / disputeCash produce NO on-chain call. Likewise the
// issuance FEE, economics, and tokenPayment amounts never leave off-chain. Only custody/scarcity transitions do.
//
// ── ID MAP (off-chain string id ⇄ on-chain u64) ─────────────────────────────────────────────────────────────
// Off-chain ids are `bt-<ts>-<hex>` strings; on-chain ids are sequential u64 (`next_token_id`). Issuance returns
// the on-chain ids — we persist the pairing so later ops resolve the off-chain `bt-…` to its on-chain `u64`.
// Until an off-chain token has been mirror-issued, a non-issue op for it is UNRESOLVED (the planner flags it).

import { promises as fs } from "fs";
import path from "path";
import type { BookingToken, TokenState } from "./booking-tokens";

// ── On-chain state codes (mirror contract/src/lib.rs BookingToken.state) ────────────────────────────────────
export const ONCHAIN_STATE: Record<string, number> = {
  issued: 0,
  with_agency: 1,
  with_agent: 2,
  committed: 3,
  recycled: 4,
  frozen: 5,
  // The 3 MONEY states collapse to on-chain `committed` (3) — the token stays committed on-chain; the cash leg
  // is off-chain only. They never produce a mirror call, but if one ever reads a chain state for one of
  // these, this is the honest mapping.
  cash_taken: 3,
  reconciling: 3,
  settled: 3,
};

/** The on-chain state code an off-chain state maps to (money states → committed). */
export function onchainStateCode(state: TokenState): number {
  return ONCHAIN_STATE[state];
}

// ── The planned on-chain call (what the transport will send, or the dry-run records) ────────────────────────

/** A single mirrored on-chain call: the contract method, its args, and WHO signs it (each verb is signed by a
 *  specific actor — issue=owner/VRX, hand=current holder, commit=agent holder, grant_exclusive_for_token=node,
 *  clawback=the derived authority). `deposit`=yoctoNEAR (the token verbs are `#[payable]` → 1 yocto for the
 *  full-access-key assertion; issuance/views need 0). Pure data — no chain contact. */
export type MirrorCall = {
  method:
    | "issue_tokens"
    | "hand_token"
    | "freeze_token"
    | "unfreeze_token"
    | "commit_token"
    | "release_commit"
    | "recycle_token"
    | "reissue_token"
    | "grant_exclusive_for_token"
    | "clawback_token";
  args: Record<string, unknown>;
  signer: string; // the account that must sign this call (predecessor the contract asserts)
  deposit: string; // yoctoNEAR (string, near-api-js convention). "1" for #[payable] verbs, "0" for views.
};

/** The off-chain ops this adapter can mirror. The MONEY ops (recordCash/confirmCash/disputeCash) are absent by
 * design — they produce no on-chain call. `transfer` mirrors `hand_token`; `thaw`→`unfreeze_token`;
 *  `recall`(bilateral/vrx)→`clawback_token`; `commit`→`commit_token`; etc. */
export type MirrorOp =
  | { op: "issue"; developer: string; count: number }
  | { op: "transfer"; token: BookingToken; to: string }
  | { op: "freeze"; token: BookingToken; by: string }
  | { op: "thaw"; token: BookingToken; by: string }
  | { op: "commit"; token: BookingToken; by: string; unitKey: string }
  | { op: "release"; token: BookingToken; by: string }
  | { op: "recycle"; token: BookingToken; by: string }
  | { op: "reissue"; token: BookingToken; by: string }
  | { op: "grantExclusive"; token: BookingToken; node: string; windowNs: number }
  | { op: "clawback"; token: BookingToken; authority: string };

/** The result of planning a mirror: EITHER a concrete on-chain call, OR an UNRESOLVED flag (the off-chain token
 *  has no on-chain id yet — it was never mirror-issued) OR a NO-OP (a money-only op that doesn't mirror). The
 *  caller (route) decides what to do: send the call via the transport, or record the gap. Pure + testable. */
export type MirrorPlan =
  | { kind: "call"; call: MirrorCall }
  | { kind: "noop"; reason: string } // a money/off-chain-only op — nothing mirrors
  | { kind: "unresolved"; reason: string }; // the off-chain token has no on-chain id mapped yet

// ── The id map store (off-chain `bt-…` ⇄ on-chain u64) ──────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), ".data");
const IDMAP = path.join(DATA_DIR, "booking-token-idmap.json");

/** off-chain id → on-chain u64 (one entry per mirror-issued token). */
export type IdMap = Record<string, number>;

let idMapChain: Promise<unknown> = Promise.resolve();
function mutateIdMap<T>(fn: (m: IdMap) => Promise<{ next: IdMap; ret: T }>): Promise<T> {
  const run = idMapChain.then(async () => {
    const m = await readIdMap();
    const { next, ret } = await fn(m);
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(IDMAP, JSON.stringify(next, null, 2), "utf8");
    return ret;
  });
  idMapChain = run.catch(() => {});
  return run as Promise<T>;
}

export async function readIdMap(): Promise<IdMap> {
  try {
    const raw = await fs.readFile(IDMAP, "utf8");
    const p = JSON.parse(raw);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as IdMap) : {};
  } catch {
    return {};
  }
}

/** The on-chain u64 for an off-chain token id, or null if it has not been mirror-issued yet. */
export async function onchainIdFor(offchainId: string): Promise<number | null> {
  const m = await readIdMap();
  const v = m[offchainId];
  return typeof v === "number" ? v : null;
}

/** Record the off-chain⇄on-chain id pairing after a mirror issuance returns the on-chain ids. */
export async function mapIds(pairs: Array<{ offchainId: string; onchainId: number }>): Promise<void> {
  await mutateIdMap(async (m) => {
    const next = { ...m };
    for (const { offchainId, onchainId } of pairs) next[offchainId] = onchainId;
    return { next, ret: undefined };
  });
}

// ── The PLANNER (pure — no chain, no fs; the whole mapping lives here, fully unit-testable) ─────────────────
//
// `onchainId` is resolved by the CALLER (via onchainIdFor) and passed in, so the planner stays pure. For the
// `issue` op there is no prior id (issuance MINTS it) — pass onchainId=null. Every non-issue op REQUIRES an
// on-chain id; a null there yields an `unresolved` plan (the token was never mirror-issued — the route logs it).

/** Plan the on-chain mirror for an off-chain op. Pure. `onchainId` = the token's mapped u64 (null if unmapped
 *  or an issuance). Returns a MirrorPlan the caller sends via the transport (or records as a gap). The signer is
 *  the account the contract asserts as predecessor for that verb (so a live transport knows which key to use). */
export function planMirror(op: MirrorOp, onchainId: number | null): MirrorPlan {
  const PAY = "1"; // #[payable] token verbs want 1 yoctoNEAR (full-access-key assertion)

  if (op.op === "issue") {
    // Issuance MINTS the on-chain ids (owner/VRX-signed). count is clamped 1..=100 by the contract; mirror the
    // off-chain batch 1:1. No prior onchainId (this creates them). The caller maps the returned ids after send.
    return {
      kind: "call",
      call: { method: "issue_tokens", args: { developer: op.developer, count: op.count }, signer: "vrx", deposit: "0" },
    };
  }

  // Every other op needs the token's on-chain id. Unmapped ⇒ it was never mirror-issued → surface the gap.
  if (onchainId === null) {
    return { kind: "unresolved", reason: `off-chain token ${op.token.id} has no on-chain id (never mirror-issued)` };
  }
  const token_id = onchainId;

  switch (op.op) {
    case "transfer":
      // Off-chain transferToken → on-chain hand_token (one step along the trust graph). Signed by the CURRENT
      // holder (the token's custody before the move), which the contract asserts. economics/payment are
      // off-chain-only → not in the on-chain args.
      return {
        kind: "call",
        call: { method: "hand_token", args: { token_id, to: op.to }, signer: op.token.custody, deposit: PAY },
      };

    case "freeze":
      return {
        kind: "call",
        call: { method: "freeze_token", args: { token_id }, signer: op.by, deposit: PAY },
      };

    case "thaw":
      // Off-chain thawToken → on-chain unfreeze_token (the contract's name for the same transition).
      return {
        kind: "call",
        call: { method: "unfreeze_token", args: { token_id }, signer: op.by, deposit: PAY },
      };

    case "commit":
      // The agent SPENDS the slot. unit_key is the opaque firm-hold key. Signed by the agent holder.
      return {
        kind: "call",
        call: { method: "commit_token", args: { token_id, unit_key: op.unitKey }, signer: op.by, deposit: PAY },
      };

    case "release":
      return {
        kind: "call",
        call: { method: "release_commit", args: { token_id }, signer: op.by, deposit: PAY },
      };

    case "recycle":
      return {
        kind: "call",
        call: { method: "recycle_token", args: { token_id }, signer: op.by, deposit: PAY },
      };

    case "reissue":
      // Off-chain reissueToken(recycledId) → on-chain reissue_token(from_recycled_id). Developer-signed; mints a
      // FRESH on-chain id the caller must then map to the fresh off-chain id.
      return {
        kind: "call",
        call: { method: "reissue_token", args: { from_recycled_id: token_id }, signer: op.by, deposit: PAY },
      };

    case "grantExclusive":
      // The commit↔exclusive on-chain LINK. NODE-signed (an agent can't grant a node's exclusive); the
      // beneficiary org is DERIVED on-chain from the committed token's custody (not passed).
      return {
        kind: "call",
        call: {
          method: "grant_exclusive_for_token",
          args: { token_id, window_ns: op.windowNs },
          signer: op.node,
          deposit: PAY,
        },
      };

    case "clawback":
      // Off-chain recallToken (bilateral/vrx) → on-chain clawback_token. Signed by the derived upstream
      // authority (developer / agency / VRX). The refund (off-chain money) does NOT mirror.
      return {
        kind: "call",
        call: { method: "clawback_token", args: { token_id }, signer: op.authority, deposit: PAY },
      };
  }
}

// ── The TRANSPORT seam (dry-run by default; live near-api-js swapped in at V7 deploy) ───────────────────────
//
// A transport takes a planned MirrorCall and SENDS it, returning the on-chain tx hash (+ any return value, e.g.
// issue_tokens returns the Vec<u64> of minted ids). The DEFAULT transport is a DRY-RUN recorder: it records the
// call and returns a synthetic result WITHOUT touching any chain — so the whole pipeline is exercised + tested
// against the undeployed contract with zero waste. The live transport (near-api-js functionCall per `signer`)
// is registered via `setTransport` when V7 is on testnet — a one-line swap, no change above this seam.

export type MirrorResult = { txHash: string; returned?: unknown; dryRun: boolean };
export type MirrorTransport = (call: MirrorCall) => Promise<MirrorResult>;

/** The dry-run recorder: logs every intended call to an in-memory ledger, returns a synthetic result, touches
 *  NO chain. Issuance returns synthetic sequential ids so the id-map pipeline is exercisable end-to-end. */
export class DryRunTransport {
  readonly calls: MirrorCall[] = [];
  private nextId = 1;
  send: MirrorTransport = async (call: MirrorCall): Promise<MirrorResult> => {
    this.calls.push(call);
    // issue_tokens / reissue_token return minted on-chain ids — synthesize them so a caller can map ids.
    if (call.method === "issue_tokens") {
      const count = Number((call.args as { count?: number }).count) || 0;
      const returned = Array.from({ length: count }, () => this.nextId++);
      return { txHash: `dryrun-${this.calls.length}`, returned, dryRun: true };
    }
    if (call.method === "reissue_token") {
      return { txHash: `dryrun-${this.calls.length}`, returned: this.nextId++, dryRun: true };
    }
    return { txHash: `dryrun-${this.calls.length}`, dryRun: true };
  };
}

// Module-level active transport. Defaults to a shared dry-run recorder (: no live calls until V7).
let activeTransport: MirrorTransport = new DryRunTransport().send;

/** Swap the active transport. At V7 deploy, register a live near-api-js transport here (the one-line swap).
 *  ⚠ OBFUSCATION (V7-WISHLIST #6): the deploy wasm renames its method exports to opaque names, so the live
 *  transport MUST send `onchainMethod(call.method)` as the functionCall `methodName`, NOT `call.method`
 *  directly. `onchainMethod` is identity unless `VRX_ONCHAIN_OBFUSCATED=1`, so this is a no-op on a plain
 *  (non-obfuscated) deploy. See portal/lib/onchain-name-map.ts + contract/obfuscation/README.md. */
export function setTransport(t: MirrorTransport): void {
  activeTransport = t;
}

/** Reset to a FRESH dry-run transport (returns it so a test can inspect `.calls`). */
export function resetToDryRun(): DryRunTransport {
  const t = new DryRunTransport();
  activeTransport = t.send;
  return t;
}

/** Send a planned call through the active transport. A `noop`/`unresolved` plan sends nothing (returns null). */
export async function sendMirror(plan: MirrorPlan): Promise<MirrorResult | null> {
  if (plan.kind !== "call") return null;
  return activeTransport(plan.call);
}

/** TEST-ONLY: wipe the id-map store so a test starts clean. */
export async function __resetForTests(): Promise<void> {
  await mutateIdMap(async () => ({ next: {}, ret: undefined }));
}
