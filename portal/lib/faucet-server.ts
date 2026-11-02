// VRX gas FAUCET — SERVER-ONLY. Auto-funds vetted actors so a brand-new (unfunded) account can make
// its first on-chain write (register/stamp/book). A new account has no NEAR → no gas → can't even
// request + log a note to VRX root (address + balance) so the operator sees who was topped up.
// SOURCE of funds: a DEDICATED neutral faucet account (vrx-faucet-01.testnet, D-gas), key held here in
// env (never committed). Kept separate from owner/treasury so roles don't mix. Refill from the public
// testnet faucet when low.
// GATE (who gets funded): the "provisioned-list" — anyone the portal already onboarded off-chain
// (developers.json / applications.json / agents.json) OR anyone the CHAIN confirms is a real actor
// (get_node/get_org/get_peer/get_owner). The off-chain lists cover the pre-first-write case (an agent
// registered but not yet self-writing); the on-chain fallback covers actors onboarded outside this
// portal. A random account gets nothing.
// PRIVACY: the log holds only neutral account ids + balances + tx hashes. No PII.

import { promises as fs } from "fs";
import path from "path";
import { connect, keyStores, KeyPair, utils, providers, type Account } from "near-api-js";
import { NETWORK, RPC_URL, CONTRACT_ID, FASTNEAR_API_KEY, serverProviders } from "./config";
import { getBalance } from "./balance-server";
import { listDevelopers } from "./developers";
import { listApplications } from "./applications";
import { isKnownAgent } from "./agents";

// ── Tunables ────────────────────────────────────────────────────────────────────────────────
/** How much to send per top-up. 0.1 NEAR = plenty of gas for many writes at the ~0.001 toll. */
const GRANT_NEAR = process.env.VRX_FAUCET_GRANT || "0.1";
/** Don't top up an account already at/above this available balance — it doesn't need gas. */
const TOPUP_BELOW_NEAR = Number(process.env.VRX_FAUCET_TOPUP_BELOW || "0.05");
/** Rate limit: one grant per account per this many ms (default 6h). */
const RATE_LIMIT_MS = Number(process.env.VRX_FAUCET_RATELIMIT_MS || String(6 * 60 * 60 * 1000));
/** Refuse to fund if the faucet's own balance would drop below this (keep a reserve; flag refill). */
const FAUCET_MIN_RESERVE_NEAR = Number(process.env.VRX_FAUCET_MIN_RESERVE || "0.2");

const DATA_DIR = path.join(process.cwd(), ".data");
const LOG_STORE = path.join(DATA_DIR, "faucet-log.json");

// ── PURE policy predicates (split out of fundAccount's await-interleaved branches so each decision is
// testable without fs/RPC/signer). They do NOT change the gate ORDER — fundAccount still evaluates them
// in sequence; these just name and isolate the individual policy tests. Each carries a null-handling
// subtlety worth pinning (a null balance is "unknown", NOT "zero" — it must never trip a funded/reserve
// gate on missing data).

/** A prior note counts as a rate-limit hit only if it was a REAL grant (has a tx) and is inside the window. */
export function isRecentGrant(note: { tx?: string; at: number }, now: number, windowMs: number): boolean {
  return Boolean(note.tx) && now - note.at < windowMs;
}

/** Already has enough gas? A null balance (unknown/outage) is NOT "funded" — we don't skip on missing data. */
export function isAlreadyFunded(availableNear: number | null, topupBelowNear: number): boolean {
  return availableNear !== null && availableNear >= topupBelowNear;
}

/** Would this grant drop the faucet below its reserve? A null faucet balance (unread) does NOT block (proceed;
 * the send surfaces any real problem) — only a KNOWN balance that can't spare the grant refuses. */
export function faucetTooLowToGrant(
  faucetAvailableNear: number | null,
  grantNear: number,
  minReserveNear: number
): boolean {
  return faucetAvailableNear !== null && faucetAvailableNear - grantNear < minReserveNear;
}

// ── The note-to-root log ──────────────────────────────────────────────────────────────────────
export type FaucetNote = {
  account: string;
  /** available NEAR the account had BEFORE this grant (null = account didn't exist yet). */
  balanceBefore: number | null;
  grantedNear: string;
  tx?: string;
  at: number;
  /** how the account qualified: which list / on-chain role. */
  via: string;
  /** set instead of tx when we declined (already funded / rate-limited / gate failed / faucet low). */
  skipped?: string;
};

async function readLog(): Promise<FaucetNote[]> {
  try {
    return JSON.parse(await fs.readFile(LOG_STORE, "utf8")) as FaucetNote[];
  } catch {
    return [];
  }
}
async function appendLog(note: FaucetNote): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const list = await readLog();
  list.push(note);
  await fs.writeFile(LOG_STORE, JSON.stringify(list, null, 2), "utf8");
}
/** Notes to VRX root, newest first (owner dashboard reads this). */
export async function listFaucetNotes(): Promise<FaucetNote[]> {
  return (await readLog()).sort((a, b) => b.at - a.at);
}

// ── The gate ────────────────────────────────────────────────────────────────────────────────
// FastNEAR-keyed providers (server-only) so the eligibility reads don't hit the -429 rate limit.
const VIEW_PROVIDERS = serverProviders(providers);

async function view<T>(method: string, args: Record<string, unknown>): Promise<T | null> {
  const args_base64 = Buffer.from(JSON.stringify(args)).toString("base64");
  for (let i = 0; i < VIEW_PROVIDERS.length; i++) {
    try {
      const res = await VIEW_PROVIDERS[i].query<{ result: number[]; block_height: number; block_hash: string }>({
        request_type: "call_function",
        account_id: CONTRACT_ID,
        method_name: method,
        args_base64,
        finality: "optimistic",
      });
      return JSON.parse(Buffer.from(res.result).toString("utf8")) as T;
    } catch {
      /* try next endpoint */
    }
  }
  return null; // couldn't confirm — treat as "not this role" (other gate paths may still qualify)
}

/**
 * Decide whether an account is eligible for gas. Returns a short reason string (how it qualified) or
 * null if it doesn't qualify. Off-chain lists first (cheap, no RPC), then on-chain roles as fallback.
 */
export async function eligibility(account: string): Promise<string | null> {
  const acc = account.trim().toLowerCase();
  if (!acc) return null;

  // Off-chain provisioned lists (cover the pre-first-write case).
  if ((await listDevelopers()).some((d) => d.account.toLowerCase() === acc)) return "developer (provisioned)";
  if ((await listApplications()).some((a) => a.account?.toLowerCase() === acc)) return "agency (application)";
  if (await isKnownAgent(acc)) return "agent (registered by agency)";

  // On-chain fallback — a real actor onboarded outside this portal.
  if (await view<unknown>("get_node", { id: account.trim() })) return "developer (on-chain)";
  if (await view<unknown>("get_org", { id: account.trim() })) return "agency (on-chain)";
  if (await view<unknown>("get_peer", { id: account.trim() })) return "agent (on-chain)";
  const owner = await view<string>("get_owner", {});
  if (owner && owner.toLowerCase() === acc) return "owner";

  return null;
}

// ── The faucet account signer ───────────────────────────────────────────────────────────────
const FAUCET_ACCOUNT = process.env.VRX_FAUCET_ACCOUNT || "";
const FAUCET_SECRET = process.env.VRX_FAUCET_SECRET || "";

async function faucetAccount(): Promise<Account> {
  if (!FAUCET_ACCOUNT || !FAUCET_SECRET) {
    throw new Error("faucet_unconfigured"); // VRX_FAUCET_ACCOUNT / VRX_FAUCET_SECRET not set
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NETWORK, FAUCET_ACCOUNT, KeyPair.fromString(FAUCET_SECRET as never));
  // Attach the FastNEAR bearer key to the SIGNING connection too (the send that hit -429 live). Pass a
  // keyed JsonRpcProvider via the connection config; fall back to plain nodeUrl when no key is set.
  const near = FASTNEAR_API_KEY
    ? await connect({
        networkId: NETWORK,
        keyStore,
        nodeUrl: RPC_URL,
        provider: new providers.JsonRpcProvider({ url: RPC_URL, headers: { Authorization: `Bearer ${FASTNEAR_API_KEY}` } }),
      } as never)
    : await connect({ networkId: NETWORK, keyStore, nodeUrl: RPC_URL });
  return near.account(FAUCET_ACCOUNT);
}

export type FundResult =
  | { ok: true; funded: true; tx: string; grantedNear: string; balanceAfter: number | null; via: string }
  | { ok: true; funded: false; reason: string; balance: number | null; via?: string }
  | { ok: false; error: string };

/**
 * Fund `account` if eligible, not already funded, and not rate-limited. Always writes a note to root.
 * Idempotent-ish: a second request inside the rate window is a no-op "already funded recently".
 */
export async function fundAccount(account: string): Promise<FundResult> {
  const acc = account.trim();
  if (!acc || !/^[a-z0-9._-]+$/i.test(acc)) return { ok: false, error: "bad_account" };

  // 1. Gate.
  const via = await eligibility(acc);
  if (!via) {
    await appendLog({ account: acc, balanceBefore: null, grantedNear: "0", at: Date.now(), via: "none", skipped: "not eligible" });
    return { ok: true, funded: false, reason: "not_eligible", balance: null };
  }

  // 2. Rate limit — one grant per account per window.
  const recent = (await readLog()).find(
    (n) => n.account.toLowerCase() === acc.toLowerCase() && isRecentGrant(n, Date.now(), RATE_LIMIT_MS)
  );
  if (recent) {
    const bal = await safeBalance(acc);
    return { ok: true, funded: false, reason: "rate_limited", balance: bal, via };
  }

  // 3. Already has enough? Don't waste the faucet.
  const before = await safeBalance(acc);
  if (isAlreadyFunded(before, TOPUP_BELOW_NEAR)) {
    await appendLog({ account: acc, balanceBefore: before, grantedNear: "0", at: Date.now(), via, skipped: "already funded" });
    return { ok: true, funded: false, reason: "already_funded", balance: before, via };
  }

  // 4. Faucet reserve check.
  let faucetBal: number | null = null;
  try {
    const fb = await getBalance(FAUCET_ACCOUNT);
    faucetBal = fb?.availableNear ?? null;
  } catch {
    /* if we can't read the faucet balance, proceed but the send will surface any real problem */
  }
  if (faucetTooLowToGrant(faucetBal, Number(GRANT_NEAR), FAUCET_MIN_RESERVE_NEAR)) {
    await appendLog({ account: acc, balanceBefore: before, grantedNear: "0", at: Date.now(), via, skipped: "faucet low — needs refill" });
    return { ok: false, error: "faucet_empty" };
  }

  // 5. Send.
  let account_: Account;
  try {
    account_ = await faucetAccount();
  } catch {
    return { ok: false, error: "faucet_unconfigured" };
  }
  const yocto = utils.format.parseNearAmount(GRANT_NEAR);
  if (!yocto) return { ok: false, error: "bad_grant_amount" };
  try {
    const outcome = await account_.sendMoney(acc, BigInt(yocto));
    const tx = outcome?.transaction?.hash ?? "";
    const after = await safeBalance(acc);
    await appendLog({ account: acc, balanceBefore: before, grantedNear: GRANT_NEAR, tx, at: Date.now(), via });
    return { ok: true, funded: true, tx, grantedNear: GRANT_NEAR, balanceAfter: after, via };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await appendLog({ account: acc, balanceBefore: before, grantedNear: "0", at: Date.now(), via, skipped: `send failed: ${msg}` });
    return { ok: false, error: "send_failed" };
  }
}

/** Balance read that never throws — returns available NEAR or null (unknown/outage). For logging + gating. */
async function safeBalance(account: string): Promise<number | null> {
  try {
    const b = await getBalance(account);
    return b?.availableNear ?? null;
  } catch {
    return null;
  }
}
