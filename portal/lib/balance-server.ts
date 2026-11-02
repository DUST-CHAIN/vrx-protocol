// Account balance reader — SERVER-ONLY (near-api-js providers, no signer).
// WHY server-side: the client wallet context (lib/wallet.tsx) is a pure signer — it never reads a
// balance. The gear menu showed a placeholder "$0.00" because nothing ever fetched the real number.
// This reads view_account through the same failover providers vrx-server.ts uses, so a 429 on one
// endpoint falls back to the other instead of surfacing a false zero.
// PRIVACY: an account's NEAR balance is public on-chain anyway; this reads only the amount + storage,
// no contract state, no opaque refs.

import { providers } from "near-api-js";
import { serverProviders, RPC_URLS } from "./config";
import { countRpc } from "./rpc-usage";
import { activeKeys } from "./fastnear-keys";

const PROVIDERS = serverProviders(providers);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// KEYED providers for the eligibility balance read ( §9). Reads are keyless-by-default, BUT the
// balance read that gates a deposit/firm-hold is a HARD BLOCKER — a shared-IP 429 here wrongly fails the bar
// closed and blocks a real deposit (the exact flakiness seen in live testing). Same reasoning the /api/rpc
// write proxy uses: attach a key for the blocker path specifically. Built lazily (keys load async) + cached;
// falls back to the unkeyed PROVIDERS when no keys are configured. Keyed attempts are tried FIRST.
let keyedProviders: InstanceType<typeof providers.JsonRpcProvider>[] | null = null;
async function providersPreferKeyed(): Promise<InstanceType<typeof providers.JsonRpcProvider>[]> {
  if (keyedProviders) return keyedProviders;
  try {
    const keys = (await activeKeys()).map((k) => k.key).filter(Boolean);
    const keyed: InstanceType<typeof providers.JsonRpcProvider>[] = [];
    for (const key of keys) {
      for (const url of RPC_URLS) {
        keyed.push(new providers.JsonRpcProvider({ url, headers: { Authorization: `Bearer ${key}` } }));
      }
    }
    // Keyed first (dodge the shared 429), then the unkeyed server providers as a last resort.
    keyedProviders = keyed.length ? [...keyed, ...PROVIDERS] : PROVIDERS;
  } catch {
    keyedProviders = PROVIDERS;
  }
  return keyedProviders;
}

/** Cost of one byte of on-chain storage, in yoctoNEAR (NEAR protocol constant: 1e19 yocto / byte). */
const STORAGE_COST_PER_BYTE = 10n ** 19n;

/**
 * PURE balance math, split out of the networked read so it's testable without an RPC. Given the raw
 * `view_account` reply (amount in yocto, storage_usage in bytes), derive the spendable balance. The
 * subtlety this pins: `availableYocto` CLAMPS to 0 (an account whose storage reservation exceeds its
 * balance must never surface a negative/false-spendable figure — the exact "false display" bug this
 * module exists to prevent), and `availableNear` is a lossy /1e18-then-/1e6 reduction to a 6-dp NEAR
 * number for display only (never for settlement math).
 */
export function computeBalance(amountYocto: bigint, storageUsageBytes: number | bigint): Balance {
  const yocto = amountYocto;
  const lockedForStorage = BigInt(storageUsageBytes) * STORAGE_COST_PER_BYTE;
  const availableYocto = yocto > lockedForStorage ? yocto - lockedForStorage : 0n;
  return {
    yocto,
    lockedForStorage,
    availableYocto,
    availableNear: Number(availableYocto / 10n ** 18n) / 1e6,
  };
}

export type Balance = {
  /** Raw account balance in yoctoNEAR. */
  yocto: bigint;
  /** yoctoNEAR reserved for the account's storage (can't be spent). */
  lockedForStorage: bigint;
  /** Spendable = yocto − lockedForStorage (never negative). What actually pays gas + toll. */
  availableYocto: bigint;
  /** Convenience: available balance as a NEAR number (5 dp), for display. */
  availableNear: number;
};

/**
 * Read an account's balance, resilient to a single-endpoint 429/wobble. Returns null ONLY if the
 * account doesn't exist (never funded). THROWS if every endpoint failed — the caller must not render
 * a false 0 during an RPC outage (the whole reason the old display was wrong). `retries` counts total
 * attempts across the rotated endpoints.
 */
export async function getBalance(accountId: string, retries = 4): Promise<Balance | null> {
  let lastErr: unknown;
  const pool = await providersPreferKeyed();
  for (let attempt = 0; attempt < retries; attempt++) {
    const provider = pool[attempt % pool.length];
    try {
      const res = await provider.query<{
        amount: string;
        storage_usage: number;
        block_height: number;
        block_hash: string;
      }>({ request_type: "view_account", account_id: accountId, finality: "optimistic" });
      countRpc(); // one keyed FastNEAR call succeeded (usage estimate)
      return computeBalance(BigInt(res.amount), res.storage_usage);
    } catch (e) {
      // near-api-js throws a typed error for a genuinely-absent account — that's a definitive "null",
      // not an RPC failure, so don't retry/rotate on it.
      if (isUnknownAccount(e)) return null;
      lastErr = e;
      if (attempt < retries - 1) await sleep(250 * 2 ** attempt);
    }
  }
  throw lastErr ?? new Error("balance_unavailable");
}

export function isUnknownAccount(e: unknown): boolean {
  // near-api-js throws a TypedError with type "AccountDoesNotExist" and a message like
  // "…account X doesn't exist" (note the contraction). Match the type field first, then the text.
  const type = (e as { type?: string })?.type;
  if (type === "AccountDoesNotExist" || type === "UNKNOWN_ACCOUNT") return true;
  const msg = (e as { message?: string })?.message ?? "";
  return /does ?n['’]?t exist|UNKNOWN_ACCOUNT/i.test(msg);
}
