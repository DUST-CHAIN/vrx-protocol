// DIRECT-SALE DEPOSITS — SERVER-ONLY (file-backed). §9 step 9: the MONEY half of the direct-sales
// firm-hold. When a vetted, offer-eligible direct buyer puts down a deposit, the DESK records it here and
// then firm-holds the unit on-chain (grant_exclusive, see below). This record is the attested proof that a
// deposit backs a specific hold — the buyer's identity stays off-chain; only an opaque unit_key + a house
// ORG ever reach the chain.
//
// ── Why this is a NEW record but reuses the EXISTING hold mirror (the reuse-the-pattern call) ──────
// The HOLD STATE already has a store: lib/exclusives-store.ts (the write-through mirror of grant_exclusive).
// The direct-sale firm-hold is the SAME on-chain call as the agency exclusive, only the grantee org is the
// developer's HOUSE ORG instead of an external agency. So we do NOT invent a second hold store —
// the desk records the hold into exclusives.json exactly as /node does, with orgId = houseOrg. What's new is
// only the DEPOSIT (the money commitment + its link to the hold), which is what THIS file holds.
//
// ── Ownership (DESK-owned, like unit-grants) ───────────────────────────────────────────────────────────
// Only the building's desk developer writes a deposit record (the operator confirms "I received this buyer's
// deposit and am firm-holding for them"). A buyer cannot self-write one — the deposit is custodied off-chain
// (a bank transfer / escrow the desk confirms), not an on-chain transfer by the buyer (desk holds
// FOR the buyer; the buyer's wallet is only READ for the eligibility bar, never signed here). The buyer READS
// their own deposits (to see their unit is firm-held). Same ownership shape as lib/unit-grants.ts.
//
// ── The eligibility LOCK (§9 step 5) ──────────────────────────────────────────────────────────────
// A deposit may only be recorded when the buyer is LIVE offer-eligible (profile ∧ kyc ∧ balance ≥ threshold,
// re-checked at write time, never the stale funnel label — lib/offer-eligibility). The route enforces this;
// this store stays a pure record. The lock is the whole point of the funnel: no deposit/hold before the bar.
//
// ── Status lifecycle ───────────────────────────────────────────────────────────────────────────────────
//   pending  — deposit recorded, hold not yet signed on-chain (or the signing failed/was abandoned).
//   held     — the developer signed grant_exclusive; holdTxHash + holdUntil are set. The unit is firm-held.
//   released — the hold ended (released early / expired / deal fell through). Soft tombstone; kept for audit.
//
// ── The seal spine ─────────────────────────────────────────────────────────────────────────
// 6th consumer of the attested-record spine (offers → agreements → agent-roster buyers → buyers-direct →
// unit-grants → THIS). Salted seal over the stable money fields so "buyer B deposited amount A on unit U via
// desk D" is tamper-evident. The on-chain hold tx hash is recorded but NOT part of the seal (it's authored
// after the record exists; the seal protects the deposit commitment, the txHash is appended provenance).
//
// PRIVACY: SERVER-ONLY; neutral account ids + opaque building/unit ids + a unit_key; the amount is a
// private off-chain figure that NEVER goes on-chain (only the hold state does). Serialized writes (guard).

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";

const DEPOSIT_DOMAIN = "vrx-direct-deposit";

export type DepositStatus = "pending" | "held" | "released";

/** A single direct-sale deposit: desk D recorded buyer B's deposit on (building, unit), backing a firm-hold. */
export type DirectDeposit = {
  /** The buyer's wallet account (lowercased — store key half). */
  buyer: string;
  /** The catalog building id (verbatim). */
  building: string;
  /** The unit id within that building (Unit.id). */
  unit: string;
  /** The opaque on-chain unit_key (hashRef(unitRef,"vrx-unit")) — links the deposit to the hold the desk
   *  signs. Set when the desk records the deposit (the key is computed client-side, same as the hold path). */
  unitKey: string;
  /** The desk developer account that recorded it (the operator — provenance + the authz subject). */
  by: string;
  /** The deposit amount in minor units of the deposit currency (e.g. satang/cents) — a PRIVATE off-chain
   *  figure. Integer to avoid float drift (the PS→HTTP float trap + money-rounding discipline). */
  amountMinor: number;
  /** ISO currency code of amountMinor (e.g. "THB", "USD"). Display only; never on-chain. */
  currency: string;
  /** Lifecycle — see the header. */
  status: DepositStatus;
  /** The grant_exclusive tx hash once the developer signed the firm-hold (status → held). "" until then. */
  holdTxHash: string;
  /** The hold expiry in ns-since-epoch (mirrors Exclusive.until) once held. 0 until then. */
  holdUntil: number;
  /** $VRX SELF-PAY settlement (D-) — set when the BUYER pays this deposit in $VRX (the in_app rail).
   *  Distinct from the desk's off-chain bank-transfer custody (the record's original semantics): a present
   *  `paidVrx` means the buyer's own $VRX balance was actually debited to the treasury, self-proving. Appended
   *  settlement provenance like `holdTxHash` — NOT part of the seal (the seal protects the deposit commitment,
   *  authored before any payment). `amountVrx` ≈ USD (1:1 display convention); `at` = ms epoch paid. */
  paidVrx?: { amountVrx: number; at: number };
  /** ESCROW CUSTODY (the IdeaForge-escrow port) — ORTHOGONAL to `status` (the on-chain HOLD lifecycle).
   *  Where the PAID $VRX lives: `none` = not in custody (default / legacy / direct-to-dev path) · `held` = sitting
   *  in the escrow custody account, not yet the developer's · `release_pending` = developer requested release, the
   *  buyer's veto window is open · `released` = moved custody→developer (terminal) · `refunded` = moved
   *  custody→buyer (terminal). Absent on legacy records = treated as `none`. Appended lifecycle, NOT part of the
   *  seal (the seal protects the deposit COMMITMENT, authored before any custody move). See
 * the design docs + lib/escrow/deposit-custody.ts. */
  custody?: {
    state: "none" | "held" | "release_pending" | "released" | "refunded";
    /** $VRX amount placed into custody by `fund` (whole units ≈ USD). */
    amountVrx: number;
    /** ms epoch the money entered custody (state → held). */
    fundedAt?: number;
    /** ms epoch the developer requested release (state → release_pending) — the start of the veto window. */
    releaseRequestedAt?: number;
    /** veto-window length in ms (snapshotted at request time so a config change can't shorten an open window). */
    vetoWindowMs?: number;
    /** ms epoch of the terminal settlement (released/refunded). */
    settledAt?: number;
    /** the custody position ref from the funding adapter (for $VRX = the custody account). */
    custodyRef?: string;
  };
  /** Per-record secret salt (hex) for the seal. NEVER on-chain. */
  salt: string;
  /** SHA-256(domain | salt | stableStringify({buyer,building,unit,by,amountMinor,currency})) — the seal. */
  sealHash: string;
  /** ms epoch recorded. */
  at: number;
  /** ms epoch last updated (status/hold changes). */
  updatedAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "direct-deposits.json");

// Serialized writes (lost-write guard) — the desk writes while the buyer reads.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: DirectDeposit[]) => { next: DirectDeposit[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<DirectDeposit[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DirectDeposit[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: DirectDeposit[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const normAccount = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
const normId = (s: unknown) => (typeof s === "string" ? s.trim() : "");

/** The sealed payload — the stable money fields whose integrity the seal protects (NOT the hold txHash,
 *  which is appended after the record exists). */
function depositPayload(d: Pick<DirectDeposit, "buyer" | "building" | "unit" | "by" | "amountMinor" | "currency">) {
  return {
    buyer: d.buyer,
    building: d.building,
    unit: d.unit,
    by: d.by,
    amountMinor: d.amountMinor,
    currency: d.currency,
  };
}

const key = (b: string, g: string, u: string) => `${b} ${g} ${u}`;

/**
 * Record a direct-sale deposit for (buyer, building, unit), by the desk developer. Idempotent on the triple:
 * re-recording an EXISTING deposit UPDATES its amount/currency (the desk corrected the figure) but keeps the
 * original salt/seal recomputed over the new amount, and preserves any hold already attached. Returns the
 * record, or null if a key field is missing / amount is not a positive integer.
 *
 * The CALLER (route) MUST enforce: `by` is the building's desk developer AND the buyer is LIVE offer-eligible.
 * This store is a pure record — it does not read the chain or the developer registry.
 */
export async function recordDeposit(input: {
  buyer: string;
  building: string;
  unit: string;
  unitKey: string;
  by: string;
  amountMinor: number;
  currency: string;
}): Promise<DirectDeposit | null> {
  const b = normAccount(input.buyer);
  const g = normId(input.building);
  const u = normId(input.unit);
  const uk = normId(input.unitKey);
  const dev = normAccount(input.by);
  const cur = normId(input.currency).toUpperCase();
  const amt = Number(input.amountMinor);
  if (!b || !g || !u || !uk || !dev || !cur) return null;
  if (!Number.isInteger(amt) || amt <= 0) return null;

  return mutate((list) => {
    const idx = list.findIndex((x) => key(x.buyer, x.building, x.unit) === key(b, g, u));
    if (idx >= 0) {
      const prev = list[idx];
      const updated: DirectDeposit = {
        ...prev,
        unitKey: uk,
        by: dev,
        amountMinor: amt,
        currency: cur,
        // re-seal over the (possibly corrected) money fields with the SAME salt
        sealHash: digest(depositPayload({ buyer: b, building: g, unit: u, by: dev, amountMinor: amt, currency: cur }), DEPOSIT_DOMAIN, prev.salt),
        updatedAt: Date.now(),
      };
      const next = [...list];
      next[idx] = updated;
      return { next, ret: updated };
    }
    const salt = newSalt();
    const now = Date.now();
    const rec: DirectDeposit = {
      buyer: b,
      building: g,
      unit: u,
      unitKey: uk,
      by: dev,
      amountMinor: amt,
      currency: cur,
      status: "pending",
      holdTxHash: "",
      holdUntil: 0,
      salt,
      sealHash: digest(depositPayload({ buyer: b, building: g, unit: u, by: dev, amountMinor: amt, currency: cur }), DEPOSIT_DOMAIN, salt),
      at: now,
      updatedAt: now,
    };
    return { next: [...list, rec], ret: rec };
  });
}

/**
 * Attach the on-chain firm-hold to a pending deposit: the developer signed grant_exclusive, so set
 * status→held + holdTxHash + holdUntil. Idempotent (re-attaching updates the hash/window — a re-grant).
 * Returns the updated record, or null if no matching deposit (the hold must back a recorded deposit).
 */
export async function attachHold(
  buyer: string,
  building: string,
  unit: string,
  holdTxHash: string,
  holdUntil: number
): Promise<DirectDeposit | null> {
  const b = normAccount(buyer);
  const g = normId(building);
  const u = normId(unit);
  const tx = normId(holdTxHash);
  const until = Number(holdUntil);
  if (!b || !g || !u || !tx || !Number.isFinite(until) || until <= 0) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => key(x.buyer, x.building, x.unit) === key(b, g, u));
    if (idx < 0) return { next: list, ret: null as DirectDeposit | null };
    const updated: DirectDeposit = {
      ...list[idx],
      status: "held",
      holdTxHash: tx,
      holdUntil: until,
      updatedAt: Date.now(),
    };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/**
 * Mark a deposit SETTLED IN $VRX (D-) — the buyer paid this deposit from their own $VRX balance
 * (the in_app self-pay rail). Stamps `paidVrx` (the settlement provenance) idempotently: re-calling updates the
 * recorded figure/time rather than double-marking (the caller does the single real debit; this store only
 * records it). Does NOT change `status` (the firm-hold lifecycle is independent of who/how the deposit settled)
 * and does NOT touch the seal (settlement is appended after the commitment, like holdTxHash). Returns the
 * updated record, or null if no matching deposit.
 */
export async function markPaidVrx(
  buyer: string,
  building: string,
  unit: string,
  amountVrx: number
): Promise<DirectDeposit | null> {
  const b = normAccount(buyer);
  const g = normId(building);
  const u = normId(unit);
  const amt = Number(amountVrx);
  if (!b || !g || !u || !Number.isFinite(amt) || amt <= 0) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => key(x.buyer, x.building, x.unit) === key(b, g, u));
    if (idx < 0) return { next: list, ret: null as DirectDeposit | null };
    const updated: DirectDeposit = {
      ...list[idx],
      paidVrx: { amountVrx: amt, at: Date.now() },
      updatedAt: Date.now(),
    };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/**
 * Patch a deposit's ESCROW CUSTODY block. The FSM (lib/escrow/deposit-custody.ts) owns the state
 * machine + guards; this is the pure persistence primitive it calls to write a validated transition. Merges
 * `patch` over the existing custody block (so a transition sets only the fields it changes). Does NOT touch the
 * seal or `status` (custody is appended, orthogonal to the hold lifecycle). Returns the updated record, or null
 * if no matching deposit. The FSM enforces WHICH transitions are legal — this store just writes.
 */
export async function setCustody(
  buyer: string,
  building: string,
  unit: string,
  patch: Partial<NonNullable<DirectDeposit["custody"]>>
): Promise<DirectDeposit | null> {
  const b = normAccount(buyer);
  const g = normId(building);
  const u = normId(unit);
  if (!b || !g || !u) return null;
  return mutate((list) => {
    const idx = list.findIndex((x) => key(x.buyer, x.building, x.unit) === key(b, g, u));
    if (idx < 0) return { next: list, ret: null as DirectDeposit | null };
    const prev = list[idx];
    const prevCustody = prev.custody ?? { state: "none" as const, amountVrx: 0 };
    const updated: DirectDeposit = {
      ...prev,
      custody: { ...prevCustody, ...patch },
      updatedAt: Date.now(),
    };
    const next = [...list];
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** Mark a deposit's hold released (deal fell through / released early / expired). Soft tombstone — the
 *  record stays for audit, status→released. Returns true if a record changed. */
export async function releaseDeposit(buyer: string, building: string, unit: string): Promise<boolean> {
  const b = normAccount(buyer);
  const g = normId(building);
  const u = normId(unit);
  if (!b || !g || !u) return false;
  return mutate((list) => {
    const idx = list.findIndex((x) => key(x.buyer, x.building, x.unit) === key(b, g, u));
    if (idx < 0) return { next: list, ret: false };
    if (list[idx].status === "released") return { next: list, ret: false };
    const next = [...list];
    next[idx] = { ...list[idx], status: "released", updatedAt: Date.now() };
    return { next, ret: true };
  });
}

/**
 * (slice 2) — release EVERY non-released deposit for a (buyer, building) pair (soft tombstone, status→
 * released). The direct-deal lifecycle calls this when a deal ENDS (call-off agreed / hard block): the unit
 * must return to market, mirroring the single-unit DELETE path but without needing the exact unit id (a call-off
 * has only the conversation = (buyer, building)). Returns the unit ids that were actually released (for the
 * real-time push + the audit readout). The on-chain exclusive-hold release is a separate desk wallet act, same
 * as DELETE — this marks the off-chain record, which is the server-side half of "no prejudice, deal reset".
 */
export async function releaseHoldsFor(buyer: string, building: string): Promise<string[]> {
  const b = normAccount(buyer);
  const g = normId(building);
  if (!b || !g) return [];
  return mutate((list) => {
    const released: string[] = [];
    const next = list.map((x) => {
      if (x.buyer === b && x.building === g && x.status !== "released") {
        released.push(x.unit);
        return { ...x, status: "released" as DepositStatus, updatedAt: Date.now() };
      }
      return x;
    });
    return { next, ret: released };
  });
}

/** Every deposit for a buyer (across buildings), newest first — what the buyer surface reads. */
export async function depositsForBuyer(buyer: string): Promise<DirectDeposit[]> {
  const b = normAccount(buyer);
  if (!b) return [];
  return (await readAll()).filter((x) => x.buyer === b).sort((a, c) => c.at - a.at);
}

/** Deposits a desk developer recorded (optionally scoped to one buyer) — for the desk vetting UI. */
export async function depositsByDesk(developer: string, buyer?: string): Promise<DirectDeposit[]> {
  const dev = normAccount(developer);
  const b = buyer ? normAccount(buyer) : "";
  if (!dev) return [];
  return (await readAll())
    .filter((x) => x.by === dev && (!b || x.buyer === b))
    .sort((a, c) => c.at - a.at);
}

/** The single deposit for a (buyer, building, unit), or null. */
export async function getDeposit(buyer: string, building: string, unit: string): Promise<DirectDeposit | null> {
  const b = normAccount(buyer);
  const g = normId(building);
  const u = normId(unit);
  if (!b || !g || !u) return null;
  return (await readAll()).find((x) => key(x.buyer, x.building, x.unit) === key(b, g, u)) ?? null;
}

/** The ✓-verifiable check: re-hash the deposit's stable money fields with its salt and compare to its seal. */
export function verifyDeposit(x: DirectDeposit): boolean {
  try {
    if (!x?.salt || !x?.sealHash) return false;
    return digest(depositPayload(x), DEPOSIT_DOMAIN, x.salt) === x.sealHash;
  } catch {
    return false;
  }
}
