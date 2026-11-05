// $VRX — the real transferable in-system currency (replaces the demo play-money). SERVER-ONLY
// (file-backed.data, serialized `mutate`). This is the honest reconciliation asked for: $VRX is a
// FIXED-SUPPLY, TRANSFERABLE credit usable to pay inside the VRX system — NOT the old unlimited self-minted
// "play money".
//
// ── What $VRX IS now ─────────────────────────────────────────────────────────────────────────
//   • FIXED SUPPLY — 200,000,000 $VRX total, in existence from genesis. No new $VRX is ever created; it only
//     MOVES. The whole supply starts in a single VRX TREASURY account.
//   • TREASURY-HELD, NOT developer-held — the 200M sits in a server-held treasury account, never in a public
//  developer wallet (: a public developer balance would let the first user drain it). Users RECEIVE
//     $VRX by claiming from the treasury (capped) or by an operator sending it.
//   • TRANSFERABLE — any holder can send $VRX to any other account. A transfer debits the sender and credits
//     the recipient atomically; balances never go negative and total supply is conserved (invariant-tested).
//   • SPENDABLE INSIDE VRX — $VRX pays deposits/holds within the VRX system (the booking/hold paths spend the
//     real balance). It is the in-system unit of account.
//
// ── What $VRX is NOT (the honest boundary) ──────────────────────────────────────────────────────────────────
//   • NOT a USD peg / not fiat — "1 $VRX ≈ $1" is a DISPLAY convention only (same as before), never redeemable
//     for fiat, never a reserve/peg claim.
//   • NOT yet an on-chain token — this is an OFF-CHAIN ledger (a number in VRX's books). There is no wallet-
//     signature authentication here: the treasury/claim/transfer rules are enforced at the SERVER ROUTE. The
//     future on-chain upgrade is a real NEP-141 fungible token (parked — the contract is frozen; V7→testnet is
//     the last step). Until then "you own $VRX" means "VRX's ledger credits you", not trustless custody.
//
// ── The hard invariants this module ENFORCES (not just documents) ───────────────────────────────────────────
//   • CONSERVATION — treasury + Σ(user balances) === TOTAL_SUPPLY at all times (mint is impossible outside
//     genesis; every op only moves units between accounts).
//   • NON-NEGATIVE — no account (treasury included) can be debited below zero.
//   • CLAIM CAP — a user may claim CLAIM_AMOUNT twice, with ≥ CLAIM_COOLDOWN_MS between the two claims, and
//     never more than twice (the per-account claim ledger is the enforcement, since there is no wallet crypto).
//
// ── History ledger (wallet #4) ────────────────────────────────────────────────────────────────────────────
//   Every money move (claim / transfer / operatorSend / spend) appends ONE immutable VrxTxn row to vrx-txns.json
//   INSIDE the same serialized balance mutation (after the conservation check, before returning), so the log can
//   never drift from the balances — a rolled-back move writes no txn. `historyOf(account)` returns the rows that
//   touch an account, newest first, signed from that account's point of view (+credit / −debit). Pure read model;
//   balances remain the source of truth for "how much", the log is the source of truth for "what happened".

import { promises as fs } from "fs";
import path from "path";

// ── Genesis constants ───────────────────────────────────────────────────────────────────────────────────────

/** The VRX treasury account — holds the entire supply at genesis, the sole source of claims/airdrops. A
 *  reserved pseudo-account id (not a real NEAR account): it is the ledger's source-of-funds, never a claimant. */
export const TREASURY_ACCOUNT = "vrx-treasury.vrx";

/** Fixed total supply — 200,000,000 $VRX. Never changes; $VRX only moves. */
export const TOTAL_SUPPLY = 200_000_000;

/** The fixed claim amount (: a user can claim 75,000 twice). */
export const CLAIM_AMOUNT = 75_000;

/** Max claims per account (two) + the minimum gap between them (≥ 2 days). */
export const MAX_CLAIMS = 2;
export const CLAIM_COOLDOWN_MS = Number(process.env.VRX_CLAIM_COOLDOWN_MS ?? 2 * 24 * 60 * 60 * 1000); // 48h

// ── Types ─────────────────────────────────────────────────────────────────────────────────────────────────

export type VrxBalance = {
  account: string; // lower-cased holder id (or TREASURY_ACCOUNT)
  balanceVrx: number; // integer units; never negative
};

export type VrxClaimRecord = {
  account: string; // lower-cased claimant
  claims: number[]; // ms timestamps of each successful claim (len ≤ MAX_CLAIMS)
};

/** The KIND of a money move, for the human-readable history (wallet #4). Every $VRX movement is one of these. */
export type VrxTxnKind = "claim" | "transfer" | "operatorSend" | "spend";

/** An immutable ledger entry — one per logical money move. Appended INSIDE the balance mutation so it can never
 *  drift from the balances (a rolled-back move writes no txn). `from`/`to` are the raw (non-normalised) ids as
 *  moved; `historyOf` matches case-insensitively. Amount is always the positive units moved; the sign a user
 *  sees is derived per-account at read time (debit when they're `from`, credit when they're `to`). */
export type VrxTxn = {
  id: string;        // unique id (ts + counter), stable for keys/dedup
  ts: number;        // ms timestamp of the move
  kind: VrxTxnKind;  // what kind of move
  from: string;      // debited account (TREASURY_ACCOUNT for claim/operatorSend)
  to: string;        // credited account (TREASURY_ACCOUNT for spend)
  amount: number;    // positive whole units moved
  memo?: string;     // optional context (e.g. "deposit on unit …") set by the spending caller
};

// ── Store (same spine as vrx-demo-currency.ts / seller-entities.ts) ──────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), ".data");
const BAL = path.join(DATA_DIR, "vrx-balances.json");
const CLAIMS = path.join(DATA_DIR, "vrx-claims.json");
const TXNS = path.join(DATA_DIR, "vrx-txns.json");

async function readJson<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as T[]) : [];
  } catch {
    return [];
  }
}
async function writeJson<T>(file: string, list: T[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(list, null, 2), "utf8");
}

// Monotonic suffix so two txns in the same millisecond still get distinct ids.
let txnSeq = 0;
function nextTxnId(ts: number): string {
  txnSeq = (txnSeq + 1) % 1000;
  return `${ts}-${txnSeq.toString().padStart(3, "0")}`;
}

let balChain: Promise<unknown> = Promise.resolve();
/** Serialize all balance mutations (single-process; the file is the source of truth). The genesis seed runs
 *  inside the chain on first mutation so the treasury is created exactly once. A move may also return `txns`
 *  (ledger entries for wallet #4) — they are appended to the TXN log in the SAME committed step as the balance
 *  write, AFTER the conservation check, so a rolled-back move can never leave a phantom history row. */
function mutateBalances<T>(
  fn: (list: VrxBalance[]) => Promise<{ next: VrxBalance[]; ret: T; txns?: Omit<VrxTxn, "id">[] }>,
): Promise<T> {
  const run = balChain.then(async () => {
    const list = ensureGenesis(await readJson<VrxBalance>(BAL));
    const { next, ret, txns } = await fn(list);
    assertConserved(next); // every committed state must conserve supply + be non-negative
    await writeJson(BAL, next);
    if (txns && txns.length) {
      const log = await readJson<VrxTxn>(TXNS);
      for (const t of txns) log.push({ ...t, id: nextTxnId(t.ts) });
      await writeJson(TXNS, log);
    }
    return ret;
  });
  balChain = run.catch(() => {});
  return run as Promise<T>;
}

let claimChain: Promise<unknown> = Promise.resolve();
function mutateClaims<T>(fn: (list: VrxClaimRecord[]) => Promise<{ next: VrxClaimRecord[]; ret: T }>): Promise<T> {
  const run = claimChain.then(async () => {
    const list = await readJson<VrxClaimRecord>(CLAIMS);
    const { next, ret } = await fn(list);
    await writeJson(CLAIMS, next);
    return ret;
  });
  claimChain = run.catch(() => {});
  return run as Promise<T>;
}

/** Seed genesis: if the ledger is empty, put the entire supply in the treasury. Idempotent — once any balance
 *  row exists we never re-seed (that would double-mint). */
function ensureGenesis(list: VrxBalance[]): VrxBalance[] {
  if (list.length > 0) return list;
  return [{ account: TREASURY_ACCOUNT, balanceVrx: TOTAL_SUPPLY }];
}

/** The conservation + non-negative invariant — the whole point of a fixed-supply ledger. Thrown (not returned)
 *  so a buggy op can never COMMIT a supply-breaking state; the mutate wrapper rolls back by not writing. */
function assertConserved(list: VrxBalance[]): void {
  let total = 0;
  for (const b of list) {
    if (!Number.isFinite(b.balanceVrx) || b.balanceVrx < 0) {
      throw new Error(`$VRX invariant: ${b.account} has an invalid/negative balance (${b.balanceVrx})`);
    }
    total += b.balanceVrx;
  }
  if (total !== TOTAL_SUPPLY) {
    throw new Error(`$VRX invariant: supply not conserved (Σ=${total}, expected ${TOTAL_SUPPLY})`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const norm = (a: string) => a.trim().toLowerCase();

function findIdx(list: VrxBalance[], account: string): number {
  const a = norm(account);
  return list.findIndex((b) => b.account.toLowerCase() === a);
}

/** Move `amount` from `from` to `to` inside a balance list (pure). Throws on insufficient funds / bad amount.
 *  Returns the next list. Creates the recipient row if absent. The treasury row always exists (genesis). */
function applyTransfer(list: VrxBalance[], from: string, to: string, amount: number): VrxBalance[] {
  if (!Number.isFinite(amount) || amount <= 0 || Math.floor(amount) !== amount) {
    throw new Error("amount must be a positive whole number of $VRX");
  }
  const f = norm(from), t = norm(to);
  if (f === t) throw new Error("cannot transfer $VRX to the same account");
  const next = list.map((b) => ({ ...b }));
  const fi = next.findIndex((b) => b.account.toLowerCase() === f);
  if (fi < 0 || next[fi].balanceVrx < amount) throw new Error("insufficient $VRX balance");
  next[fi].balanceVrx -= amount;
  const ti = next.findIndex((b) => b.account.toLowerCase() === t);
  if (ti < 0) next.push({ account: to.trim(), balanceVrx: amount });
  else next[ti].balanceVrx += amount;
  return next;
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────

/** An account's $VRX balance (0 if it holds none). Reads don't seed (only the treasury exists at genesis). */
export async function balanceOf(account: string): Promise<number> {
  const a = norm(account);
  if (!a) return 0;
  const list = ensureGenesis(await readJson<VrxBalance>(BAL));
  return list.find((b) => b.account.toLowerCase() === a)?.balanceVrx ?? 0;
}

/** The treasury's remaining balance — how much is left to claim/airdrop. */
export async function treasuryBalance(): Promise<number> {
  return balanceOf(TREASURY_ACCOUNT);
}

/** An account's claim history + what it may still do (how many claims left, when the next is allowed). This is
 *  the user-facing "Claim $VRX" state. `nextClaimAt` is null when a claim is available now (or none left). */
export async function claimStatus(account: string, now = Date.now()): Promise<{
  claimsUsed: number;
  claimsLeft: number;
  canClaimNow: boolean;
  nextClaimAt: number | null;
  claimAmount: number;
}> {
  const a = norm(account);
  const rec = (await readJson<VrxClaimRecord>(CLAIMS)).find((c) => c.account.toLowerCase() === a);
  const claims = rec?.claims ?? [];
  const claimsUsed = claims.length;
  const claimsLeft = Math.max(0, MAX_CLAIMS - claimsUsed);
  if (claimsLeft === 0) {
    return { claimsUsed, claimsLeft: 0, canClaimNow: false, nextClaimAt: null, claimAmount: CLAIM_AMOUNT };
  }
  // The cooldown only gates the SECOND+ claim — the first is always available.
  const last = claims.length ? Math.max(...claims) : 0;
  const earliest = claims.length ? last + CLAIM_COOLDOWN_MS : 0;
  const canClaimNow = now >= earliest;
  return {
    claimsUsed,
    claimsLeft,
    canClaimNow,
    nextClaimAt: canClaimNow ? null : earliest,
    claimAmount: CLAIM_AMOUNT,
  };
}

/** An account's $VRX HISTORY (wallet #4), newest first. Each row is signed FROM THIS ACCOUNT's point of view:
 *  `signedAmount` is negative when the account is the debited side (`spend`/outgoing `transfer`) and positive
 *  when credited (`claim`/`operatorSend`/incoming `transfer`). `counterparty` is the other side of the move
 *  (the treasury for claim/operatorSend/spend). `limit` caps the rows returned (default 100). */
export type VrxHistoryRow = VrxTxn & {
  direction: "in" | "out";
  signedAmount: number;   // +credit / −debit, from this account's view
  counterparty: string;   // the other account in the move
};
export async function historyOf(account: string, limit = 100): Promise<VrxHistoryRow[]> {
  const a = norm(account);
  if (!a) return [];
  const log = await readJson<VrxTxn>(TXNS);
  const rows: VrxHistoryRow[] = [];
  for (const t of log) {
    const isFrom = t.from.toLowerCase() === a;
    const isTo = t.to.toLowerCase() === a;
    if (!isFrom && !isTo) continue;
    // A self-transfer can't happen (applyTransfer rejects from===to), so exactly one side matches.
    const direction: "in" | "out" = isTo ? "in" : "out";
    rows.push({
      ...t,
      direction,
      signedAmount: direction === "in" ? t.amount : -t.amount,
      counterparty: isTo ? t.from : t.to,
    });
  }
  // Newest first; tie-break on id so same-ms rows keep insertion order reversed deterministically.
  rows.sort((x, y) => (y.ts - x.ts) || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0));
  return rows.slice(0, Math.max(0, limit));
}

// ── Writes ─────────────────────────────────────────────────────────────────────────────────────────────────

/** CLAIM $VRX from the treasury (self-serve). Enforces MAX_CLAIMS and the cooldown via the per-account claim
 *  ledger (the only enforcement there is — no wallet crypto off-chain). Moves CLAIM_AMOUNT treasury→account.
 *  Throws if the cap/cooldown is hit or the treasury can't cover it. Returns the new balance + claim status. */
export async function claim(account: string, now = Date.now()): Promise<{ balanceVrx: number; claimsLeft: number }> {
  const acct = account.trim();
  if (!acct) throw new Error("account required");
  if (norm(acct) === norm(TREASURY_ACCOUNT)) throw new Error("the treasury cannot claim from itself");

  // Gate on the claim ledger FIRST (and record the claim) so a balance-mutation failure can't leave a user who
  // got no funds counted as having claimed. We reserve the slot, move funds, and on a funds failure release it.
  const reserved = await mutateClaims(async (list) => {
    const idx = list.findIndex((c) => c.account.toLowerCase() === norm(acct));
    const rec = idx >= 0 ? list[idx] : { account: acct, claims: [] as number[] };
    if (rec.claims.length >= MAX_CLAIMS) throw new Error(`$VRX claim limit reached (max ${MAX_CLAIMS})`);
    if (rec.claims.length > 0) {
      const earliest = Math.max(...rec.claims) + CLAIM_COOLDOWN_MS;
      if (now < earliest) {
        const days = Math.ceil((earliest - now) / (24 * 60 * 60 * 1000));
        throw new Error(`your next $VRX claim is available in ~${days} day(s)`);
      }
    }
    const nextRec = { ...rec, claims: [...rec.claims, now] };
    const next = idx >= 0 ? list.map((c, i) => (i === idx ? nextRec : c)) : [...list, nextRec];
    return { next, ret: nextRec.claims.length };
  });

  try {
    const balanceVrx = await mutateBalances(async (list) => {
      const next = applyTransfer(list, TREASURY_ACCOUNT, acct, CLAIM_AMOUNT); // throws if treasury can't cover
      return {
        next,
        ret: next.find((b) => b.account.toLowerCase() === norm(acct))!.balanceVrx,
        txns: [{ ts: now, kind: "claim" as const, from: TREASURY_ACCOUNT, to: acct, amount: CLAIM_AMOUNT }],
      };
    });
    return { balanceVrx, claimsLeft: Math.max(0, MAX_CLAIMS - reserved) };
  } catch (e) {
    // Release the reserved claim slot (the funds move failed — e.g. treasury drained). Keeps the ledger honest.
    await mutateClaims(async (list) => {
      const idx = list.findIndex((c) => c.account.toLowerCase() === norm(acct));
      if (idx < 0) return { next: list, ret: undefined };
      const rec = list[idx];
      const claims = rec.claims.slice(0, -1); // drop the slot we just added
      const next = list.map((c, i) => (i === idx ? { ...rec, claims } : c));
      return { next, ret: undefined };
    });
    throw e;
  }
}

/** TRANSFER $VRX from one holder to another. Debits `from`, credits `to`, atomically; never negative, supply
 *  conserved. The CALLER (route) is responsible for authorizing that the request legitimately acts as `from`
 *  (same posture as the other off-chain stores — see module header on the no-crypto boundary). */
export async function transfer(from: string, to: string, amount: number): Promise<{ fromBalance: number; toBalance: number }> {
  if (!from.trim() || !to.trim()) throw new Error("from and to accounts required");
  return mutateBalances(async (list) => {
    const next = applyTransfer(list, from, to, amount);
    return {
      next,
      ret: {
        fromBalance: next.find((b) => b.account.toLowerCase() === norm(from))!.balanceVrx,
        toBalance: next.find((b) => b.account.toLowerCase() === norm(to))!.balanceVrx,
      },
      txns: [{ ts: Date.now(), kind: "transfer" as const, from: from.trim(), to: to.trim(), amount }],
    };
  });
}

/** OPERATOR SEND — the VRX team pushes $VRX from the treasury to any account (option 3). Same money-move
 *  as a transfer but sourced from the treasury and NOT subject to the per-user claim cap (the operator route
 *  authenticates the caller via the operator secret). Use for targeted airdrops / grants. */
export async function operatorSend(to: string, amount: number): Promise<{ toBalance: number; treasuryBalance: number }> {
  if (!to.trim()) throw new Error("recipient account required");
  return mutateBalances(async (list) => {
    const next = applyTransfer(list, TREASURY_ACCOUNT, to, amount);
    return {
      next,
      ret: {
        toBalance: next.find((b) => b.account.toLowerCase() === norm(to))!.balanceVrx,
        treasuryBalance: next.find((b) => b.account.toLowerCase() === norm(TREASURY_ACCOUNT))!.balanceVrx,
      },
      txns: [{ ts: Date.now(), kind: "operatorSend" as const, from: TREASURY_ACCOUNT, to: to.trim(), amount }],
    };
  });
}

/** SPEND $VRX inside the system — a holder pays `amount` to the treasury (the in-system sink for deposits/
 *  holds/fees). Logs a `spend` txn (optionally with a `memo`, e.g. "deposit on unit 312") so it reads clearly
 *  in the wallet history, rather than an anonymous transfer-to-treasury. Returns the holder's new balance. */
export async function spend(account: string, amount: number, memo?: string): Promise<number> {
  if (!account.trim()) throw new Error("account required");
  return mutateBalances(async (list) => {
    const next = applyTransfer(list, account, TREASURY_ACCOUNT, amount);
    return {
      next,
      ret: next.find((b) => b.account.toLowerCase() === norm(account))!.balanceVrx,
      txns: [{ ts: Date.now(), kind: "spend" as const, from: account.trim(), to: TREASURY_ACCOUNT, amount, ...(memo ? { memo } : {}) }],
    };
  });
}

/** TEST-ONLY: wipe both stores. */
export async function __resetForTests(): Promise<void> {
  await writeJson<VrxBalance>(BAL, []);
  await writeJson<VrxClaimRecord>(CLAIMS, []);
  await writeJson<VrxTxn>(TXNS, []);
  txnSeq = 0;
}
