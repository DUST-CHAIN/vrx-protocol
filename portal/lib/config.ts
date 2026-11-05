// VRX portal — network + contract config.
// Testnet-first: the portal talks to the LIVE deployed contract on testnet.
// The contract account id is intentionally neutral/non-identifying (privacy moat) — do not
// rename it to anything project- or domain-revealing.

export type NetworkId = "testnet" | "mainnet";

export const NETWORK: NetworkId =
  (process.env.NEXT_PUBLIC_NEAR_NETWORK as NetworkId) || "testnet";

// The live VRX reservation contract (owner-gated build, hash 87fc4fb7…).
// Override via env for a different deploy (e.g. a fresh test account or mainnet).
export const CONTRACT_ID =
  process.env.NEXT_PUBLIC_VRX_CONTRACT || "calculating-hand.testnet";

// Public RPC endpoints. FastNEAR is the near-api-js 5.x default in the docs and is CORS-friendly
// for browser reads. Swap via env if one is flaky (RPC/DNS can wobble — see DEPLOY.md gotchas).
export const RPC_URL =
  process.env.NEXT_PUBLIC_NEAR_RPC ||
  (NETWORK === "mainnet"
    ? "https://rpc.mainnet.fastnear.com"
    : "https://test.rpc.fastnear.com");

// Failover endpoints. ⚠️ FINDING: the old testnet fallback `rpc.testnet.near.org` is now DEPRECATED
// AND rate-limited — it returns 429 "THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW!" on every call. It
// was actively HURTING us: viewWithRetry rotated onto it, wasting attempts and often landing the FINAL
// attempt on a dead endpoint → false rpcError / "no access" (the flaky picker hit). Removed it.
// FastNEAR (test.rpc.fastnear.com) is the only reliably-working free testnet RPC right now, so we lead
// with it and retry ON IT rather than rotating to a corpse. A real second endpoint (paid FastNEAR key /
// our own indexer) is the durable fix — money/infra session. Override via env when we have one.
export const RPC_FALLBACKS: string[] = (() => {
  const fromEnv = process.env.NEXT_PUBLIC_NEAR_RPC_FALLBACKS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv && fromEnv.length) return fromEnv;
  return NETWORK === "mainnet"
    ? ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"]
    : []; // testnet: FastNEAR only — no working free fallback (see note above)
})();

/** The full RPC list to try in order: primary first, then any fallbacks not equal to it. */
export const RPC_URLS: string[] = [RPC_URL, ...RPC_FALLBACKS.filter((u) => u !== RPC_URL)];

export const EXPLORER_URL =
  NETWORK === "mainnet"
    ? "https://explorer.near.org"
    : "https://explorer.testnet.near.org";

/**
 * The per-network helper/explorer/indexer URL set the wallet-selector needs (lib/wallet.tsx wraps this,
 * adding the keyed /api/rpc nodeUrl from the live origin). Extracted as a PURE function of `network` so
 * both the testnet AND mainnet branches are unit-testable without a DOM — the one bug-class that matters
 * here is a mainnet branch pointing at a testnet host (or vice-versa), which a wallet-signed write would
 * silently route to the wrong network. See wallet.walletNetwork.
 */
export function networkUrls(network: NetworkId) {
  const mainnet = network === "mainnet";
  return {
    networkId: network,
    helperUrl: mainnet ? "https://helper.mainnet.near.org" : "https://helper.testnet.near.org",
    explorerUrl: mainnet ? "https://explorer.near.org" : "https://explorer.testnet.near.org",
    indexerUrl: mainnet ? "https://api.kitwallet.app" : "https://testnet-api.kitwallet.app",
  };
}

// ── FastNEAR API key (SERVER-ONLY) ──────────────────────────────────────────────────────────────
// A paid/credited FastNEAR key lifts the shared-IP -429 rate limit that throttles our server reads
// (faucet/balance/snapshot). Kept SERVER-SIDE only (no NEXT_PUBLIC_) so it never ships to the browser —
// today the only "browser" is our own test wallets and the snapshot serves most browsing anyway, so
// server-only captures ~all the benefit with zero key exposure. Set in portal/.env.local (gitignored).
// Auth: FastNEAR accepts `Authorization: Bearer <key>` on the same endpoints (docs.fastnear.com).
export const FASTNEAR_API_KEY = process.env.FASTNEAR_API_KEY || "";

// ── FastNEAR key POOL (stopgap) ────────────────────────────────────────────────────────
// Each NEAR account can register its own free FastNEAR key (monthly credit allotment). We have several
// accounts, so we can POOL their keys and round-robin across them — multiplying the free quota that the
// archival tx_status reads (the event indexer) consume, until the self-hosted block-tailer exists.
// Set `FASTNEAR_API_KEYS` (comma-separated) in portal/.env.local (gitignored, SERVER-ONLY, no
// NEXT_PUBLIC_). Falls back to the single FASTNEAR_API_KEY, then to no key (unauthenticated). The pool
// is headroom/insurance: because the indexer is cursor-driven (only new txns per tick) one key usually
// suffices — the pool just removes the ceiling if a big backfill or busy demo leans on it.
// KEYLESS-BY-DEFAULT. We run UNKEYED (real free tier) by default so any rate-limit pain
// surfaces DURING development — where we can design the proper fix — instead of being masked by credits and
// only biting in production. Our heavy op (bulk unit stamping) is a WRITE path (wallet-gas, not FastNEAR
// reads), and normal reads are cached/bounded, so keyless is expected to be fine. The keys stay
// PARKED in .env.local as insurance (a big historical backfill / VRX_INDEXER_WALK=1 is the one case that
// still wants them). Flip VRX_FASTNEAR_KEYLESS=0 (or unset it) to re-enable the pool instantly — no secret
// is lost. When keyless, serverProviders/the indexer just omit the Authorization header (already handled).
export const FASTNEAR_KEYLESS = process.env.VRX_FASTNEAR_KEYLESS !== "0";

// The RAW env key list (always, regardless of keyless) — used ONLY to SEED the fastnear-keys registry on
// first run (lib/fastnear-keys.ts). After seeding, the registry is the source of truth, not env.
export const FASTNEAR_API_KEYS_RAW: string[] = (() => {
  const list = (process.env.FASTNEAR_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length) return list;
  return FASTNEAR_API_KEY ? [FASTNEAR_API_KEY] : [];
})();

export const FASTNEAR_API_KEYS: string[] = FASTNEAR_KEYLESS ? [] : FASTNEAR_API_KEYS_RAW;

/** The FastNEAR dashboard (billing/keys/usage) — the source of truth for live balances. Note: each KEY's
 *  credits live under ITS OWN account's dashboard (log in with that key's email), so the per-key "check ↗"
 *  link points at the login; this generic landing is the entry point. */
export const FASTNEAR_DASHBOARD_URL = "https://dashboard.fastnear.com";

// ── Archival RPC ─────────────────────────────────────────────────────────────────────
// The event indexer reads EXPERIMENTAL_tx_status for each contract txn to pull its EVENT_JSON logs.
// ⚠️ MUST be the ARCHIVAL endpoint — the normal test.rpc.fastnear.com 408-Request-Timeouts on older
// txns (they age off the non-archival node; verified NOT a transient blip). The FastNEAR bearer
// key (pool above) lifts the shared-IP 429 here too. Override via env per network.
export const ARCHIVAL_RPC_URL =
  process.env.NEXT_PUBLIC_NEAR_ARCHIVAL_RPC ||
  (NETWORK === "mainnet"
    ? "https://archival-rpc.mainnet.fastnear.com"
    : "https://archival-rpc.testnet.fastnear.com");

/**
 * Build the server-side JsonRpcProviders for our endpoint list, attaching a FastNEAR bearer key when
 * present. near-api-js JsonRpcProvider takes a connection object with optional `headers`. Use this in
 * every SERVER module instead of `new providers.JsonRpcProvider({ url })` so the key is applied once.
 *
 * KEY POOL (fix): we build one provider per (url × key) so the caller's rotate+backoff loop walks
 * EVERY key, not just the first. Before this, serverProviders pinned the single `FASTNEAR_API_KEY`, so
 * when that one account ran out of credits every /api/view returned 503 ("quota_exceeded") even though a
 * second pooled key still had credits — the browser then couldn't read the chain and real actors showed
 * as "not onboarded". Rotating the pool here means a spent key just fails its attempt and the loop moves
 * to the next key. Falls back to a single unkeyed provider per url when no keys are configured.
 */
export function serverProviders(providersNs: typeof import("near-api-js")["providers"]) {
  const keys = FASTNEAR_API_KEYS.length ? FASTNEAR_API_KEYS : [""];
  // Interleave by KEY first so consecutive attempts try the same url with a DIFFERENT key — a
  // quota_exceeded on key 1 then immediately retries the same read on key 2, rather than exhausting
  // every url on the dead key first.
  const out: InstanceType<typeof providersNs.JsonRpcProvider>[] = [];
  for (const key of keys) {
    const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
    for (const url of RPC_URLS) {
      out.push(new providersNs.JsonRpcProvider(headers ? { url, headers } : { url }));
    }
  }
  return out;
}
