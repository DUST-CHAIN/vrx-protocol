// Server-side cache for the agent picker's resolved access — SERVER-ONLY.
//
// The picker resolves, per agent: their agency (get_peer) + which developers that agency has an ACTIVE
// gate to (get_gate ×N). Those are LIVE on-chain reads — and they're the ONE browse-path piece that had
// no server-side snapshot (unlike unit status, which has .data/status-snapshot.json). So when the free
// testnet RPC hard-throttles (429s the IP on bursts), a legitimately-gated agent got a false "no access"
// / "couldn't reach the network" — even though the grid loaded fine from its snapshot.
//
// Fix (the "why hit the RPC at all — load from the server?"): give ACCESS the same treatment as
// status. Once resolved, persist it to .data/access-cache.json so it serves INSTANTLY and SURVIVES a
// restart + a full RPC outage. Two layers:
//   • fresh (in-process, TTL) → skip the chain entirely on a hot revisit;
//   • stale (persisted, any age) → serve last-known access when the chain is unreachable, instead of a
//     false empty. The chain stays the source of truth (a booking is separately gate-enforced by the
//     contract, E58/NO_GATE), so a slightly-stale access list can never let a bad booking through.
// This is a step toward the indexer (which would keep.data continuously fresh so the apps read the
// chain ~never). PRIVACY: only neutral account ids + building ids/names already served to this agent.

import { promises as fs } from "fs";
import path from "path";

export type PickerBuilding = {
  id: string;
  name: string;
  /** : true once this building has gone ON CONTRACT (a sale baseline exists). The agent's
   *  pre-submit booking guard requires this — a building not yet on contract is not released, so its units
   *  are not bookable (fail-closed: absent/false → not bookable). Derived server-side in the picker route;
   *  cached with the rest (≤60s lag). The /api/offers record belt + the V7 NO_GATE are the belts behind it. */
  onContract?: boolean;
};
export type PickerDeveloper = {
  account: string;
  name: string;
  buildings: PickerBuilding[];
  /** §3c: true when this developer is PAUSED (suspended/removed for overdue VRX fees) → the agent
   *  may still see + run EXISTING deals, but may NOT open a NEW booking against them. Absent/false = normal.
   *  Cached with the rest of the picker (≤60s lag); the /api/offers POST guard is the authoritative belt. */
  listingsPaused?: boolean;
  /** this developer's required buyer-detail fields (§9, direct-profile vocabulary). Lets the
   *  agent booking gate PRE-EMPTIVELY show what this developer needs on a buyer before Reserve. Absent =
   *  the global default floor (checkBuyerPolicy with no override). Pure registry field, cached with the row. */
  requiredProfileFields?: string[];
};
export type PickerResult = { developers: PickerDeveloper[]; agency: string | null };

type Entry = { value: PickerResult; at: number };

const TTL_MS = 60_000; // a fresh resolution is reused for 60s (access changes rarely)

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "access-cache.json");

// In-process layer (fast path). Seeded from disk on first use so a restart doesn't start empty.
const cache = new Map<string, Entry>();
let loaded = false;

function keyOf(id: string): string {
  return id.trim().toLowerCase();
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true; // set first so concurrent callers don't double-read
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const obj = JSON.parse(raw) as Record<string, Entry>;
    for (const [k, v] of Object.entries(obj)) cache.set(k, v);
  } catch {
    /* no file yet — fine */
  }
}

async function persist(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const obj: Record<string, Entry> = {};
    for (const [k, v] of cache.entries()) obj[k] = v;
    await fs.writeFile(STORE, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    /* best-effort — the in-process layer still works if disk write fails */
  }
}

/** A still-fresh cached result (within TTL), or null. */
export async function getFresh(id: string): Promise<PickerResult | null> {
  await ensureLoaded();
  const e = cache.get(keyOf(id));
  if (e && Date.now() - e.at < TTL_MS) return e.value;
  return null;
}

/** The last-known result regardless of age (for serving stale on an RPC outage), or null. */
export async function getStale(id: string): Promise<PickerResult | null> {
  await ensureLoaded();
  return cache.get(keyOf(id))?.value ?? null;
}

/** Remember a freshly-resolved result (in-process + persisted). Call only with a genuine resolution. */
export async function put(id: string, value: PickerResult): Promise<void> {
  await ensureLoaded();
  cache.set(keyOf(id), { value, at: Date.now() });
  await persist();
}
