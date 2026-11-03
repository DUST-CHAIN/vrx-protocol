// Persistent status snapshot (the idea) — SERVER-ONLY (file-backed).
//
// THE PROBLEM the snapshot solves: reading a building's on-chain unit status one get_tile at a time is
// inherently heavy (a tower = hundreds of tiles). Doing it per-tab-reload saturated the public RPC and
// even earned a temporary IP block (the penalty is a hard 429-everything, not a throttle). So we can't
// keep hitting the chain in bulk from the request path.
//
// THE SNAPSHOT: do ONE gentle, rate-respecting pass (scripts/snapshot-status.mjs) that reads every
// unit's status once and PERSISTS it here to .data/status-snapshot.json. That file is the durable BASE:
// the portal serves availability from it INSTANTLY, with zero RPC per view. Only when a user opens a
// specific unit or hits "Live" do we read the chain — a tiny, safe amount. When we later pay for a
// dedicated RPC (or add an event indexer), the snapshot upgrades into a push-fed cache — same shape.
//
// PRIVACY: still opaque. The snapshot maps catalog unit ids → a status code (0..3, -1). No hashes,
// prices, or PII — just "is this unit available". The catalog (off-chain) holds the human detail.

import { promises as fs } from "fs";
import path from "path";
import { recordTransitions, type TransitionInput } from "./status-ledger";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "status-snapshot.json");

export type BuildingSnapshot = {
  /** unitId → status code (0 open · 1 hold · 2 closed · 3 done · -1 not stamped). */
  units: Record<string, number>;
  /** epoch ms this building's snapshot was last (partially) written (building-level, for the card). */
  filledAt: number;
  /** true once a full pass has covered every unit in the building. */
  complete: boolean;
  /** PER-UNIT freshness: unitId → epoch ms THAT unit's status was last verified. Lets the
   *  UI show "verified X ago" on the clicked unit (not a building-wide time) and lets the server refresh
   *  only HOT units. Additive + backward-compatible: old snapshots without it fall back to filledAt. */
  unitAt?: Record<string, number>;
};

export type StatusSnapshot = Record<string, BuildingSnapshot>;

let memo: StatusSnapshot | null = null;

/** Load the whole snapshot from disk (memoised). Returns {} if none exists yet. */
export async function loadSnapshot(): Promise<StatusSnapshot> {
  if (memo) return memo;
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw) as StatusSnapshot;
    memo = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    memo = {};
  }
  return memo;
}

/** The snapshot for one building, or null if we haven't captured it yet. */
export async function getBuildingSnapshot(buildingId: string): Promise<BuildingSnapshot | null> {
  const snap = await loadSnapshot();
  return snap[buildingId] ?? null;
}

/**
 * The PURE diff (extracted so the status-ledger seam contract is testable without IO).
 * Given the PREVIOUS per-unit codes and the INCOMING codes (often a merged full map {...known...read}),
 * return exactly the transitions that must be recorded:
 *   • a unit whose code is UNCHANGED emits NOTHING (re-writing a merged map must not fake transitions);
 *   • a unit ABSENT from prev is its first-ever observation → `from: null` (honest, not a faked 0→x);
 *   • a changed code emits `{ unit, from, to }`.
 * This is the contract the append-only ledger depends on and the §6c timer reads downstream, so it
 * is pinned by a test. Pure: no IO, no Date — the caller stamps time + persists.
 */
export function diffStatuses(
  prevUnits: Record<string, number>,
  incoming: Record<string, number>
): TransitionInput[] {
  const changes: TransitionInput[] = [];
  for (const [unit, to] of Object.entries(incoming)) {
    const from = unit in prevUnits ? prevUnits[unit] : null;
    if (from !== to) changes.push({ unit, from, to });
  }
  return changes;
}

/**
 * Merge freshly-read statuses into a building's snapshot and persist. Used by the manual pass (bulk)
 * and by on-demand reads (a clicked unit / Live) so the snapshot only ever gets MORE complete/current.
 * `complete` marks a building whose full pass finished.
 */
export async function saveBuildingStatuses(
  buildingId: string,
  statuses: Record<string, number>,
  opts: { complete?: boolean } = {}
): Promise<void> {
  const snap = await loadSnapshot();
  const prev = snap[buildingId];
  const now = Date.now();
  // ── Status-ledger seam ──────────────────────────────────────────────────────────────────────
  // This is the ONE choke-point every status write funnels through (bulk pass, cache refresh, on-demand,
  // "Live"), so diffing here feeds the append-only transition ledger with zero changes to the many callers.
  // Callers often pass a MERGED full map ({...known...read}), so a diff against the previous codes is
  // essential — re-writing an unchanged unit must emit NOTHING. A unit absent from prev is its first-ever
  // observation (from: null), recorded honestly rather than faked as a transition.
  const prevUnits = prev?.units ?? {};
  const changes = diffStatuses(prevUnits, statuses);
  // Stamp each freshly-read unit with its own verified-at time (per-unit freshness). Units not in this
  // write keep their previous timestamp — so a targeted single-unit read only freshens THAT unit.
  const unitAt = { ...(prev?.unitAt ?? {}) };
  for (const id of Object.keys(statuses)) unitAt[id] = now;
  snap[buildingId] = {
    units: { ...prevUnits, ...statuses },
    filledAt: now,
    complete: opts.complete ?? prev?.complete ?? false,
    unitAt,
  };
  memo = snap;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(snap, null, 2), "utf8");
  // Append AFTER the snapshot is safely persisted (best-effort; recordTransitions never throws). A no-op
  // when nothing changed. Fire-and-forget so a ledger write never slows/blocks the status write.
  void recordTransitions(buildingId, changes);
}

/** Drop the in-memory memo so the next read re-loads from disk (after the manual pass rewrites it). */
export function invalidateSnapshotMemo(): void {
  memo = null;
}
