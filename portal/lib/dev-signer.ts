"use client";

// VRX god-mode LOCAL SIGNER — DEV-ONLY, LOCALNET-ONLY.
// Purpose: drive the REAL browser UI as any user WITHOUT a wallet popup, by signing writes with a
// local near-api-js KeyPair against our own localnet (:3030) instead of Meteor. This kills the
// dev/agency/agent/buyer walletlessly.
// ⚠️ THE HARD FENCE (the whole safety story — this must be impossible to arm in prod):
// The signer REFUSES to do anything unless BOTH hold:
// (1) NEXT_PUBLIC_VRX_LOCAL_SIGNER === "1" (explicit opt-in flag), AND
// (2) the active RPC (config.RPC_URL) is a LOCALNET loopback on port 3030
// (localhost / 127.0.0.1 / [::1], port 3030).
// If the FLAG is set but the RPC is NOT localnet, we FAIL LOUD (throw) rather than silently fall
// through to a real-network signer — a misconfigured.env must never sign against testnet/mainnet
// with a raw key. (Mirrors the localnet-guard near-miss lesson.) A matching server-side fence
// lives in app/api/dev-keys/route.ts, so neither the client flag nor the server alone is the gate.

import { KeyPair, keyStores, Account, Near } from "near-api-js";
import { CONTRACT_ID, NETWORK, RPC_URL } from "./config";
import { LOCAL_SIGNER_FLAG, isLocalnetRpc } from "./dev-signer-fence";

// Re-export the shared fence primitives so existing importers keep working. The SAME predicate +
// flag back the server route (app/api/dev-keys/route.ts) — both fences read one source (audit fix).
export { LOCAL_SIGNER_FLAG, isLocalnetRpc };

/**
 * The fence verdict. Returns true ONLY when god-mode is both opted-in AND pointed at localnet:3030.
 * When the flag is set but RPC is NOT localnet, THROWS (fail-loud) — never silently returns false,
 * so a prod/testnet misconfig with the flag left on can never quietly sign with a raw key.
 */
export function isLocalGodMode(): boolean {
  if (!LOCAL_SIGNER_FLAG) return false; // flag off → ordinary wallet path, no god-mode
  if (!isLocalnetRpc(RPC_URL)) {
    throw new Error(
      `[VRX dev-signer] REFUSING TO ARM: NEXT_PUBLIC_VRX_LOCAL_SIGNER=1 but RPC_URL is "${RPC_URL}" ` +
        `(not localnet :3030). The god-mode signer may ONLY run against a local chain. ` +
        `Unset the flag, or point NEXT_PUBLIC_NEAR_RPC at http://127.0.0.1:3030.`
    );
  }
  return true;
}

// ── Local key cache (fetched once from the dev-only /api/dev-keys route) ─────────────────────────
// The browser can't read the WSL localnet keystore, so the provisioning script writes demo keys to
// portal/.data/dev-keys.json (gitignored) and the dev-only API route serves them — but ONLY under the
// same localnet+flag fence. We cache the map in module scope for the session.
type DevKeyMap = Record<string, string>; // accountId -> "ed25519:<secret>"
let keyCache: DevKeyMap | null = null;

async function loadDevKeys(): Promise<DevKeyMap> {
  if (keyCache) return keyCache;
  const res = await fetch("/api/dev-keys");
  if (!res.ok) {
    throw new Error(
      `[VRX dev-signer] /api/dev-keys returned ${res.status}. Run the provisioning script first ` +
        `(scripts/provision-localnet.mjs) and confirm the server fence allows localnet.`
    );
  }
  const data = (await res.json()) as { keys?: DevKeyMap };
  keyCache = data.keys ?? {};
  return keyCache;
}

/** Reset the cached dev keys (e.g. after re-provisioning a wiped chain). */
export function resetDevKeyCache() {
  keyCache = null;
}

// Build a near-api-js Near connection against localnet:3030 with an in-memory keystore for one account.
async function accountFor(accountId: string): Promise<Account> {
  if (!isLocalGodMode()) {
    throw new Error("[VRX dev-signer] accountFor called outside god-mode — fence blocked it.");
  }
  const keys = await loadDevKeys();
  const secret = keys[accountId];
  if (!secret) {
    throw new Error(
      `[VRX dev-signer] no local key for "${accountId}". Provision it (scripts/provision-localnet.mjs) ` +
        `and re-run — a wiped chain regenerates keys.`
    );
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NETWORK, accountId, KeyPair.fromString(secret as `ed25519:${string}`));
  const near = new Near({
    networkId: NETWORK,
    nodeUrl: RPC_URL, // already fence-verified as localnet :3030
    keyStore,
  });
  return new Account(near.connection, accountId);
}

/**
 * God-mode local FunctionCall: sign+send `method(args)` to CONTRACT_ID as `accountId` using the
 * local keypair, against localnet:3030. No wallet popup, no public RPC. Returns the tx hash.
 * Fence-guarded at every entry (isLocalGodMode throws/false; accountFor re-checks).
 */
export async function devCallFunction(args: {
  accountId: string;
  method: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}): Promise<string> {
  const account = await accountFor(args.accountId);
  const outcome = await account.functionCall({
    contractId: CONTRACT_ID,
    methodName: args.method,
    args: args.args,
    gas: BigInt(args.gas),
    attachedDeposit: BigInt(args.deposit),
  });
  return outcome.transaction?.hash ?? "";
}
