// Floor invariant — the LIVE Σ(unit areas) + walkway = floor-area check the new shell's generation form shows as
// you type (the design docs,: walkway is DERIVED, never typed). PURE + tiny so the form's
// core logic is unit-testable without rendering.

export interface FloorInvariant {
  floorAreaM2: number;    // the floor plate area
  unitsAreaM2: number;    // Σ(unit target areas)
  walkwayM2: number;      // DERIVED = floor − units (clamped at 0)
  walkwayPct: number;     // walkway as a % of the floor (0..100)
  fits: boolean;          // units fit the plate with a sane corridor (>= minWalkwayPct left over)
  over: boolean;          // units OVERFLOW the plate (unitsArea > floorArea)
}

/**
 * Compute the live invariant for a floor: given the floor area and the per-unit target areas, derive the
 * walkway and whether it's sane. `minWalkwayPct` (default 8%) is the floor a real double-/single-loaded corridor
 * needs — below it, the form warns the plate is too tight. PURE.
 */
export function floorInvariant(
  floorAreaM2: number,
  unitAreasM2: number[],
  minWalkwayPct = 8,
): FloorInvariant {
  const floor = Math.max(0, floorAreaM2);
  const units = unitAreasM2.reduce((a, n) => a + Math.max(0, n), 0);
  const walkway = Math.max(0, floor - units);
  const walkwayPct = floor > 0 ? (walkway / floor) * 100 : 0;
  const over = units > floor;
  const fits = !over && walkwayPct >= minWalkwayPct;
  return {
    floorAreaM2: round(floor),
    unitsAreaM2: round(units),
    walkwayM2: round(walkway),
    walkwayPct: round(walkwayPct),
    fits,
    over,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
