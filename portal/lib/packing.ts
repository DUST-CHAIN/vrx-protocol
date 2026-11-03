// Freehold-quota PACKING advisor — pure bin-packing over off-chain unit sizes. No `fs`, no React.
//
// THE PROBLEM: a fraction of the foreign-freehold quota gets STRANDED. If 120 m² of quota is
// left but the smallest available unit is 44 m², only 2 fit (88 m²) and 32 m² is wasted — unusable
// "because units are larger". Over a whole building this stranded m² is quota (and revenue) the
// developer can't realise as freehold.
//
// THE MODEL: classic 0/1 KNAPSACK — the remaining foreign m² is the BIN capacity; the available units
// are ITEMS with weight = their m². Find the subset that MAXIMISES freehold m² used (⇒ minimises
// stranded quota). Unit counts per building are small (tens–hundreds) and sizes are integers-ish, so a
// bounded DP over an integer-scaled capacity is exact and fast; we cap the DP and fall back to a greedy
// pass if a building is unusually large, so this never blocks a request.
//
// TWO USES: (1) ADVISORY — "these N units pack 118 of your 120 m²; 2 m² stranded". (2) BLOCKING
// EXPERIMENT — the developer reserves the suggested set for foreign (blocks them for #company-shop /
// #phase-pricing planning) and sees stranded m² vs alternatives. This module returns the plan; the
// developer applies it via the block controls.

import type { Unit } from "./catalog-client";
import { unitSqm } from "./freehold";
import { isOffMarket } from "./offmarket";

export type PackPlan = {
  /** Remaining foreign quota m² this plan packs into (the bin capacity). */
  capacitySqm: number;
  /** Unit ids selected to fill the foreign bucket (the recommended freehold set). */
  unitIds: string[];
  /** m² the selected set uses (≤ capacity). */
  usedSqm: number;
  /** m² left unfillable after the best packing (capacity − used) — the irreducible stranded quota. */
  strandedSqm: number;
  /** How many candidate units were considered. */
  candidateCount: number;
  /** True if we fell back to a greedy pass (very large building) instead of exact DP. */
  approximate: boolean;
};

/** Scale factor to turn fractional m² into integers for the DP (0.1 m² resolution is plenty). */
const SCALE = 10;
/** Cap on the DP table size (capacity units × items). Beyond this we go greedy to stay fast. */
const DP_CELL_BUDGET = 4_000_000;

/**
 * A unit is a packing CANDIDATE if it's genuinely available to be sold as freehold: on-market (not
 * blocked/killed) and, when a live status is provided, on-chain OPEN/unstamped (0 or -1). Pass `status`
 * (unitId → on-chain code) to exclude units already held/booked/sold; omit it to consider all on-market
 * units (advisory-only, e.g. before statuses load).
 */
export function packingCandidates(units: Unit[], status?: Record<string, number>): Unit[] {
  return units.filter((u) => {
    if (isOffMarket(u)) return false;
    if (status) {
      const s = status[u.id];
      if (s !== undefined && s !== 0 && s !== -1) return false;
    }
    return unitSqm(u) > 0;
  });
}

/**
 * Best packing of the available units into the remaining foreign quota (0/1 knapsack maximising m² used).
 * Exact DP when the table fits the budget; greedy (largest-first) fallback otherwise. Returns the plan.
 */
export function packForeignQuota(
  units: Unit[],
  remainingForeignSqm: number,
  status?: Record<string, number>
): PackPlan {
  const candidates = packingCandidates(units, status);
  const cap = Math.max(0, Math.floor(remainingForeignSqm * SCALE));

  if (cap === 0 || candidates.length === 0) {
    return {
      capacitySqm: Math.max(0, remainingForeignSqm),
      unitIds: [],
      usedSqm: 0,
      strandedSqm: Math.max(0, remainingForeignSqm),
      candidateCount: candidates.length,
      approximate: false,
    };
  }

  const weights = candidates.map((u) => Math.max(1, Math.round(unitSqm(u) * SCALE)));

  // Greedy fallback for very large problems (keeps the request snappy). Largest-first tends to pack
  // dense; it's an advisory tool, so a near-optimal set is fine at extreme sizes.
  if (cap * candidates.length > DP_CELL_BUDGET) {
    const order = candidates
      .map((u, i) => ({ u, w: weights[i] }))
      .sort((a, b) => b.w - a.w);
    let used = 0;
    const picked: string[] = [];
    for (const { u, w } of order) {
      if (used + w <= cap) {
        used += w;
        picked.push(u.id);
      }
    }
    return {
      capacitySqm: remainingForeignSqm,
      unitIds: picked,
      usedSqm: used / SCALE,
      strandedSqm: (cap - used) / SCALE,
      candidateCount: candidates.length,
      approximate: true,
    };
  }

  // Exact 0/1 knapsack maximising total weight used (value = weight → maximise m² filled). 1-D DP over
  // capacity, tracking the chosen set via a per-cell parent for reconstruction.
  const n = candidates.length;
  // best[c] = max m²-scaled fillable using capacity c; keep[i][c] = whether item i was taken at (i,c).
  const best = new Int32Array(cap + 1);
  const keep: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    const row = new Uint8Array(cap + 1);
    // iterate capacity downward so each item is used at most once (0/1)
    for (let c = cap; c >= w; c--) {
      const cand = best[c - w] + w;
      if (cand > best[c]) {
        best[c] = cand;
        row[c] = 1;
      }
    }
    keep.push(row);
  }

  // Reconstruct the chosen set from keep[][].
  let c = cap;
  const picked: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (keep[i][c]) {
      picked.push(candidates[i].id);
      c -= weights[i];
    }
  }
  picked.reverse();

  const used = best[cap];
  return {
    capacitySqm: remainingForeignSqm,
    unitIds: picked,
    usedSqm: used / SCALE,
    strandedSqm: (cap - used) / SCALE,
    candidateCount: candidates.length,
    approximate: false,
  };
}
