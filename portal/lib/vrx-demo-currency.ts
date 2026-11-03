// $VRX — the DEMO-ONLY play-money currency. SERVER-ONLY (file-backed.data, serialized `mutate`).
// Design: `the design docs`. Sibling of the booking-tokens arc — but $VRX is the
// EXPLICITLY-FAKE one.
//
// ── What $VRX IS (c) ─────────────────────────────────────────────────────────────────────────
// Explicitly-fake, demo-only play money. 1 $VRX "= $1" is a DISPLAY convention ONLY — not real value, never
// redeemable, never traded, never a peg claim. It exists so agents can LEARN the system and place DEMO
// bookings (a second demo path alongside the REAL booking tokens). The regulatory worry dissolves
// precisely because it is fake-by-construction: self-expiring, never redeemable, never externally traded, no
// reserve/peg. The name is `$VRX` (a native play-unit), deliberately NOT "VRXUSD" (which would imply a USD peg).
//
// ── The hard invariants this module ENFORCES (not just documents) ───────────────────────────────────────
//   • DEMO-FLAG-GATED — every mutating entry point refuses unless NEXT_PUBLIC_VRX_DEMO=1. $VRX cannot exist in
//     a real deployment, full stop (fail-closed).
//   • ALWAYS VISIBLY FAKE — a demo hold always carries `demo:true` (the honesty marker, never absent).
//   • NEVER SETTLES A REAL OBLIGATION — a $VRX booking is a TIME-BOXED demo HOLD that auto-reverts; it never
//     writes a seal, never goes on-chain as value, never denominates the S&P/real ledger. To make a booking
//  STICK the developer must UPGRADE it to a real booking (pay the real VRX fee / a token) — slice 3
//     (`upgradeDemoHold`): the handoff that marks the demo hold `upgradedToRequestId` so it leaves the demo
//  world; the REAL booking + the REAL fee happen on the direct-deposit path, never in this module.
//  • SELF-CLEANING — a demo hold is `expired` once `Date.now > expiresAt`; the unit returns to available
//     with no manual step (reuses the existing TTL/expiry pattern, applications.ts/agreements.ts).

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────────

export type VrxDemoBalance = {
  account: string; // the demo actor
  balanceVrx: number; // play-money units (1 = "$1" display only) — no reserve, no peg, no redemption
};

export type VrxDemoHold = {
  id: string;
  account: string; // who placed it (agent/buyer demo actor)
  buildingId: string;
  unitId: string;
  amountVrx: number; // the demo price "paid" (fake)
  placedAt: number;
  expiresAt: number; // auto-revert point — the unit returns to available at/after this
  demo: true; // ALWAYS — the honesty marker; never absent, never false
  upgradedToRequestId?: string; // set if the developer paid the real fee to make it a real booking (slice 3)
};

// ── Demo gate (fail-closed) ─────────────────────────────────────────────────────────────────────────────

/** $VRX exists ONLY under the public demo flag. Read live (not memoised) so a test can toggle it per case —
 *  mirrors the seal.ts pepper pattern. A real deployment leaves NEXT_PUBLIC_VRX_DEMO unset → every mutating
 *  call throws. (Reads are also gated: a non-demo world has no $VRX to read.) */
export function demoEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VRX_DEMO === "1";
}

function assertDemo(): void {
  if (!demoEnabled()) throw new Error("$VRX is demo-only — not available outside NEXT_PUBLIC_VRX_DEMO (fake-by-construction)");
}

/** The nominal base mint per demo actor (cosmetic — it's fake, so the amount is arbitrary). "= $200,000" of
 *  play money, enough to demo realistic unit prices. Overridable via env for a session that wants more/less. */
export const DEMO_BASE_MINT_VRX = Number(process.env.VRX_DEMO_BASE_MINT ?? 200_000);

/** Default demo-hold TTL. Short enough to self-clean during a demo, long enough to walk a flow. 30 min default;
 *  overridable via env (VRX_DEMO_HOLD_TTL_MS). Design open-Q resolved to a sensible configurable default. */
export const DEMO_HOLD_TTL_MS = Number(process.env.VRX_DEMO_HOLD_TTL_MS ?? 30 * 60 * 1000);

// ── Store (same spine as seller-entities.ts / booking-tokens.ts) ────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), ".data");
const BAL = path.join(DATA_DIR, "vrx-demo-balances.json");
const HOLDS = path.join(DATA_DIR, "vrx-demo-holds.json");

let balChain: Promise<unknown> = Promise.resolve();
function mutateBalances<T>(fn: (list: VrxDemoBalance[]) => Promise<{ next: VrxDemoBalance[]; ret: T }>): Promise<T> {
  const run = balChain.then(async () => {
    const list = await readBalances();
    const { next, ret } = await fn(list);
    await writeJson(BAL, next);
    return ret;
  });
  balChain = run.catch(() => {});
  return run as Promise<T>;
}

let holdChain: Promise<unknown> = Promise.resolve();
function mutateHolds<T>(fn: (list: VrxDemoHold[]) => Promise<{ next: VrxDemoHold[]; ret: T }>): Promise<T> {
  const run = holdChain.then(async () => {
    const list = await readHoldsRaw();
    const { next, ret } = await fn(list);
    await writeJson(HOLDS, next);
    return ret;
  });
  holdChain = run.catch(() => {});
  return run as Promise<T>;
}

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
const readBalances = () => readJson<VrxDemoBalance>(BAL);
const readHoldsRaw = () => readJson<VrxDemoHold>(HOLDS);

// ── Slice 1: balance + mint ─────────────────────────────────────────────────────────────────────────────

/** A demo actor's $VRX balance, auto-seeding the base mint on first touch (it's free + fake, so all demo
 *  actors get it — the design's lean). Demo-gated. */
export async function balanceOf(account: string): Promise<number> {
  assertDemo();
  const a = account.trim().toLowerCase();
  if (!a) return 0;
  const existing = (await readBalances()).find((b) => b.account.toLowerCase() === a);
  if (existing) return existing.balanceVrx;
  // auto-seed on first read
  return mutateBalances(async (list) => {
    const again = list.find((b) => b.account.toLowerCase() === a);
    if (again) return { next: list, ret: again.balanceVrx };
    const fresh: VrxDemoBalance = { account: account.trim(), balanceVrx: DEMO_BASE_MINT_VRX };
    return { next: [...list, fresh], ret: fresh.balanceVrx };
  });
}

/** Top up a demo actor's play-money (cosmetic — it's fake; "we can increase if needed" is trivially true). */
export async function mintDemo(account: string, amountVrx: number): Promise<number> {
  assertDemo();
  const a = account.trim();
  if (!a) throw new Error("account required");
  if (!Number.isFinite(amountVrx) || amountVrx <= 0) throw new Error("amountVrx must be positive");
  return mutateBalances(async (list) => {
    const idx = list.findIndex((b) => b.account.toLowerCase() === a.toLowerCase());
    if (idx < 0) {
      const fresh: VrxDemoBalance = { account: a, balanceVrx: DEMO_BASE_MINT_VRX + amountVrx };
      return { next: [...list, fresh], ret: fresh.balanceVrx };
    }
    const next = list.slice();
    next[idx] = { ...next[idx], balanceVrx: next[idx].balanceVrx + amountVrx };
    return { next, ret: next[idx].balanceVrx };
  });
}

// ── Slice 2: demo hold (time-boxed) + auto-revert ───────────────────────────────────────────────────────

/** Is a demo hold expired (auto-reverted)? The self-cleaning edge: once expired, the unit is available again.
 *  An upgraded hold (became a real booking, slice 3) is NOT "active" either — it has left the demo world. */
export function isDemoHoldExpired(hold: VrxDemoHold, now = Date.now()): boolean {
  return now >= hold.expiresAt;
}

/** A demo hold is ACTIVE iff it is not expired and not upgraded. This is the ONLY thing that parks a unit in
 *  the demo world — and it decays on its own. */
export function isDemoHoldActive(hold: VrxDemoHold, now = Date.now()): boolean {
  return !hold.upgradedToRequestId && !isDemoHoldExpired(hold, now);
}

/** Place a $VRX demo hold on a unit — a TIME-BOXED sandbox lease, NOT a settlement. Deducts the fake price
 *  from the actor's play-money balance, stamps `demo:true` + an `expiresAt`. Demo-gated. Never seals, never
 *  goes on-chain, never denominates a real ledger. Returns the hold. */
export async function placeDemoHold(args: {
  account: string;
  buildingId: string;
  unitId: string;
  amountVrx: number;
  ttlMs?: number;
}): Promise<VrxDemoHold> {
  assertDemo();
  const account = args.account.trim();
  const buildingId = args.buildingId.trim();
  const unitId = args.unitId.trim();
  if (!account || !buildingId || !unitId) throw new Error("account, buildingId, unitId required");
  if (!Number.isFinite(args.amountVrx) || args.amountVrx <= 0) throw new Error("amountVrx must be positive");
  const ttl = Number.isFinite(args.ttlMs) && (args.ttlMs as number) > 0 ? (args.ttlMs as number) : DEMO_HOLD_TTL_MS;

  // Deduct the fake price (a demo actor can't "spend" more play-money than it has — keeps the demo coherent).
  const bal = await balanceOf(account);
  if (bal < args.amountVrx) throw new Error("insufficient $VRX (demo) balance");
  await mutateBalances(async (list) => {
    const idx = list.findIndex((b) => b.account.toLowerCase() === account.toLowerCase());
    const next = list.slice();
    if (idx >= 0) next[idx] = { ...next[idx], balanceVrx: next[idx].balanceVrx - args.amountVrx };
    return { next, ret: undefined };
  });

  const now = Date.now();
  const hold: VrxDemoHold = {
    id: `vrxh-${now}-${randomBytes(4).toString("hex")}`,
    account,
    buildingId,
    unitId,
    amountVrx: args.amountVrx,
    placedAt: now,
    expiresAt: now + ttl,
    demo: true,
  };
  return mutateHolds(async (list) => ({ next: [...list, hold], ret: hold }));
}

/** All demo holds for a unit, ACTIVE only (expired/upgraded excluded — they no longer park the unit). This is
 *  the self-cleaning read: an expired hold simply stops being returned, so the unit reads as available with no
 *  cleanup write. (A sweep/compaction of long-dead holds is housekeeping, not correctness.) */
export async function activeDemoHoldsForUnit(buildingId: string, unitId: string, now = Date.now()): Promise<VrxDemoHold[]> {
  assertDemo();
  const b = buildingId.trim().toLowerCase();
  const u = unitId.trim().toLowerCase();
  return (await readHoldsRaw()).filter(
    (h) => h.buildingId.toLowerCase() === b && h.unitId.toLowerCase() === u && isDemoHoldActive(h, now)
  );
}

/** A demo actor's own holds (active first, newest first) — what their demo surface shows with the countdown. */
export async function demoHoldsForAccount(account: string): Promise<VrxDemoHold[]> {
  assertDemo();
  const a = account.trim().toLowerCase();
  return (await readHoldsRaw())
    .filter((h) => h.account.toLowerCase() === a)
    .sort((x, y) => y.placedAt - x.placedAt);
}

/** All demo holds parked on a set of buildings (newest first) — the DEVELOPER's view of practice holds sitting
 * on THEIR inventory (slice 4). The developer is the party who upgrades a hold to a real booking
 *  (the forcing-function handoff), so they need to see the holds on their units — distinct from
 *  demoHoldsForAccount, which is the agent's own-holds view. Case-insensitive on buildingId; empty set → []. */
export async function demoHoldsForBuildings(buildingIds: string[]): Promise<VrxDemoHold[]> {
  assertDemo();
  const want = new Set(buildingIds.map((b) => b.trim().toLowerCase()).filter(Boolean));
  if (want.size === 0) return [];
  return (await readHoldsRaw())
    .filter((h) => want.has(h.buildingId.toLowerCase()))
    .sort((x, y) => y.placedAt - x.placedAt);
}

export async function getDemoHold(id: string): Promise<VrxDemoHold | null> {
  assertDemo();
  const want = id.trim();
  if (!want) return null;
  return (await readHoldsRaw()).find((h) => h.id === want) ?? null;
}

// ── Slice 3: upgrade path (the real-fee forcing function) ───────────────────────────────────────────────
//
// c: *"to make it STICK the developer must UPGRADE the demo hold to a real booking — which means
// paying the real VRX fee (and/or a real booking token). The fee is the forcing function that stops anyone
// leaving fake bookings parked."* So the upgrade is the seam where a $VRX demo hold CROSSES OUT of the demo
// world into the real path. THIS MODULE DOES NOT MINT REAL VALUE — $VRX is fake-by-construction and never
// settles a real obligation (the hard invariant). The real booking (a committed token / the direct-deposit
// firm-hold) is placed by the existing REAL path by the ROUTE; this function records the HANDOFF: it marks the
// demo hold `upgradedToRequestId` so it leaves the demo world (isDemoHoldActive already returns false for an
// upgraded hold → the unit no longer reads as demo-held; the real booking now parks it honestly). The real
// fee is the issuance fee / the V5 protocol fee — already modelled; it is PAID on the real path, not here.
//
// GUARDS: demo-gated (the demo hold only exists under the flag); the hold must still be ACTIVE (you cannot
// upgrade an expired or already-upgraded hold — an expired demo lease has already reverted the unit; a
// double-upgrade would re-point a real booking); a non-empty real requestId is required (the upgrade MUST name
// the real booking it became — an upgrade with no real counterpart would be a fake booking masquerading as real,
// the exact thing the forcing function prevents). Authorization (is `by` the developer of the unit?) is the
// CALLER's job at the route — same posture as the other stores trusting their resolved caller.

/** UPGRADE a $VRX demo hold into a real booking (slice 3) — the forcing-function handoff. Marks the demo hold
 * `upgradedToRequestId` = the REAL booking's requestId (placed by the real direct-deposit path at the
 *  route, where the real fee is paid). The hold then leaves the demo world (isDemoHoldActive → false). Demo-
 *  gated; the hold must still be ACTIVE (not expired, not already upgraded); `requestId` must be non-empty (the
 *  upgrade must name the real booking it became — no fake booking may pose as real). Returns the upgraded hold. */
export async function upgradeDemoHold(args: { holdId: string; requestId: string }): Promise<VrxDemoHold> {
  assertDemo();
  const holdId = args.holdId.trim();
  const requestId = args.requestId.trim().slice(0, 120);
  if (!holdId) throw new Error("holdId required");
  if (!requestId) throw new Error("a real requestId is required to upgrade a demo hold (it must become a real booking — no fake booking may pose as real)");
  return mutateHolds(async (list) => {
    const idx = list.findIndex((h) => h.id === holdId);
    if (idx < 0) throw new Error("demo hold not found");
    const hold = list[idx];
    if (hold.upgradedToRequestId) throw new Error("this demo hold is already upgraded (a double-upgrade would re-point a real booking)");
    if (isDemoHoldExpired(hold)) throw new Error("this demo hold has expired (its demo lease already reverted — place a fresh real booking instead)");
    const next = list.slice();
    next[idx] = { ...hold, upgradedToRequestId: requestId };
    return { next, ret: next[idx] };
  });
}

/** TEST-ONLY: wipe both stores. */
export async function __resetForTests(): Promise<void> {
  await mutateBalances(async () => ({ next: [], ret: undefined }));
  await mutateHolds(async () => ({ next: [], ret: undefined }));
}
