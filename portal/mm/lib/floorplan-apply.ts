// Floor-plan apply — wire the subdivision engine's output INTO the geo tree (the design docs
// step 2). The engine (subdivide.ts) works in METRES and is pure geometry; this step maps its unit cells
// into pack.geo[] as first-class UNIT nodes under a FLOOR node, so the EXISTING projections pick them up for
// free: matrix.ts (the stacking grid / matrix.csv), preview, pricelist and brochure all read pack.geo[] and
// the unit rows — nothing is authored twice.
//
// THE MAPPING: the engine returns cells in absolute plate metres + the plate bbox. A geo node stores its
// footprint as a FRACTION (0..1) of its PARENT. So each cell's metre rect → a fraction of the plate; we also
// set the floor node's METRE ANCHOR (metreW/metreH = the plate size) so deriveSqm resolves real m² for the
// grid. Unit nodes are rects (the engine emits rectangular cells) built via makeNode (valid-by-construction,
// clamped inside the floor). Idempotent per call: REPLACES the floor's existing unit children.
//
// PURE over the Pack (returns a new Pack; never mutates in place) — same house style as useGeo's writeGeo.

import type { Pack, GeoNode } from "./pack";
import { makeNode, nodeById } from "./geo";
import type { SubdivideResult } from "./subdivide";

export interface ApplyFloorPlanResult {
  pack: Pack;
  floorId: string;
  unitNodeIds: string[];
}

/**
 * Write a subdivision result into `pack.geo[]` as unit nodes under `floorNodeId`. Sets the floor's metre anchor
 * to the plate size so the units' derived m² is real. Replaces any existing unit children of that floor
 * (idempotent re-apply). Returns a NEW pack + the created unit node ids. If the floor node is missing, returns
 * the pack unchanged (fail-soft).
 */
export function applyFloorPlan(pack: Pack, floorNodeId: string, result: SubdivideResult): ApplyFloorPlanResult {
  const floor = nodeById(pack, floorNodeId);
  if (!floor || floor.kind !== "floor") {
    return { pack, floorId: floorNodeId, unitNodeIds: [] };
  }

  const plate = result.plate;
  if (!(plate.w > 0) || !(plate.h > 0)) {
    return { pack, floorId: floorNodeId, unitNodeIds: [] };
  }

  const geo: GeoNode[] = pack.geo || [];
  // drop the floor's existing unit children (re-apply is idempotent); keep everything else.
  const kept = geo.filter((n) => !(n.parentId === floorNodeId && n.kind === "unit"));
  const existingIds = new Set(kept.map((n) => n.id));

  // set the floor's metre anchor to the plate size (so derived m² is real for the grid/pricelist).
  const keptWithAnchor = kept.map((n) =>
    n.id === floorNodeId ? { ...n, metreW: round(plate.w), metreH: round(plate.h) } : n
  );

  const newUnits: GeoNode[] = [];
  for (const cell of result.units) {
    // cell metre rect → fraction of the plate
    const minX = Math.min(...cell.poly.map((p) => p.x));
    const minY = Math.min(...cell.poly.map((p) => p.y));
    const maxX = Math.max(...cell.poly.map((p) => p.x));
    const maxY = Math.max(...cell.poly.map((p) => p.y));
    const rect = {
      x: (minX - plate.x) / plate.w,
      y: (minY - plate.y) / plate.h,
      w: (maxX - minX) / plate.w,
      h: (maxY - minY) / plate.h,
    };
    const name = unitName(cell, newUnits.length + 1);
    const node = makeNode("unit", floorNodeId, { name, rect }, existingIds);
    // carry the engine's true area + the type/variation hints (so the matrix/pricelist can label them).
    node.sqm = round(cell.sqm);
    existingIds.add(node.id);
    newUnits.push(node);
  }

  return {
    pack: { ...pack, geo: [...keptWithAnchor, ...newUnits] },
    floorId: floorNodeId,
    unitNodeIds: newUnits.map((n) => n.id),
  };
}

/** A human-ish unit label from the cell's type/variation (e.g. "1BR a") or a positional fallback. */
function unitName(cell: SubdivideResult["units"][number], ordinal: number): string {
  const t = (cell.typeKey || "").trim();
  const v = (cell.variationKey || "").trim();
  if (t && v) return `${t.toUpperCase()} ${v}`;
  if (t) return t.toUpperCase();
  return cell.id || `Unit ${ordinal}`;
}

const round = (n: number) => Math.round(n * 1e3) / 1e3;
