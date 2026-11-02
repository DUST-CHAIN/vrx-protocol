// Building stat helpers — aggregate figures for the building cards + the building summary
// Pure functions over the catalog Building + an optional status map, so both the card grid and the

import type { Building, Unit } from "./catalog-client";
import { isKilled, isBlocked } from "./offmarket";

export type TypeRange = {
  key: string;
  label: string;
  count: number;
  sqmMin: number;
  sqmMax: number;
  priceMinUsd: number;
  priceMaxUsd: number;
};

export type FloorAvail = {
  floor: number;
  /** available units on this floor, grouped by type label (e.g. "2 × 1BR"). */
  byType: { label: string; count: number }[];
  available: number;
  total: number;
};

export type BuildingStats = {
  total: number;
  /** counts by status code from the map (may be partial if snapshot incomplete). */
  available: number; // status 0
  sold: number; // status 2 or 3
  onHold: number; // status 1
  /** units the developer has taken off-market (blocked) — inventory, but not available. */
  offMarket: number;
  /** units with no known status yet (absent from the map — "still loading"/uncached). */
  unknown: number;
  /** units present in the map but NOT stamped on-chain (status -1) — real inventory the developer
   * hasn't listed on-chain yet. Distinct from `unknown` (absent) — this is a known "not listed" state. */
  notListed: number;
  priceMinUsd: number;
  priceMaxUsd: number;
  types: TypeRange[];
  floors: FloorAvail[];
};

const typeLabel = (b: Building, key: string) => b.unitTypes.find((t) => t.key === key)?.label ?? key.toUpperCase();

/**
 * Compute all card/summary stats for a building. `status` is unitId → code (0/1/2/3/-1); absent = unknown.
 *
 * OFF-MARKET: KILLED units are excluded from EVERY figure — they vanish exactly as the operator catalog's
 * `unit_killed=0` filter drops them from all stats. BLOCKED units still count toward the total (they're
 * inventory the developer is holding) but are reported as `offMarket`, never `available` — an agent/buyer
 * can't book them, and the developer sees them as held, not sellable.
 */
export function buildingStats(b: Building, status: Record<string, number> = {}): BuildingStats {
  // Killed units are removed from the inventory entirely before any counting.
  const inv = b.inventory.filter((u) => !isKilled(u));
  let available = 0,
    sold = 0,
    onHold = 0,
    offMarket = 0,
    unknown = 0,
    notListed = 0;
  for (const u of inv) {
    if (isBlocked(u)) {
      offMarket++;
      continue; // a blocked unit is held — not available, sold, or on-hold regardless of its tile
    }
    const s = status[u.id];
    if (s === undefined) unknown++;
    else if (s === 0) available++;
    else if (s === 1) onHold++;
    else if (s === 2 || s === 3) sold++;
    else if (s === -1) notListed++; // stamped nowhere yet — real inventory, just not on-chain (was silently dropped)
    // (any other code is ignored defensively)
  }

  // Per-type size + price ranges.
  const byType = new Map<string, Unit[]>();
  for (const u of inv) {
    if (!byType.has(u.type)) byType.set(u.type, []);
    byType.get(u.type)!.push(u);
  }
  const types: TypeRange[] = [...byType.entries()].map(([key, us]) => ({
    key,
    label: typeLabel(b, key),
    count: us.length,
    sqmMin: Math.min(...us.map((u) => u.sqm)),
    sqmMax: Math.max(...us.map((u) => u.sqm)),
    priceMinUsd: Math.min(...us.map((u) => u.priceUsd)),
    priceMaxUsd: Math.max(...us.map((u) => u.priceUsd)),
  }));

  // Per-floor availability (only counts units known-available). Descending floor order.
  const floorsSet = Array.from(new Set(inv.map((u) => u.floor))).sort((a, c) => c - a);
  const floors: FloorAvail[] = floorsSet.map((floor) => {
    const fUnits = inv.filter((u) => u.floor === floor);
    const avail = fUnits.filter((u) => status[u.id] === 0 && !isBlocked(u));
    const byTypeCount = new Map<string, number>();
    for (const u of avail) byTypeCount.set(u.type, (byTypeCount.get(u.type) ?? 0) + 1);
    return {
      floor,
      available: avail.length,
      total: fUnits.length,
      byType: [...byTypeCount.entries()].map(([key, count]) => ({ label: typeLabel(b, key), count })),
    };
  });

  return {
    total: inv.length,
    available,
    sold,
    onHold,
    offMarket,
    unknown,
    notListed,
    priceMinUsd: inv.length ? Math.min(...inv.map((u) => u.priceUsd)) : 0,
    priceMaxUsd: inv.length ? Math.max(...inv.map((u) => u.priceUsd)) : 0,
    types,
    floors,
  };
}
