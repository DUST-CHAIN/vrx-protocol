// RELEASE READINESS CROSS-CHECK — SERVER-ONLY. The vetting/release-lifecycle.
//
// THE RULE stated: before a building goes ON CONTRACT (the developer's go-on-contract sign-off, which
// starts the commission clock and makes units bookable), EVERY unit must carry an EXPLICIT vetted
// status — available / withheld / sold-already / etc. A unit still at -1 (NOT STAMPED) has no decision on it:
// the developer hasn't said what it is. Going on contract with -1 units leaves a silent gap — those units are
// fail-closed NOT bookable, but the developer may not realize they never vetted them.
//
// This module answers ONE question honestly, like gate-agreement-check.ts: for a building, which units have NO
// explicit status (still -1)? It is a READ-ONLY cross-check (no writes, no on-chain, no auto-fix) — the release
// screen or the go-on-contract flow reads it and surfaces "N units haven't been given a status yet". It does
// NOT stamp anything: assigning a status stays a deliberate developer act (the fix is to surface the gap, not
// paper over it). Clean (0 unvetted) is the signal the slate is ready for sign-off.
//
// "Explicit status" = any snapshot code 0..3 (open / hold / closed / done). "Unvetted" = -1 (not stamped) OR
// a unit the snapshot has never seen at all (absent → treated as -1, fail-closed: unknown = not yet vetted).
//
// RELATION TO THE BOOKING GATE (lib/bookable): bookable is PER-UNIT at book time (on contract AND open). THIS
// is PER-BUILDING at sign-off time (is the whole slate decided?). Two different questions, same status source.
// (caller-facing copy lives in the surface, not here; this returns ids + a machine shape.)

import { getBuilding } from "./catalog";
import { getBuildingSnapshot } from "./status-store";

/** The "not stamped / no explicit status yet" sentinel (lib/status-store status codes: 0..3 explicit, -1 not). */
export const STATUS_UNVETTED = -1;

/** The release-readiness picture for one building. `ready` = every known unit has an explicit status. */
export type ReleaseReadiness = {
  /** The catalog building id (verbatim). */
  building: string;
  /** Total units in the building's catalog inventory. */
  totalUnits: number;
  /** Units that carry an explicit status 0..3 (vetted — a decision was made). */
  vettedUnits: number;
  /** Unit ids with NO explicit status yet (snapshot -1, or absent from the snapshot). Sorted. */
  unvettedUnits: string[];
  /** True iff NO unit is unvetted — the slate is fully decided, ready for go-on-contract sign-off. */
  ready: boolean;
};

/**
 * The release-readiness cross-check for a building: which units still lack an explicit vetted status (-1 or
 * absent). Pure read (catalog inventory + the status snapshot — the same pair go-on-contract reads). Returns a
 * machine shape; the surface writes the caller-facing copy. Unknown building → totalUnits 0, ready true-vacuous
 * is avoided: an unknown/empty building returns ready=false (nothing to release = not a valid slate to sign off).
 */
export async function releaseReadiness(building: string): Promise<ReleaseReadiness> {
  const bld = await getBuilding(building);
  const ids = bld ? bld.inventory.map((u) => u.id) : [];
  const snap = await getBuildingSnapshot(building);
  const units = snap?.units ?? {};

  const unvetted: string[] = [];
  for (const id of ids) {
    const status = units[id];
    if (status === undefined || status === STATUS_UNVETTED) unvetted.push(id);
  }
  unvetted.sort();

  const totalUnits = ids.length;
  return {
    building,
    totalUnits,
    vettedUnits: totalUnits - unvetted.length,
    unvettedUnits: unvetted,
    // Ready iff there IS a slate AND nothing on it is unvetted. An empty/unknown building is not "ready" (you
    // can't sign off on nothing) — mirrors go-on-contract's own "empty available set → refuse" guard.
    ready: totalUnits > 0 && unvetted.length === 0,
  };
}
