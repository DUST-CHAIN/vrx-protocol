// STATUS-TRANSITION LEDGER — SERVER-ONLY (file-backed, append-only). The §6 prerequisite spine.
// THE PROBLEM it solves (PROTOCOL_COMMISSION_DESIGN.md §6): the protocol-commission timer limb (§6c b —
// "14 days pass and the unit did NOT revert → TAKE the earmark") needs to know WHEN a unit left `available`
// and WHETHER it bounced back. Today's stores can't answer that: `lib/status-store.ts` keeps only the
// *current* status + a "last verified" time (not *changed*); `OffMarketEvent` covers only block/kill (not
// booked/hold); true live status is on-chain. None of them is a HISTORY. This ledger is that history.
// THE SHAPE: an append-only `.data/status-ledger.json` of StatusTransition `{ unit, from, to, at }` rows.
// reads it (`leftAvailableAt`), the warroom gets a per-unit history, dunning/audit reuse it, and its
// future "auto-rejected" event records into the same store. Same file-backed + serialized-mutate discipline
// as activity.ts / agreements.ts (one choke-point, no interleaved read-modify-write).
// HOW IT'S FED (decision): at the ONE choke-point every status write funnels through —
// `saveBuildingStatuses` in status-store.ts. That function already holds `prev` (old codes) and the incoming
// codes, so it diffs and calls recordTransitions for the units that actually CHANGED. Zero changes to the
// many callers (bulk snapshot pass, cache refresh, on-demand unit open, "Live"). The spec says "fed by the
// snapshot pass and/or the indexer"; the seam alone satisfies §6.
// ⚠️ KNOWN GAP (for the future timer — honest limitation of the seam feed): the seam only sees
// transitions BETWEEN two status reads. A unit that goes 0→1→0 entirely between two snapshot passes looks
// like 0→0 (no change) and records NOTHING — a fast bounce is invisible. For the 14-day timer this matters
// (it asks "did it bounce back?"). The fix is the event-indexer feed (reads on-chain claim_opened/replied
// in order → never misses a transition), added LATER into THIS SAME store (store + read-API are identical
// either way; the feed is pluggable). Until then the timer must treat "no bounce recorded" as best-effort,
// not proof. Sequenced deliberately: spine+seam now, indexer feed as a clean follow-on.
// PRIVACY: the ledger holds ONLY `unitId → status code` (0 open · 1 hold · 2 closed · 3 done · -1 not
// stamped) + timestamps. No hashes, prices, or PII — exactly the same opacity the snapshot already has. The
// catalog (off-chain) holds the human detail; the chain is the source of the codes.

import { promises as fs } from "fs";
import path from "path";

// ── Status codes (mirror lib/status-store.ts; kept named here so the ledger reads legibly) ───────────────
/** A unit that is available to book. The "home" state the timer measures departures FROM. */
export const STATUS_AVAILABLE = 0;

/** One recorded change of a unit's status. Append-only; never mutated once written. `from` is null for the
 * FIRST time we ever observed the unit (an honest initial-observation row, not a fabricated transition). */
export type StatusTransition = {
  /** Stable unique id (store key). */
  id: string;
  /** Catalog building id (lib/catalog.ts) the unit belongs to. */
  buildingId: string;
  /** Catalog unit id. */
  unit: string;
  /** The code the unit moved FROM, or null for the first observation of this unit. */
  from: number | null;
  /** The code the unit moved TO. */
  to: number;
  /** ms epoch the change was observed. */
  at: number;
};

/** The shape a caller hands recordTransitions — the store stamps id + at. */
export type TransitionInput = {
  unit: string;
  from: number | null;
  to: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "status-ledger.json");

async function readAll(): Promise<StatusTransition[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8"));
    return Array.isArray(parsed) ? (parsed as StatusTransition[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: StatusTransition[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(rows, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as activity.ts/agreements.ts.
// Without this, two status passes writing at once both readAll the old list and the second writeAll
// drops the first's rows.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (rows: StatusTransition[]) => { next: StatusTransition[]; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/**
 * APPEND one or more transitions for a building. Called from the status-store seam with ONLY the units that
 * actually changed (the diff is the caller's job — an unchanged status must never reach here). Best-effort:
 * never throws — a ledger-write failure must not break the status write that triggered it (same contract as
 * activity.logActivity). A caller passing an empty list is a cheap no-op (no file write).
 */
export async function recordTransitions(buildingId: string, changes: TransitionInput[]): Promise<void> {
  try {
    if (!buildingId || changes.length === 0) return;
    const at = Date.now();
    const rows: StatusTransition[] = changes.map((c, i) => ({
      // at+i keeps ids unique within a single batch written in the same ms (Math.random tail guards collisions).
      id: `st-${at}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      buildingId,
      unit: c.unit,
      from: c.from,
      to: c.to,
      at,
    }));
    await mutate((cur) => ({ next: [...cur, ...rows], ret: null }));
  } catch {
    /* best-effort: the ledger is a durable convenience, never a blocker on the real status write */
  }
}

/** Every transition for one unit in a building, newest-first. */
export async function transitionsForUnit(buildingId: string, unit: string): Promise<StatusTransition[]> {
  return (await readAll())
    .filter((r) => r.buildingId === buildingId && r.unit === unit)
    .sort((a, b) => b.at - a.at);
}

/** Every transition in a building, newest-first (the warroom/audit per-building history). */
export async function transitionsForBuilding(buildingId: string): Promise<StatusTransition[]> {
  return (await readAll())
    .filter((r) => r.buildingId === buildingId)
    .sort((a, b) => b.at - a.at);
}

/**
 * The derived query the §6c timer needs: when did this unit MOST RECENTLY leave `available` (code 0)
 * and NOT return to available since? Returns that departure's `at` (the 14-day clock anchor), or null if the
 * unit is currently available / was never seen leaving / has bounced back to available since its last
 * departure. Pure read — the timer/earmark resolver (arc step 5) is NOT built here; this only EXPOSES the
 * data it will consume, so step 5 doesn't have to invent the ledger inline (the §10 "do not build the
 * resolver before step 3" guard).
 *
 * ⚠️ Best-effort per the seam-feed gap documented at the top: a fast 0→X→0 bounce that happened entirely
 * between two status reads is invisible to the seam, so "not returned" here means "no return RECORDED", not
 * proof. The indexer feed closes that gap later without changing this function's contract.
 */
export async function leftAvailableAt(buildingId: string, unit: string): Promise<number | null> {
  const rows = await transitionsForUnit(buildingId, unit); // newest-first
  return leftAvailableFromRows(rows);
}

/**
 * The PURE core of leftAvailableAt, split out so the money-critical derive can be unit-tested with injected
 * rows (no file IO). `rows` MUST be newest-first (as transitionsForUnit returns). Walk from the most recent:
 * if the unit's most recent move was a RETURN to available (to === 0), there's no running clock → null.
 * Otherwise the most recent DEPARTURE from available (from === 0) is the moment the current away-stretch
 * began → its `at` is the 14-day anchor. Transitions among non-available states (e.g. 1→2) don't reset the
 * clock; only a return to available would, and if we hit one first (newest) the unit is back home → null.
 */
export function leftAvailableFromRows(rows: StatusTransition[]): number | null {
  for (const r of rows) {
    if (r.to === STATUS_AVAILABLE) return null; // most recent move was a return to available → no clock
    if (r.from === STATUS_AVAILABLE) return r.at; // the departure that started the current away-stretch
  }
  return null; // never observed leaving available
}
