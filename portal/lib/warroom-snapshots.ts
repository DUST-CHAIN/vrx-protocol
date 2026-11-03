// WARROOM DAILY SNAPSHOTS — SERVER-ONLY (file-backed). The 6th member of the per-developer `.data`
// store family (offers · agreements · buyer-events · channels · activity · THIS), and the data behind
// the warroom's time SCRUBBER.
//
// THE PROBLEM: the warroom wants to REPLAY availability over time — "slide back and
// what the building looked like last Tuesday". But reconstructing historical on-chain state is the heavy
//  indexer we deliberately deferred. We never re-index the chain here.
//
// THE DESIGN (resolved with): capture frames going FORWARD. Once a day, per developer, we take
// a copy of the availability we ALREADY HOLD — the persisted browse cache in lib/status-store
// (.data/status-snapshot.json, which is itself fed from our server, "browse from our server") — and
// stamp it with the date. No chain reads. The scrubber then slides across the frames we have CAPTURED;
// days before capture began honestly read "no snapshot yet" (we never fabricate history).
//
// TRIGGER (no cron on this machine): the warroom route calls captureToday opportunistically on load —
// if today's frame is missing it writes one from the current status snapshot. That gives a real daily
// cadence for an actively-used warroom with zero infrastructure. A production developer's self-hosted
// node would instead run a scheduled job calling the SAME captureToday — see the hook note on
// that function. Either way the store shape is identical, so the demo stand-in → node migration story is
// the same one every other `.data` store already tells.
//
// PRIVACY: a frame maps catalog unitId → status code (0 open · 1 hold · 2 closed · 3 done · -1 not
// listed). No hashes, prices, or PII — exactly the same opaque shape lib/status-store already persists.
// The catalog (off-chain) holds the human detail the warroom renders alongside.

import { promises as fs } from "fs";
import path from "path";
import { loadSnapshot } from "./status-store";
import { getCatalog } from "./catalog";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "warroom-snapshots.json");

/** One captured day's availability for one developer. `buildings[bid][uid] = status code`. */
export type DailyFrame = {
  /** The developer account this frame belongs to (the per-node owner key). */
  developer: string;
  /** Local calendar date the frame was captured, "YYYY-MM-DD" (one frame per developer per day). */
  date: string;
  /** buildingId → (unitId → status code). Mirrors lib/status-store BuildingSnapshot.units, per building. */
  buildings: Record<string, Record<string, number>>;
  /** ms epoch the frame was written (for "captured X ago" + ordering within a day). */
  at: number;
};

/** The whole store: the append-only daily frames + the per-developer last-visit marks. */
type WarroomStore = {
  frames: DailyFrame[];
  /** developer account → ms epoch of their last warroom visit (drives "what's new since last visit"). */
  lastVisit: Record<string, number>;
};

const EMPTY: WarroomStore = { frames: [], lastVisit: {} };

// Serialize writes (read-modify-write can't interleave) — same discipline as activity.ts / events.ts.
let chain: Promise<unknown> = Promise.resolve();

async function readStore(): Promise<WarroomStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8")) as Partial<WarroomStore>;
    return {
      frames: Array.isArray(parsed?.frames) ? parsed.frames : [],
      lastVisit: parsed?.lastVisit && typeof parsed.lastVisit === "object" ? parsed.lastVisit : {},
    };
  } catch {
    return { ...EMPTY };
  }
}

async function writeStore(s: WarroomStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(s, null, 2), "utf8");
}

function mutate<T>(fn: (s: WarroomStore) => { next: WarroomStore; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readStore();
    const { next, ret } = fn(cur);
    await writeStore(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/** Local "YYYY-MM-DD" for a ms epoch (default now). Local, so a frame's date matches the viewer's day. */
export function dayKey(at: number = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Capture TODAY's availability frame for a developer, if one isn't already stored for today. Reads the
 * availability we ALREADY HOLD (the persisted status snapshot, lib/status-store) — never the chain — and
 * copies it, scoped to the buildings in the catalog. Idempotent per developer+day: a second call the same
 * day is a no-op, so the warroom can call it freely on every load.
 *
 * NODE HOOK: in production this exact function is what a developer's self-hosted node would call
 * from a once-a-day scheduled job (cron/systemd-timer) instead of relying on the opportunistic load-time
 * trigger. The store shape doesn't change when it moves to the node — same frames, same scrubber.
 *
 * Returns the frame for today (the freshly-captured one, or the existing one).
 */
export async function captureToday(developer: string): Promise<DailyFrame | null> {
  const dev = developer.trim().toLowerCase();
  if (!dev) return null;
  const today = dayKey();

  // Fast path: already captured today — no read of the status snapshot needed.
  const existing = (await readStore()).frames.find((f) => f.developer === dev && f.date === today);
  if (existing) return existing;

  // Build today's frame from the availability we hold (no chain reads).
  const [snap, catalog] = await Promise.all([loadSnapshot(), getCatalog()]);
  const buildings: Record<string, Record<string, number>> = {};
  for (const b of catalog) {
    const units = snap[b.id]?.units;
    if (units && Object.keys(units).length > 0) {
      // Copy only known unit statuses (absent = unknown; we don't fabricate -1 for unseen units).
      buildings[b.id] = { ...units };
    }
  }
  // Nothing captured yet anywhere → don't write an empty frame (an honest "no snapshot yet").
  if (Object.keys(buildings).length === 0) return null;

  const frame: DailyFrame = { developer: dev, date: today, buildings, at: Date.now() };
  return mutate((s) => {
    // Guard against a race: another request may have captured today between our read and this write.
    if (s.frames.some((f) => f.developer === dev && f.date === today)) {
      return { next: s, ret: s.frames.find((f) => f.developer === dev && f.date === today)! };
    }
    return { next: { ...s, frames: [...s.frames, frame] }, ret: frame };
  });
}

/**
 * The developer's captured frames over the last `days` calendar days, oldest-first (so a scrubber slider
 * reads left=older → right=newer). Only real captured frames are returned — the UI fills the gap days
 * itself with an honest "no snapshot" state. A developer with no frames yet gets [].
 */
export async function framesFor(developer: string, days = 30): Promise<DailyFrame[]> {
  const dev = developer.trim().toLowerCase();
  if (!dev) return [];
  const cutoff = dayKey(Date.now() - (days - 1) * 86_400_000);
  return (await readStore()).frames
    .filter((f) => f.developer === dev && f.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date) || a.at - b.at);
}

/** The developer's last warroom-visit timestamp (ms epoch), or null if they've never visited. */
export async function getLastVisit(developer: string): Promise<number | null> {
  const dev = developer.trim().toLowerCase();
  if (!dev) return null;
  return (await readStore()).lastVisit[dev] ?? null;
}

/**
 * Stamp the developer's last-visit to NOW and return the PREVIOUS value (so the caller can compute
 * "what's new since last visit" against the value from before this visit). First-ever visit returns null.
 */
export async function markVisited(developer: string): Promise<number | null> {
  const dev = developer.trim().toLowerCase();
  if (!dev) return null;
  return mutate((s) => {
    const prev = s.lastVisit[dev] ?? null;
    return { next: { ...s, lastVisit: { ...s.lastVisit, [dev]: Date.now() } }, ret: prev };
  });
}
