// Off-chain EXCLUSIVE-HOLD mirror — SERVER-ONLY (file-backed). The write-through half of exclusive holds
//, same pattern as gates.ts / developers.ts / agents.ts, and the same reasoning as for the event
// mirror: DON'T scan the chain to discover our own state.
// THE PROBLEM THIS SOLVES: the developer's "Exclusive holds" panel used to answer "which of my units are on
// hold?" by calling get_exclusive on EVERY catalog unit — 1,558 reads per open. Keyless that floods the free
// RPC and the panel hangs. But WE author every hold through the portal (grant_exclusive / release_exclusive
// in /node), so we already know them — record them here at grant/release time and the panel reads this map
// in ONE request, zero chain reads.
// SOURCE OF TRUTH is still the CONTRACT: get_exclusive is authoritative, and the booking path enforces it
// (E58 / NO_GATE) — a stale mirror can never let a bad booking through, exactly like the gate mirror. The
// mirror is a fast INDEX of what we did, not the authority. Expiry is honored by `until` (ns) just like the
// contract's lazy auto-release: a past-`until` record is treated as no-hold (see liveHolds).
// PRIVACY: neutral account ids + opaque unit key + a timestamp window. No PII, no plaintext terms.

import { promises as fs } from "fs";
import path from "path";

export type ExclusiveHold = {
  /** Opaque on-chain unit key (hashRef(unitRef, "vrx-unit")) — matches get_exclusive's unit_key. */
  unitKey: string;
  /** Catalog building id + unit id, carried so the panel can label the row without a catalog cross-walk. */
  buildingId: string;
  unitId: string;
  /** The agency (org) the hold is for — mirrors Exclusive.o. */
  orgId: string;
  /** The developer (node) that granted it — mirrors Exclusive.b; the panel scopes to its own holds. */
  developer: string;
  /** Expiry in ns-since-epoch — mirrors Exclusive.u; a past value = auto-released (contract lazy-clears). */
  until: number;
  /** False once released early (release_exclusive) — kept as a tombstone so a re-grant upserts cleanly. */
  active: boolean;
  /** ms epoch when recorded/updated. */
  at: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "exclusives.json");

async function readAll(): Promise<ExclusiveHold[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ExclusiveHold[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: ExclusiveHold[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** A hold is LIVE when it's active AND not past its `until` (ns) — the same rule the contract applies
 * lazily, and the same rule lib/vrx.liveHolder uses client-side, so the mirror never shows a dead hold. */
function isLive(h: ExclusiveHold): boolean {
  return h.active && !!h.until && h.until / 1e6 > Date.now();
}

/** The LIVE exclusive holds granted by this developer (write-through view) — what the /node panel renders.
 * Zero chain reads. Newest expiry last so the panel's existing sort stays stable. */
export async function liveHoldsForDeveloper(developer: string): Promise<ExclusiveHold[]> {
  const dev = developer.trim().toLowerCase();
  return (await readAll())
    .filter((h) => h.developer.toLowerCase() === dev && isLive(h))
    .sort((a, b) => a.until - b.until);
}

/** Record a granted hold (idempotent on unitKey — a re-grant on the same unit upserts the new holder/window). */
export async function recordHold(h: Omit<ExclusiveHold, "active" | "at">): Promise<void> {
  const unitKey = h.unitKey.trim();
  if (!unitKey || !h.developer.trim() || !h.orgId.trim()) return;
  const list = await readAll();
  const idx = list.findIndex((x) => x.unitKey === unitKey);
  const rec: ExclusiveHold = { ...h, unitKey, active: true, at: Date.now() };
  if (idx >= 0) list[idx] = rec;
  else list.push(rec);
  await writeAll(list);
}

/** Mark a hold released early (release_exclusive). Idempotent; a no-op if we never recorded it. */
export async function releaseHold(unitKey: string): Promise<void> {
  const key = unitKey.trim();
  if (!key) return;
  const list = await readAll();
  const idx = list.findIndex((x) => x.unitKey === key);
  if (idx < 0) return;
  list[idx] = { ...list[idx], active: false, at: Date.now() };
  await writeAll(list);
}
