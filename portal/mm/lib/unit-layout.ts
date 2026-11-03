// To-scale unit layout — lay a floor's units at their REAL m² size inside a sensibly-sized plate,
// instead of the dumb even grid that made every unit fill a third of the frame (and derive an absurd 731 m²).
//
// THE RULE set: a unit's SIZE is its declared m² — it does NOT change with how big the plate/land is drawn.
// So this module (a) sizes the PLATE from the units it must hold (not from an oversized traced land), and (b) lays
// the units to scale via the EXISTING subdivision engine (subdivide.ts + floorplan-apply.ts), which already
// tessellates cells proportional to target m² with a derived corridor. We only add the two missing pieces:
//   1. seeds FROM a floor's existing unit nodes (carry their declared sqm + type/subtype), and
//   2. a realistic plate size + IDENTITY preservation (the engine makes fresh nodes; we copy back subtypeRef/
//      price/status/name/caption so prices and links survive).
//
// PURE over the Pack (returns a new Pack). "User will fix units manually after" — this is a best-effort
// starting layout, not surveyed architecture.

import type { Pack, GeoNode } from "./pack";
import { unitSqm as declaredUnitSqm } from "./pack";
import { childrenOf, nodeById, subtypeForNode } from "./geo";
import type { DoorSeed } from "./subdivide";
import { subdivideFloor } from "./subdivide";
import { applyFloorPlan } from "./floorplan-apply";

/** The share of the plate that is SELLABLE units; the rest (corridor + core/structure) is circulation. A real
 *  residential floor is ~65–75% efficient. We size the plate so the units occupy ~this fraction → the plate reads
 *  full, not sparse, and the corridor has somewhere to go. */
const SELLABLE_RATIO = 0.7;
/** Default corridor width in metres (: ~1.8 m, adjustable on the floor). */
export const DEFAULT_CORRIDOR_M = 1.8;

/** The declared area of a placed unit node — the subtype's locked size if bound, else the node's own sqm (the
 *  same authored truth deriveSqm now returns for a unit). 0 when nothing is declared (a bare hand-drawn box). PURE. */
export function declaredSqmOfNode(pack: Pack, node: GeoNode): number {
  const sub = subtypeForNode(pack, node);
  if (sub?.sqm != null && sub.sqm > 0) return sub.sqm;
  if (node.sqm != null && node.sqm > 0) return node.sqm;
  return 0;
}

/** A realistic PLATE size (metres) for a floor, derived from the units it must hold — NOT the oversized inherited
 * land anchor (: "set the floor/plate size to be correct"). plateSqm = Σ declared unit m² / SELLABLE_RATIO;
 *  the plate's aspect follows `aspect` (w/h, default ~1.3 — a slightly wide plate) so it isn't an awkward square.
 *  Returns {w,h} in metres, or undefined if the floor has no units with a declared size. PURE. */
export function realisticPlate(pack: Pack, floorId: string, aspect = 1.3): { w: number; h: number } | undefined {
  const units = childrenOf(pack, floorId).filter((n) => n.kind === "unit");
  const totalUnitSqm = units.reduce((a, u) => a + declaredSqmOfNode(pack, u), 0);
  if (!(totalUnitSqm > 0)) return undefined;
  const plateSqm = totalUnitSqm / SELLABLE_RATIO;
  // plateSqm = w*h, w/h = aspect → h = √(plateSqm/aspect), w = aspect*h
  const h = Math.sqrt(plateSqm / aspect);
  const w = aspect * h;
  return { w: round(w), h: round(h) };
}

/** Build subdivision DOOR SEEDS from a floor's existing unit nodes. Each seed carries the unit's DECLARED
 *  m² as its target area (so the engine sizes the cell to the real size) + its type/subtype keys + the node id (so
 *  we can match the engine's cell back to the original node and preserve its identity). Pins are spread along the
 *  plate's long axis in the units' current left→right order (a stable, deterministic seed). PURE. */
export function seedsFromFloorUnits(pack: Pack, floorId: string, plateW: number, plateH: number): DoorSeed[] {
  const units = childrenOf(pack, floorId).filter((n) => n.kind === "unit");
  // keep the author's left→right, top→bottom reading order (by current footprint x then y)
  const ordered = units.slice().sort((a, b) => {
    const ra = a.footprint?.shape === "rect" ? a.footprint.rect : { x: 0, y: 0 };
    const rb = b.footprint?.shape === "rect" ? b.footprint.rect : { x: 0, y: 0 };
    return ra.y - rb.y || ra.x - rb.x;
  });
  const horizontal = plateW >= plateH;
  const axisLen = horizontal ? plateW : plateH;
  const n = ordered.length;
  return ordered.map((u, i) => {
    // spread pins evenly along the corridor (long) axis; cross position at mid-plate (engine decides loading)
    const along = ((i + 0.5) / n) * axisLen;
    const pin = horizontal ? { x: along, y: plateH / 2 } : { x: plateW / 2, y: along };
    return {
      pin,
      targetSqm: declaredSqmOfNode(pack, u) || undefined,
      typeKey: u.subtypeRef?.typeKey,
      variationKey: u.subtypeRef?.subtypeKey,
      id: u.id, // the ORIGINAL node id — used to carry identity back after subdivision
    };
  });
}

/** Lay a floor's units to scale: size a realistic plate from the units, subdivide it into tessellating cells
 *  (proportional to each unit's declared m²) with a corridor, write the cells as the floor's units, and PRESERVE
 *  each original unit's identity (subtypeRef/price/status/name) by matching the engine's cell back via the seed id.
 *  Returns a NEW pack. A no-op (same pack) if the floor has no units with a declared size. PURE. */
export function layUnitsToScale(pack: Pack, floorId: string, corridorWidthM = DEFAULT_CORRIDOR_M): Pack {
  const floor = nodeById(pack, floorId);
  if (floor?.kind !== "floor") return pack;
  const plate = realisticPlate(pack, floorId);
  if (!plate) return pack;

  // snapshot the originals BY id so we can copy identity back onto the new nodes.
  const originals = new Map(
    childrenOf(pack, floorId).filter((n) => n.kind === "unit").map((n) => [n.id, n] as const)
  );

  const floorPoly = [
    { x: 0, y: 0 },
    { x: plate.w, y: 0 },
    { x: plate.w, y: plate.h },
    { x: 0, y: plate.h },
  ];
  const seeds = seedsFromFloorUnits(pack, floorId, plate.w, plate.h);
  const result = subdivideFloor({ floorPoly, seeds, corridorWidthM });
  // applyFloorPlan writes the cells as fresh unit nodes + sets the floor's metre anchor to the (now realistic) plate.
  const applied = applyFloorPlan(pack, floorId, result);

  // carry identity: each engine cell echoes its seed `id` on cell.id → the applied unit node name may differ, but
  // we matched order. Re-walk the new unit nodes in cell order and copy the original's identity fields.
  const newUnitIds = applied.unitNodeIds;
  const geo = (applied.pack.geo || []).map((n) => {
    const idx = newUnitIds.indexOf(n.id);
    if (idx < 0) return n;
    const cell = result.units[idx];
    const orig = cell?.id ? originals.get(cell.id) : undefined;
    if (!orig) return n;
    // keep the new footprint + the engine's real sqm; restore the authored identity INCLUDING the original id (so
    // media slots / the matrix / selection that reference this unit still resolve — applyFloorPlan dropped the
    // originals so their ids are free to reclaim). Match is by cell.id = the seed id = the original node id.
    return {
      ...n,
      id: orig.id,
      name: orig.name,
      status: orig.status,
      price: orig.price,
      subtypeRef: orig.subtypeRef,
      sqm: declaredSqmOfNode(pack, orig) || n.sqm, // the declared size is the truth deriveSqm reads
    };
  });
  return { ...applied.pack, geo };
}

const round = (n: number) => Math.round(n * 1e3) / 1e3;
