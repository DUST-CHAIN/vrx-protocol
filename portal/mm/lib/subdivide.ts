// Floor subdivision engine — the PURE core of the floor-plan layer (the design docs).
//
// THE PROBLEM: the AI generator laid units on a dumb even grid — no real footprints, no corridor,
// units don't tessellate the plate. A prompt-image is a dead-end picture; a real SVG plan is the single source
// of truth the matrix/pricelist/brochure/per-unit view all read. So: a DETERMINISTIC subdivision engine (the
// known "slicing floorplan" approach — NOT ML, NOT prompt-images, NOT a reinvention).
//
// THE SEED (the insight): the single hardest constraint is "every unit touches the corridor at its entrance
// door". Encode it by a DOOR PIN per unit — the pins ARE the subdivision seeds; the corridor is the connective
// spine between them. Three input modes (AI / sliders / door-pins) all feed THIS one engine; they differ only
// in how the seeds are supplied. This file is mode-agnostic: it takes the resolved seeds + corridor width.
//
// WALKWAY = DERIVED (LOCKED): corridor/circulation area = floor − Σ(unit areas). The caller never
// types a walkway number; this engine lays the corridor at `corridorWidthM` and the units fill the rest, so the
// residual is ~0 by construction and surfaced as the invariant check.
//
// ALGORITHM — SLAB-AND-SLICE (illustration-grade, deterministic):
//   1. Work on the floor polygon's BOUNDING BOX (a plate in metres). Non-rect plates are handled at bbox level
//      — honest boundary: these are DEMO/MARKETING plans, not surveyed architecture (same posture as the
//      furniture seeder + the polygon editor).
//   2. Lay the CORRIDOR as a band of `corridorWidthM` along the plate's LONG axis, centred (double-loaded) when
//      pins sit on both sides, or along one edge (single-loaded) when they cluster on one side.
//   3. Partition the remaining band(s) into one cell per seed, ordered by each pin's position ALONG the corridor
//      axis, each cell's WIDTH proportional to its unit's target m² (Σ widths = band length → tessellation).
//   4. Each cell's DOOR sits on the corridor edge nearest its pin → reachability is guaranteed by construction.
//
// PURE (metres in, metres out) + geometry-only — no geo-tree, no fractions, no browser. Step 2 (separate) wires
// the output back into pack.geo[] via makeNode. Testable with a fixed plate + fixed pins.

import { type Pt, shoelaceArea } from "./geo";

/** A door-pin seed: where a unit's entrance is + what it should be. Position in METRES on the floor plate. */
export interface DoorSeed {
  pin: Pt;                 // the entrance-door position (metres, within the floor plate)
  targetSqm?: number;      // desired unit area; absent → an equal share of the band
  typeKey?: string;        // studio|1br|2br … (carried through for the geo node / media slot)
  variationKey?: string;   // a|b|c … the layout variation
  id?: string;             // optional caller id, echoed on the result cell
}

export interface SubdivideInput {
  /** The floor polygon in METRES (any closed ring; the engine uses its bounding box as the plate). */
  floorPoly: Pt[];
  /** The entrance-door seeds — one per unit. */
  seeds: DoorSeed[];
  /** The circulation spine width in metres (slider/default). Walkway AREA is derived, not set. */
  corridorWidthM: number;
}

/** One resulting unit cell: a rectangular footprint (metres) + its door on the corridor + its area. */
export interface UnitCell {
  id?: string;
  typeKey?: string;
  variationKey?: string;
  poly: Pt[];              // the unit's rectangular footprint, CW from top-left, in metres
  sqm: number;             // true area (shoelace)
  doorAt: Pt;              // the door point ON the corridor edge
}

export interface SubdivideResult {
  units: UnitCell[];
  corridor: Pt[];          // the circulation polygon (metres)
  /** the working PLATE (the floor polygon's bounding box, metres) — the frame the apply step maps cells into. */
  plate: { x: number; y: number; w: number; h: number };
  floorSqm: number;        // plate area used (bbox)
  unitsSqm: number;        // Σ unit areas
  corridorSqm: number;     // derived walkway area
  residualSqm: number;     // floorSqm − unitsSqm − corridorSqm (≈ 0 by construction)
  reachable: boolean;      // every unit's door lies on the corridor
}

/** Axis-aligned bounding box of a point ring. */
function bbox(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** A rectangle (x,y,w,h in metres) → a CW point ring (top-left, top-right, bottom-right, bottom-left). */
function rectRing(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

const r3 = (n: number) => Math.round(n * 1e3) / 1e3;

/**
 * Subdivide a floor plate into tessellating unit cells seeded by door pins, with a derived corridor.
 * Deterministic + pure. Guarantees: Σ(units)+corridor ≈ floor (residual ≈ 0); every unit door lies on the
 * corridor (reachable). Illustration-grade (bbox plate; rectangular cells) — demo/marketing, not surveyed.
 */
export function subdivideFloor(input: SubdivideInput): SubdivideResult {
  const plate = bbox(input.floorPoly);
  const floorSqm = shoelaceArea(input.floorPoly);
  const seeds = input.seeds.slice();

  // Degenerate: no seeds → the whole plate is "corridor" (nothing to place).
  if (seeds.length === 0) {
    const corridor = rectRing(plate.x, plate.y, plate.w, plate.h);
    return {
      units: [], corridor, plate, floorSqm,
      unitsSqm: 0, corridorSqm: floorSqm, residualSqm: r3(floorSqm - shoelaceArea(corridor)),
      reachable: true,
    };
  }

  // The LONG axis is the corridor direction (units slice ACROSS it). "horizontal" = corridor runs left↔right
  // (a horizontal band), units stacked above/below; "vertical" = corridor runs top↔bottom, units left/right.
  const horizontal = plate.w >= plate.h;
  const axisLen = horizontal ? plate.w : plate.h;      // along the corridor
  const crossLen = horizontal ? plate.h : plate.w;     // across (depth available for units + corridor)

  // Corridor width clamped so it never eats the whole plate (leave >=40% cross-depth for units).
  const corridorW = Math.max(0.5, Math.min(input.corridorWidthM, crossLen * 0.6));

  // Decide single- vs double-loaded from where the pins sit across the plate. Project each pin onto the CROSS
  // axis (0..crossLen); if pins cluster on ONE half → single-loaded (corridor on the far edge, units one side),
  // else double-loaded (corridor centred, units both sides).
  const crossOf = (p: Pt) => (horizontal ? p.y - plate.y : p.x - plate.x);
  const nearSide = seeds.filter((s) => crossOf(s.pin) < crossLen / 2).length;
  const farSide = seeds.length - nearSide;
  const doubleLoaded = nearSide > 0 && farSide > 0;

  // Corridor band position (cross-axis offset + the two unit bands' cross extents).
  let corridorCross: number;        // cross-offset of the corridor band's near edge
  const bands: { crossStart: number; crossDepth: number; doorCross: number; seeds: DoorSeed[] }[] = [];
  if (doubleLoaded) {
    corridorCross = (crossLen - corridorW) / 2;
    const topDepth = corridorCross;                 // near band depth
    const botStart = corridorCross + corridorW;
    const botDepth = crossLen - botStart;           // far band depth
    bands.push({ crossStart: 0, crossDepth: topDepth, doorCross: corridorCross, seeds: seeds.filter((s) => crossOf(s.pin) < crossLen / 2) });
    bands.push({ crossStart: botStart, crossDepth: botDepth, doorCross: botStart, seeds: seeds.filter((s) => crossOf(s.pin) >= crossLen / 2) });
  } else {
    // single-loaded: corridor hugs the side the pins are FARTHEST from, units fill the rest.
    const pinsNear = nearSide >= farSide; // pins on the near half → corridor on the near edge
    corridorCross = pinsNear ? 0 : crossLen - corridorW;
    const unitStart = pinsNear ? corridorW : 0;
    const unitDepth = crossLen - corridorW;
    const doorCross = pinsNear ? corridorW : crossLen - corridorW; // the corridor edge the doors sit on
    bands.push({ crossStart: unitStart, crossDepth: unitDepth, doorCross, seeds: seeds.slice() });
  }

  const corridorCrossStart = corridorCross;

  // Slice each band along the AXIS into one cell per seed, ordered by the pin's axis position, width ∝ target m².
  const axisOf = (p: Pt) => (horizontal ? p.x - plate.x : p.y - plate.y);
  const units: UnitCell[] = [];

  for (const band of bands) {
    if (band.seeds.length === 0 || band.crossDepth <= 0) continue;
    const ordered = band.seeds.slice().sort((a, b) => axisOf(a.pin) - axisOf(b.pin));
    // weights from target m² (fall back to equal shares); normalise to the axis length.
    const weights = ordered.map((s) => (s.targetSqm && s.targetSqm > 0 ? s.targetSqm : 0));
    const totalW = weights.reduce((a, b) => a + b, 0);
    const widths = totalW > 0
      ? weights.map((w) => (w / totalW) * axisLen)
      : ordered.map(() => axisLen / ordered.length);

    let cursor = 0; // axis offset within the plate
    ordered.forEach((seed, i) => {
      const wAxis = widths[i];
      // cell rect in plate-local coords, then shift to world (plate.x/plate.y).
      const cell = horizontal
        ? { x: plate.x + cursor, y: plate.y + band.crossStart, w: wAxis, h: band.crossDepth }
        : { x: plate.x + band.crossStart, y: plate.y + cursor, w: band.crossDepth, h: wAxis };
      const ring = rectRing(cell.x, cell.y, cell.w, cell.h);
      // door at the cell's mid-axis, on the corridor edge of the band.
      const doorAxis = cursor + wAxis / 2;
      const doorAt: Pt = horizontal
        ? { x: r3(plate.x + doorAxis), y: r3(plate.y + band.doorCross) }
        : { x: r3(plate.x + band.doorCross), y: r3(plate.y + doorAxis) };
      units.push({
        id: seed.id,
        typeKey: seed.typeKey,
        variationKey: seed.variationKey,
        poly: ring.map((p) => ({ x: r3(p.x), y: r3(p.y) })),
        sqm: r3(shoelaceArea(ring)),
        doorAt,
      });
      cursor += wAxis;
    });
  }

  // corridor polygon (the band).
  const corridor = horizontal
    ? rectRing(plate.x, plate.y + corridorCrossStart, plate.w, corridorW)
    : rectRing(plate.x + corridorCrossStart, plate.y, corridorW, plate.h);

  const unitsSqm = r3(units.reduce((a, u) => a + u.sqm, 0));
  const corridorSqm = r3(shoelaceArea(corridor));
  const residualSqm = r3(floorSqm - unitsSqm - corridorSqm);

  // reachable: every door lies ON the corridor band (within a tolerance).
  const reachable = units.every((u) => pointOnRect(u.doorAt, corridorRect(plate, corridorCrossStart, corridorW, horizontal), 0.05));

  return { units, corridor, plate, floorSqm: r3(floorSqm), unitsSqm, corridorSqm, residualSqm, reachable };
}

/** The corridor band as an axis-aligned rect (metres). */
function corridorRect(
  plate: { x: number; y: number; w: number; h: number },
  crossStart: number, corridorW: number, horizontal: boolean,
): { x: number; y: number; w: number; h: number } {
  return horizontal
    ? { x: plate.x, y: plate.y + crossStart, w: plate.w, h: corridorW }
    : { x: plate.x + crossStart, y: plate.y, w: corridorW, h: plate.h };
}

/** Is a point on (within `tol` of) a rect's area? */
function pointOnRect(p: Pt, r: { x: number; y: number; w: number; h: number }, tol: number): boolean {
  return p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
}
