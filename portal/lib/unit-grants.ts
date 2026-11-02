// PER-(BUYER, BUILDING, UNIT) UNIT GRANTS — SERVER-ONLY (file-backed). §9 steps 3b–5: the record of
// which specific units the desk has OPENED to which direct buyer. The anti-browsing funnel's SECOND gate:
// lib/buyer-catalog gates what a buyer may BROWSE (visible buildings, lossy); THIS gates what a buyer may
// see in DETAIL (specific units an operator deliberately opened to them, in conversation).
// ── Ownership (the opposite of buyers-direct) ────────────────────────────────────────────────────────
// buyers-direct is BUYER-owned (the buyer self-writes their profile). A unit grant is DESK-owned: only the
// building's desk developer writes it — it is the operator's deliberate decision "I am showing THIS buyer
// THIS unit". That's why it is a SEPARATE store, not a field on the buyer record (a buyer must not be able
// to grant themselves a unit — the ownership smell the §9 design flagged). The buyer only ever READS their
// own grants (joined to real unit detail by the buyer route, lossy until offer-eligible — §9 answer).
// ── Why it BYPASSES directSale.visible (§8-3) ───────────────────────────────────────────────────────
// A grant is a DELIBERATE operator offer. Per §8-3 ("an operator's offer IS the per-(buyer,unit) open grant
// and BYPASSES directSale.visible"), the grant is its own access decision — a desk may open a unit in a
// building that isn't in the public browse funnel (a swap-interest offer). So the buyer route resolves a
// granted unit from the FULL catalog, not the lossy buyer projection, scoped to the grant.
// ── The seal spine ──────────────────────────────────────────────────────────────────────
// 5th consumer of the attested-record spine (offers → agreements → agent-roster buyers → buyers-direct →
// this). Each grant carries a salted seal over (buyer|building|unit|by) so the record of WHO opened WHAT
// to WHOM is tamper-evident. Revoking is a soft DELETE (the grant row is removed) — the funnel state it
// advanced is NOT rolled back (opening a unit is a funnel event that happened; see lib/buyers-direct).
// PRIVACY: SERVER-ONLY; neutral account ids + opaque building/unit ids; nothing on-chain by itself.
// Serialized writes (the lost-write guard) since the desk writes while the buyer reads.

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";

const GRANT_DOMAIN = "vrx-unit-grant";

/** A single opened-unit grant: the desk opened (building, unit) to (buyer). Keyed by all three. */
export type UnitGrant = {
  /** The buyer's wallet account (lowercased — the store key half). */
  buyer: string;
  /** The building id (catalog id; not lowercased elsewhere, so kept verbatim). */
  building: string;
  /** The unit id within that building (Unit.id). */
  unit: string;
  /** The desk developer account that opened it (the operator — provenance). */
  by: string;
  /** Per-record secret salt (hex) — stored next to the plaintext for re-verify. NEVER on-chain. */
  salt: string;
  /** SHA-256(domain | salt | stableStringify({buyer,building,unit,by})) — tamper-evident seal. */
  sealHash: string;
  /** ms epoch opened. */
  at: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "unit-grants.json");

// ── Store IO (serialized via a promise chain — the lost-write guard, since the desk writes while the
// buyer reads concurrently). ─────────────────────────────────────────────────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: UnitGrant[]) => { next: UnitGrant[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

async function readAll(): Promise<UnitGrant[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UnitGrant[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: UnitGrant[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

const normAccount = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
const normId = (s: unknown) => (typeof s === "string" ? s.trim() : "");

/** The sealed payload for a grant — the stable fields whose integrity the seal protects. */
function grantPayload(buyer: string, building: string, unit: string, by: string) {
  return { buyer, building, unit, by };
}

/**
 * Open (grant) a specific unit to a buyer. Idempotent: re-opening an existing (buyer,building,unit) returns
 * the existing grant unchanged (no duplicate, no re-seal — the first open is the provenance). Returns the
 * grant, or null if any key field is missing. The CALLER (route) must authorize that `by` is the building's
 * desk developer — this store does not know the developer registry (keeps it a pure record).
 */
export async function grantUnit(
  buyer: string,
  building: string,
  unit: string,
  by: string
): Promise<UnitGrant | null> {
  const b = normAccount(buyer);
  const g = normId(building);
  const u = normId(unit);
  const dev = normAccount(by);
  if (!b || !g || !u || !dev) return null;

  return mutate((list) => {
    const existing = list.find((x) => x.buyer === b && x.building === g && x.unit === u);
    if (existing) return { next: list, ret: existing };
    const salt = newSalt();
    const grant: UnitGrant = {
      buyer: b,
      building: g,
      unit: u,
      by: dev,
      salt,
      sealHash: digest(grantPayload(b, g, u, dev), GRANT_DOMAIN, salt),
      at: Date.now(),
    };
    return { next: [...list, grant], ret: grant };
  });
}

/**
 * Revoke (close) a previously-opened unit for a buyer. Soft delete — removes the grant row. Returns true if
 * a grant was removed, false if none matched. Does NOT roll back the buyer's funnel state (opening a unit was
 * a funnel event that happened; closing it doesn't un-happen it — see lib/buyers-direct).
 */
export async function revokeUnit(buyer: string, building: string, unit: string): Promise<boolean> {
  const b = normAccount(buyer);
  const g = normId(building);
  const u = normId(unit);
  if (!b || !g || !u) return false;
  return mutate((list) => {
    const next = list.filter((x) => !(x.buyer === b && x.building === g && x.unit === u));
    return { next, ret: next.length !== list.length };
  });
}

/** Every unit opened to a buyer (across all buildings), newest first. */
export async function grantsForBuyer(buyer: string): Promise<UnitGrant[]> {
  const b = normAccount(buyer);
  if (!b) return [];
  return (await readAll()).filter((x) => x.buyer === b).sort((a, c) => c.at - a.at);
}

/** Units a desk developer has opened to a specific buyer in a specific building (for the desk UI). */
export async function grantsForBuyerBuilding(buyer: string, building: string): Promise<UnitGrant[]> {
  const b = normAccount(buyer);
  const g = normId(building);
  if (!b || !g) return [];
  return (await readAll()).filter((x) => x.buyer === b && x.building === g).sort((a, c) => c.at - a.at);
}

/** Is THIS unit opened to THIS buyer? The single fail-closed predicate the buyer unit route calls. */
export async function isUnitGranted(buyer: string, building: string, unit: string): Promise<boolean> {
  const b = normAccount(buyer);
  const g = normId(building);
  const u = normId(unit);
  if (!b || !g || !u) return false;
  return (await readAll()).some((x) => x.buyer === b && x.building === g && x.unit === u);
}

/** The ✓-verifiable check: re-hash the grant's stable fields with its salt and compare to its seal. */
export function verifyGrant(x: UnitGrant): boolean {
  try {
    if (!x?.salt || !x?.sealHash) return false;
    return digest(grantPayload(x.buyer, x.building, x.unit, x.by), GRANT_DOMAIN, x.salt) === x.sealHash;
  } catch {
    return false;
  }
}
