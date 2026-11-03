// VRX — LIVE on-chain TRANSPORT (V7 cutover). SERVER-ONLY.
//
// The ONE live near-api-js transport both V7 on-chain legs swap in at deploy: the booking-token MIRROR
// (booking-tokens-onchain.ts) and the AI-desk EXCLUSIVE leg (ai-desk/grant-exclusive-onchain.ts). Both
// seams were designed to a `(call) => Promise<result>` transport shape with an identical core need — sign
// `method(args)` AS a specific `signer` account and send it to the deployed contract — so this builds that
// core ONCE (the reusable-pattern rule) and each leg wraps it in a thin typed adapter. Until V7 deploys the
// seams default to their dry-run recorders; at cutover the route/bootstrap calls setTransport(make*).
//
// ── WHO SIGNS (the trust graph) ────────────────────────────────────────────────────────────────────
// Every call carries `signer` = the account the contract asserts as predecessor for that verb (issue=VRX/
// owner · hand=current holder · commit=agent · grant_exclusive[_for_token]=node · clawback=derived authority).
// A live send must sign AS that account, so this resolves the signer's secret key from a SERVER-ONLY registry
// (env `VRX_SIGNER_KEYS`, a JSON map accountId → "ed25519:<secret>"). A signer with no registered key FAILS
// LOUD (never silently sends unsigned / as the wrong account). On testnet the demo actors share keys we hold;
// on mainnet each real actor holds its own key and signs client-side — this server transport is the testnet/
// demo path (the money leg stays off-chain regardless).
//
// ── OBFUSCATION (V7-WISHLIST #6) ────────────────────────────────────────────────────────────────────────
// The deploy wasm renames method exports to opaque names; NEAR dispatches by export symbol. So the wire
// methodName MUST be onchainMethod(call.method) — identity unless VRX_ONCHAIN_OBFUSCATED=1, so this one code
// path serves both a plain and an obfuscated deploy. See lib/onchain-name-map.ts + contract/obfuscation/.

import { connect, keyStores, KeyPair, providers, type Account } from "near-api-js";
import { NETWORK, RPC_URL, CONTRACT_ID, FASTNEAR_API_KEY } from "./config";
import { onchainMethod } from "./onchain-name-map";
import type { MirrorCall, MirrorResult, MirrorTransport } from "./booking-tokens-onchain";
import { setTransport as setMirrorTransport } from "./booking-tokens-onchain";
import type { ExclusiveCall, ExclusiveResult, ExclusiveTransport } from "./ai-desk/grant-exclusive-onchain";
import { setTransport as setExclusiveTransport } from "./ai-desk/grant-exclusive-onchain";

/** Default gas for a contract call (300 TGas — the near-api-js / sandbox max; every VRX verb fits well under). */
const DEFAULT_GAS = 300_000_000_000_000n;

// ── Deposit policy (the contract's `charge` is the authority — see contract/src/lib.rs) ────────────────
// Every #[payable] VRX write ends in `charge(usage_before)`:
//   • EXEMPT caller (owner + the `exempt` list) → required deposit is 0; anything attached is refunded.
//   • NON-EXEMPT caller → must attach storage_cost (bytes_added × byte_cost) + toll; OVERPAYMENT is refunded.
// So the planners' "1"/"0" placeholders (a "payable, needs >0" intent) are NOT a safe wire amount for a
// non-exempt caller that WRITES new storage — it would trip E57 (INSUFFICIENT_DEPOSIT). The robust answer
// (the contract refunds any overage): attach a generous FIXED floor that covers any single VRX write's
// storage + toll, and let the contract refund the rest. A token/exclusive write is a few hundred bytes
// (< ~0.01 NEAR of storage at ~1e19 yocto/byte) + the sub-cent toll, so 0.05 NEAR is ample margin. The
// exempt actors (our demo signers) get it all back; a non-exempt actor pays only its true storage+toll.
// Override via env for a tuned/mainnet amount.
//
// The planner `deposit` field is NOT a reliable view/write signal: the mirror planner uses "0" for
// issue_tokens (a WRITE) and "1" for the rest, and the exclusive planner uses "0" for both (both WRITES).
// EVERY method these two transports carry is a payable WRITE (none is a view), so the live transport
// attaches this floor UNCONDITIONALLY and ignores the planner's "0"/"1" placeholder at the wire. The
// contract refunds any overage, so this is safe for exempt and non-exempt signers alike.
const DEFAULT_DEPOSIT_YOCTO = process.env.VRX_ONCHAIN_DEPOSIT_YOCTO || "50000000000000000000000"; // 0.05 NEAR

// ── Symbolic signer → real accountId ────────────────────────────────────────────────────────────────────
// The pure planners emit a SYMBOLIC signer for the owner leg: issue_tokens uses the literal `"vrx"` (the VRX/
// owner label, not an accountId — booking-tokens-onchain.ts). The contract asserts the real owner account as
// predecessor, so the live transport must resolve that label → the deployed owner account. Owner-is-self on
// every VRX deploy (owner == CONTRACT_ID; verified on calculating-hand.testnet), so `"vrx"` → CONTRACT_ID.
// Any already-real accountId (the per-actor legs: op.by / op.custody / desk = concrete *.testnet ids) passes
// through unchanged. Kept as a tiny pure map so the planners stay chain-agnostic and testable.
export function resolveSigner(signer: string): string {
  return signer === "vrx" ? CONTRACT_ID : signer;
}

// ── Signer-key registry (SERVER-ONLY) ───────────────────────────────────────────────────────────────────
// VRX_SIGNER_KEYS = JSON `{ "<accountId>": "ed25519:<secret>"... }`. Parsed once, cached. Never NEXT_PUBLIC_
// (would ship raw keys to the browser). Malformed JSON fails loud at first use (a silent {} would make every
// send "no key" — better to surface the misconfig). Empty/unset ⇒ no live signer configured (keys is {}).
let keyCache: Record<string, string> | null = null;
function signerKeys(): Record<string, string> {
  if (keyCache) return keyCache;
  const raw = process.env.VRX_SIGNER_KEYS || "";
  if (!raw.trim()) {
    keyCache = {};
    return keyCache;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("[VRX onchain-transport] VRX_SIGNER_KEYS is not valid JSON — refusing to arm the live transport.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[VRX onchain-transport] VRX_SIGNER_KEYS must be a JSON object { account: secretKey }.");
  }
  keyCache = parsed as Record<string, string>;
  return keyCache;
}

/** TEST-ONLY: reset the parsed-key cache so a test can re-point VRX_SIGNER_KEYS between cases. */
export function __resetSignerKeyCache(): void {
  keyCache = null;
}

/** Is at least one signing key configured? The cutover bootstrap checks this before swapping the live
 *  transport in — no keys ⇒ stay on dry-run (never pretend to be live with nothing to sign). */
export function hasSignerKeys(): boolean {
  return Object.keys(signerKeys()).length > 0;
}

// ── The signing account (FastNEAR-keyed RPC, mirrors faucet-server.faucetAccount) ───────────────────────
// One Account per signer, cached — rebuilding the connection per call is wasteful on a busy desk. The
// connection attaches the FastNEAR bearer key (same as the faucet's signing path that hit -429 without it).
const accountCache = new Map<string, Account>();
async function accountFor(rawSigner: string): Promise<Account> {
  const signer = resolveSigner(rawSigner); // "vrx" → owner (CONTRACT_ID); real accountIds pass through
  const cached = accountCache.get(signer);
  if (cached) return cached;
  const secret = signerKeys()[signer];
  if (!secret) {
    throw new Error(
      `[VRX onchain-transport] no signing key for "${signer}"` +
        (signer !== rawSigner ? ` (resolved from "${rawSigner}")` : "") +
        ` in VRX_SIGNER_KEYS — cannot sign this call AS the predecessor the contract asserts. ` +
        `Add its key or leave the leg on dry-run.`
    );
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NETWORK, signer, KeyPair.fromString(secret as `ed25519:${string}`));
  const near = FASTNEAR_API_KEY
    ? await connect({
        networkId: NETWORK,
        keyStore,
        nodeUrl: RPC_URL,
        provider: new providers.JsonRpcProvider({ url: RPC_URL, headers: { Authorization: `Bearer ${FASTNEAR_API_KEY}` } }),
      } as never)
    : await connect({ networkId: NETWORK, keyStore, nodeUrl: RPC_URL });
  const account = await near.account(signer);
  accountCache.set(signer, account);
  return account;
}

/** TEST-ONLY: clear cached signing accounts (so a re-pointed key is rebuilt). */
export function __resetAccountCache(): void {
  accountCache.clear();
}

// ── The shared core: sign + send one contract call AS `signer`, return hash + decoded return value ──────
/** Sign `method(args)` AS `signer` and send it to CONTRACT_ID. `deposit` = yoctoNEAR string. Applies
 * onchainMethod so an obfuscated deploy gets the opaque wire name. Returns the tx hash and the decoded
 *  SuccessValue (JSON) — issue_tokens/reissue_token return minted on-chain ids the mirror must map. */
export async function signAndSend(opts: {
  signer: string;
  method: string;
  args: Record<string, unknown>;
  deposit: string;
}): Promise<{ txHash: string; returned: unknown }> {
  const account = await accountFor(opts.signer);
  const outcome = await account.functionCall({
    contractId: CONTRACT_ID,
    methodName: onchainMethod(opts.method),
    args: opts.args,
    gas: DEFAULT_GAS,
    attachedDeposit: BigInt(opts.deposit),
  });
  const txHash = outcome.transaction?.hash ?? "";
  return { txHash, returned: decodeSuccessValue(outcome) };
}

/** Decode a FunctionCall outcome's SuccessValue (base64 JSON) → the method's return value, or undefined when
 *  the method returns nothing / the status shape is unexpected. near-api-js FinalExecutionOutcome.status is
 * `{ SuccessValue: "<base64>" }` on success; an empty string = a unit return (undefined). */
function decodeSuccessValue(outcome: unknown): unknown {
  const status = (outcome as { status?: unknown })?.status;
  const sv = (status as { SuccessValue?: string })?.SuccessValue;
  if (typeof sv !== "string" || sv === "") return undefined;
  try {
    return JSON.parse(Buffer.from(sv, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

// ── Leg adapters — each wraps signAndSend into its seam's typed transport (the thin per-consumer shim) ──

/** The booking-token MIRROR live transport. At V7 deploy:
 * import { setTransport } from "./booking-tokens-onchain"; setTransport(makeMirrorTransport);
 *  Each MirrorCall signs AS call.signer (issue=vrx · hand=holder · commit=agent · …). issue_tokens /
 *  reissue_token return minted ids (Vec<u64> / u64) in `returned` so the caller maps off-chain⇄on-chain ids. */
export function makeMirrorTransport(): MirrorTransport {
  return async (call: MirrorCall): Promise<MirrorResult> => {
    const { txHash, returned } = await signAndSend({
      signer: call.signer,
      method: call.method,
      args: call.args,
      deposit: DEFAULT_DEPOSIT_YOCTO, // every mirror verb is a payable write; floor + contract refund (see above)
    });
    return { txHash, returned, dryRun: false };
  };
}

/** The AI-desk EXCLUSIVE leg live transport. At V7 deploy:
 * import { setTransport } from "./ai-desk/grant-exclusive-onchain"; setTransport(makeExclusiveTransport);
 *  (setTransport's second arg defaults isLive=true → the seam reports on-chain only when a real send succeeds.)
 *  grant_exclusive / release_exclusive are NODE-signed (call.signer = the desk developer). */
export function makeExclusiveTransport(): ExclusiveTransport {
  return async (call: ExclusiveCall): Promise<ExclusiveResult> => {
    const { txHash } = await signAndSend({
      signer: call.signer,
      method: call.method,
      args: call.args,
      deposit: DEFAULT_DEPOSIT_YOCTO, // grant/release_exclusive are payable writes; floor + contract refund (see above)
    });
    return { txHash, dryRun: false };
  };
}

// ── The ONE-SHOT CUTOVER bootstrap — flip env flags, the transports go live, NO code edit at deploy ─────
//
// The consumers already gate their sends on VRX_ONCHAIN_MIRROR / VRX_ONCHAIN_EXCLUSIVE, but those sends route
// through the seams' DRY-RUN recorders until something calls setTransport. This idempotent bootstrap is that
// call: each gated send-site invokes it first, and the FIRST time a leg is both flag-armed AND has signing keys,
// it registers the live transport for that leg. So the V7 cutover is purely ENV:
//   VRX_ONCHAIN_OBFUSCATED=1  (deploy is obfuscated → wire names map)
//   VRX_ONCHAIN_MIRROR=1      + VRX_SIGNER_KEYS set  → mirror goes live
//   VRX_ONCHAIN_EXCLUSIVE=1   + VRX_SIGNER_KEYS set  → exclusive leg goes live
// No keys ⇒ the leg STAYS on dry-run (never pretend-live with nothing to sign) — a half-set env fails safe, not
// silently unsigned. Registered-once flags make it a no-op after the first armed call (cheap to call per-send).
let mirrorWired = false;
let exclusiveWired = false;
export function ensureLiveTransports(): void {
  if (!hasSignerKeys()) return; // no signing keys → both legs stay on their dry-run default (fail-safe)
  if (!mirrorWired && process.env.VRX_ONCHAIN_MIRROR === "1") {
    setMirrorTransport(makeMirrorTransport());
    mirrorWired = true;
  }
  if (!exclusiveWired && process.env.VRX_ONCHAIN_EXCLUSIVE === "1") {
    setExclusiveTransport(makeExclusiveTransport()); // isLive defaults true → seam reports on-chain on real send
    exclusiveWired = true;
  }
}

/** TEST-ONLY: forget which legs were wired (so a test can re-arm after changing env). */
export function __resetWiring(): void {
  mirrorWired = false;
  exclusiveWired = false;
}
